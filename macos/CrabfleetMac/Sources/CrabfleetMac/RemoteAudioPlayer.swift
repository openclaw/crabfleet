import AVFoundation
import Foundation
import RoyalVNCKit

struct RemoteAudioJitterBuffer {
  struct Packet: Equatable {
    let timestampMs: UInt32
    let payload: Data
  }

  enum EnqueueResult: Equatable {
    case buffered
    case ready([Packet])
    case droppedLate
    case resynced
  }

  private let packetDurationMs: UInt32
  private let targetDelayMs: UInt32
  private var packets: [Packet] = []
  private var newestTimestampMs: UInt32?
  private var isPrimed = false

  init(sampleRate: UInt32, targetDelayMs: UInt32 = 100) {
    packetDurationMs = max(1, UInt32((1_024_000.0 / Double(sampleRate)).rounded()))
    self.targetDelayMs = min(max(targetDelayMs, 80), 120)
  }

  mutating func enqueue(_ packet: Packet) -> EnqueueResult {
    if let newestTimestampMs {
      let delta = Int32(bitPattern: packet.timestampMs &- newestTimestampMs)
      guard delta > 0 else { return .droppedLate }
      if delta > 500 {
        reset()
        packets.append(packet)
        self.newestTimestampMs = packet.timestampMs
        return .resynced
      }
    }

    packets.append(packet)
    newestTimestampMs = packet.timestampMs
    if !isPrimed {
      guard let first = packets.first else { return .buffered }
      let span = packet.timestampMs &- first.timestampMs &+ packetDurationMs
      guard span >= targetDelayMs else { return .buffered }
      isPrimed = true
    }

    let ready = packets
    packets.removeAll(keepingCapacity: true)
    return .ready(ready)
  }

  mutating func reset() {
    packets.removeAll(keepingCapacity: true)
    newestTimestampMs = nil
    isPrimed = false
  }
}

final class RemoteAudioPlayer: @unchecked Sendable {
  private struct Configuration: Equatable {
    let channels: UInt8
    let sampleRate: UInt32
    let magicCookie: Data
  }

  private let queue = DispatchQueue(label: "org.openclaw.crabfleet.remote-audio")
  private let inputLock = NSLock()
  private let engine = AVAudioEngine()
  private let player = AVAudioPlayerNode()
  private var engineConfigurationObserver: NSObjectProtocol?
  private var pendingMessages: [VNCAudioMessage] = []
  private var isDrainingMessages = false
  private var configuration: Configuration?
  private var converter: AVAudioConverter?
  private var compressedFormat: AVAudioFormat?
  private var pcmFormat: AVAudioFormat?
  private var jitterBuffer: RemoteAudioJitterBuffer?
  private var isMuted = true
  private var scheduledFrames: AVAudioFrameCount = 0
  private var playbackGeneration: UInt64 = 0
  private var isEngineGraphDirty = false

  init() {
    engine.attach(player)
    engineConfigurationObserver = NotificationCenter.default.addObserver(
      forName: .AVAudioEngineConfigurationChange,
      object: engine,
      queue: nil
    ) { [weak self] _ in
      self?.queue.async { [weak self] in self?.isEngineGraphDirty = true }
    }
  }

  func receive(_ message: VNCAudioMessage) {
    inputLock.lock()
    switch message {
    case .config, .stop:
      pendingMessages.removeAll(keepingCapacity: true)
    case .packet:
      if pendingMessages.count >= 12 {
        guard let index = pendingMessages.firstIndex(where: {
          if case .packet = $0 { return true }
          return false
        }) else {
          inputLock.unlock()
          return
        }
        pendingMessages.remove(at: index)
      }
    }
    pendingMessages.append(message)
    guard !isDrainingMessages else {
      inputLock.unlock()
      return
    }
    isDrainingMessages = true
    inputLock.unlock()
    queue.async { [weak self] in self?.drainMessages() }
  }

  func setMuted(_ muted: Bool) {
    queue.async { [weak self] in
      self?.isMuted = muted
      self?.player.volume = muted ? 0 : 1
    }
  }

  func stop() {
    receive(.stop)
  }

  private func drainMessages() {
    while true {
      inputLock.lock()
      guard !pendingMessages.isEmpty else {
        isDrainingMessages = false
        inputLock.unlock()
        return
      }
      let message = pendingMessages.removeFirst()
      inputLock.unlock()
      handle(message)
    }
  }

  private func handle(_ message: VNCAudioMessage) {
    switch message {
    case .config(let channels, let sampleRate, let magicCookie):
      configure(Configuration(
        channels: channels,
        sampleRate: sampleRate,
        magicCookie: magicCookie))
    case .packet(let timestampMs, let payload):
      guard var jitterBuffer else { return }
      let result = jitterBuffer.enqueue(.init(timestampMs: timestampMs, payload: payload))
      self.jitterBuffer = jitterBuffer
      switch result {
      case .ready(let packets):
        packets.forEach(decodeAndSchedule)
      case .resynced:
        resetPlaybackQueue()
        _ = rebuildDecoder()
      case .buffered, .droppedLate:
        break
      }
    case .stop:
      stopNow()
    }
  }

  private func configure(_ configuration: Configuration) {
    stopNow()

    guard let compressedFormat = AVAudioFormat(settings: [
      AVFormatIDKey: Int(kAudioFormatMPEG4AAC),
      AVSampleRateKey: Double(configuration.sampleRate),
      AVNumberOfChannelsKey: Int(configuration.channels),
    ]),
      let pcmFormat = AVAudioFormat(
        standardFormatWithSampleRate: Double(configuration.sampleRate),
        channels: AVAudioChannelCount(configuration.channels))
    else { return }

    self.configuration = configuration
    self.compressedFormat = compressedFormat
    self.pcmFormat = pcmFormat
    guard rebuildDecoder(), restartEngine() else {
      stopNow()
      return
    }
    player.volume = isMuted ? 0 : 1
    jitterBuffer = RemoteAudioJitterBuffer(sampleRate: configuration.sampleRate)
  }

  private func decodeAndSchedule(_ packet: RemoteAudioJitterBuffer.Packet) {
    guard let converter, let compressedFormat else { return }
    let compressed = AVAudioCompressedBuffer(
      format: compressedFormat,
      packetCapacity: 1,
      maximumPacketSize: packet.payload.count)
    packet.payload.withUnsafeBytes { bytes in
      guard let source = bytes.baseAddress else { return }
      memcpy(compressed.data, source, bytes.count)
    }
    compressed.byteLength = UInt32(packet.payload.count)
    compressed.packetCount = 1
    if let packetDescriptions = compressed.packetDescriptions {
      packetDescriptions[0] = AudioStreamPacketDescription(
        mStartOffset: 0,
        mVariableFramesInPacket: 1_024,
        mDataByteSize: UInt32(packet.payload.count))
    }

    guard let pcm = AVAudioPCMBuffer(
      pcmFormat: converter.outputFormat,
      frameCapacity: 1_024)
    else { return }
    var suppliedInput = false
    var conversionError: NSError?
    let result = converter.convert(to: pcm, error: &conversionError) { _, inputStatus in
      guard !suppliedInput else {
        inputStatus.pointee = .noDataNow
        return nil
      }
      suppliedInput = true
      inputStatus.pointee = .haveData
      return compressed
    }
    guard conversionError == nil, result != .error, pcm.frameLength > 0 else { return }
    guard ensureEngineRunning() else { return }
    let maximumFrames = AVAudioFrameCount(converter.outputFormat.sampleRate * 0.12)
    guard scheduledFrames + pcm.frameLength <= maximumFrames else { return }
    scheduledFrames += pcm.frameLength
    let generation = playbackGeneration
    let frameLength = pcm.frameLength
    player.scheduleBuffer(pcm, completionCallbackType: .dataPlayedBack) { [weak self] _ in
      self?.queue.async { [weak self] in
        guard let self, playbackGeneration == generation else { return }
        scheduledFrames = scheduledFrames >= frameLength ? scheduledFrames - frameLength : 0
      }
    }
    if !player.isPlaying {
      player.play()
    }
  }

  private func rebuildDecoder() -> Bool {
    guard let configuration, let compressedFormat, let pcmFormat,
      let converter = AVAudioConverter(from: compressedFormat, to: pcmFormat)
    else {
      self.converter = nil
      return false
    }
    if !configuration.magicCookie.isEmpty {
      converter.magicCookie = configuration.magicCookie
    }
    self.converter = converter
    return true
  }

  private func ensureEngineRunning() -> Bool {
    (!isEngineGraphDirty && engine.isRunning) || restartEngine()
  }

  private func restartEngine() -> Bool {
    guard let pcmFormat else { return false }
    resetPlaybackQueue()
    engine.stop()
    engine.disconnectNodeOutput(player)
    engine.connect(player, to: engine.mainMixerNode, format: pcmFormat)
    do {
      try engine.start()
      isEngineGraphDirty = false
      player.volume = isMuted ? 0 : 1
      return true
    } catch {
      return false
    }
  }

  private func resetPlaybackQueue() {
    playbackGeneration &+= 1
    scheduledFrames = 0
    player.stop()
  }

  private func stopNow() {
    resetPlaybackQueue()
    engine.stop()
    jitterBuffer?.reset()
    jitterBuffer = nil
    converter = nil
    compressedFormat = nil
    pcmFormat = nil
    configuration = nil
  }

  deinit {
    if let engineConfigurationObserver {
      NotificationCenter.default.removeObserver(engineConfigurationObserver)
    }
    player.stop()
    engine.stop()
  }
}
