import AVFoundation
import CoreMedia
import Foundation

struct AudioStreamConfiguration: Equatable, Sendable {
  let channels: UInt8
  let sampleRate: UInt32
  let magicCookie: Data
}

struct EncodedAudioPacket: Sendable {
  let configuration: AudioStreamConfiguration
  let timestampMs: UInt32
  let data: Data
  let createdAt: TimeInterval
}

final class MacAudioEncoder: @unchecked Sendable {
  enum Event: Sendable {
    case config(AudioStreamConfiguration)
    case packet(EncodedAudioPacket)
    case failed(String)
  }

  let events: AsyncStream<Event>

  private let queue = DispatchQueue(label: "org.openclaw.crabfleet.audio-encoder")
  private let inputLock = NSLock()
  private let continuation: AsyncStream<Event>.Continuation
  private var converter: AVAudioConverter?
  private var inputFormatKey: AudioInputFormatKey?
  private var outputFormat: AVAudioFormat?
  private var configuration: AudioStreamConfiguration?
  private var isInvalidated = false
  private var pendingInput: AudioInput?
  private var isDrainingInput = false

  init() {
    let stream = AsyncStream.makeStream(
      of: Event.self,
      bufferingPolicy: .bufferingNewest(11))
    events = stream.stream
    continuation = stream.continuation
  }

  func submit(_ sampleBuffer: CMSampleBuffer) {
    offer(.sampleBuffer(AudioSampleSource(
      sampleBuffer: sampleBuffer,
      createdAt: ProcessInfo.processInfo.systemUptime)))
  }

  func submit(_ pcmBuffer: AVAudioPCMBuffer, presentationTime: CMTime) {
    offer(.pcmBuffer(
      AudioPCMSource(
        buffer: pcmBuffer,
        presentationTime: presentationTime,
        createdAt: ProcessInfo.processInfo.systemUptime)))
  }

  func invalidate() {
    queue.async { [weak self] in
      guard let self, !isInvalidated else { return }
      isInvalidated = true
      self.inputLock.lock()
      self.pendingInput = nil
      self.inputLock.unlock()
      converter = nil
      inputFormatKey = nil
      outputFormat = nil
      configuration = nil
      continuation.finish()
    }
  }

  private func offer(_ input: AudioInput) {
    inputLock.lock()
    pendingInput = input
    guard !isDrainingInput else {
      inputLock.unlock()
      return
    }
    isDrainingInput = true
    inputLock.unlock()
    queue.async { [weak self] in self?.drainInputs() }
  }

  private func drainInputs() {
    while true {
      inputLock.lock()
      guard let input = pendingInput else {
        isDrainingInput = false
        inputLock.unlock()
        return
      }
      pendingInput = nil
      inputLock.unlock()

      guard ProcessInfo.processInfo.systemUptime - input.createdAt <= 0.2 else { continue }
      switch input {
      case .sampleBuffer(let source):
        encode(source.sampleBuffer, createdAt: source.createdAt)
      case .pcmBuffer(let source):
        encode(
          source.buffer,
          presentationTime: source.presentationTime,
          createdAt: source.createdAt)
      }
    }
  }

  private func encode(_ sampleBuffer: CMSampleBuffer, createdAt: TimeInterval) {
    guard sampleBuffer.isValid else { return }
    do {
      let pcmBuffer = try Self.pcmBuffer(from: sampleBuffer)
      encode(
        pcmBuffer,
        presentationTime: sampleBuffer.presentationTimeStamp,
        createdAt: createdAt)
    } catch {
      continuation.yield(.failed(error.localizedDescription))
    }
  }

  private func encode(
    _ pcmBuffer: AVAudioPCMBuffer,
    presentationTime: CMTime,
    createdAt: TimeInterval
  ) {
    guard !isInvalidated, pcmBuffer.frameLength > 0 else { return }
    do {
      if inputFormatKey != AudioInputFormatKey(pcmBuffer.format) {
        try rebuildConverter(inputFormat: pcmBuffer.format)
      }
      guard let converter, let outputFormat, var configuration else {
        throw PrivateMacShareError.protocolError("audio converter is unavailable")
      }

      let packetCapacity = max(1, AVAudioPacketCount((Int(pcmBuffer.frameLength) + 1_023) / 1_024 + 1))
      let compressed = AVAudioCompressedBuffer(
        format: outputFormat,
        packetCapacity: packetCapacity,
        maximumPacketSize: converter.maximumOutputPacketSize)
      var suppliedInput = false
      var conversionError: NSError?
      let conversionStatus = converter.convert(to: compressed, error: &conversionError) {
        _, inputStatus in
        guard !suppliedInput else {
          inputStatus.pointee = .noDataNow
          return nil
        }
        suppliedInput = true
        inputStatus.pointee = .haveData
        return pcmBuffer
      }
      if let conversionError { throw conversionError }
      guard conversionStatus != .error else {
        throw PrivateMacShareError.protocolError("AAC conversion failed")
      }

      let updatedConfiguration = AudioStreamConfiguration(
        channels: configuration.channels,
        sampleRate: configuration.sampleRate,
        magicCookie: converter.magicCookie ?? Data())
      if updatedConfiguration != configuration {
        configuration = updatedConfiguration
        self.configuration = updatedConfiguration
        continuation.yield(.config(updatedConfiguration))
      }

      let packetCount = Int(compressed.packetCount)
      guard packetCount > 0 else { return }
      let baseTimestampMs = Self.timestampMs(presentationTime)
      let packetDescriptions = compressed.packetDescriptions
      let uniformPacketSize = packetDescriptions == nil ? Int(compressed.byteLength) / packetCount : 0
      for index in 0..<packetCount {
        let offset: Int
        let byteCount: Int
        if let packetDescriptions {
          offset = Int(packetDescriptions[index].mStartOffset)
          byteCount = Int(packetDescriptions[index].mDataByteSize)
        } else {
          offset = index * uniformPacketSize
          byteCount = uniformPacketSize
        }
        guard byteCount > 0, byteCount <= RFBWire.maximumAudioPayloadBytes,
          offset >= 0, offset + byteCount <= Int(compressed.byteLength)
        else { continue }
        let timestampOffset = UInt32((Double(index * 1_024) * 1_000 / 48_000).rounded())
        continuation.yield(
          .packet(
            EncodedAudioPacket(
              configuration: configuration,
              timestampMs: baseTimestampMs &+ timestampOffset,
              data: Data(bytes: compressed.data.advanced(by: offset), count: byteCount),
              createdAt: createdAt)))
      }
    } catch {
      continuation.yield(.failed(error.localizedDescription))
    }
  }

  private func rebuildConverter(inputFormat: AVAudioFormat) throws {
    let channels = min(max(inputFormat.channelCount, 1), 2)
    guard
      let outputFormat = AVAudioFormat(settings: [
        AVFormatIDKey: Int(kAudioFormatMPEG4AAC),
        AVSampleRateKey: 48_000.0,
        AVNumberOfChannelsKey: Int(channels),
        AVEncoderBitRateKey: 128_000,
        AVEncoderAudioQualityKey: AVAudioQuality.high.rawValue,
      ]),
      let converter = AVAudioConverter(from: inputFormat, to: outputFormat)
    else {
      throw PrivateMacShareError.protocolError("AAC-LC encoder is unavailable")
    }
    converter.bitRate = 128_000
    let configuration = AudioStreamConfiguration(
      channels: UInt8(channels),
      sampleRate: 48_000,
      magicCookie: converter.magicCookie ?? Data())
    self.converter = converter
    inputFormatKey = AudioInputFormatKey(inputFormat)
    self.outputFormat = outputFormat
    self.configuration = configuration
    continuation.yield(.config(configuration))
  }

  private static func timestampMs(_ time: CMTime) -> UInt32 {
    guard time.isNumeric else { return 0 }
    let milliseconds = max(CMTimeGetSeconds(time) * 1_000, 0)
    return UInt32(truncatingIfNeeded: UInt64(milliseconds.rounded()))
  }

  private static func pcmBuffer(from sampleBuffer: CMSampleBuffer) throws -> AVAudioPCMBuffer {
    guard let description = sampleBuffer.formatDescription,
      let streamDescription = CMAudioFormatDescriptionGetStreamBasicDescription(description),
      let format = AVAudioFormat(streamDescription: streamDescription)
    else {
      throw PrivateMacShareError.protocolError("invalid captured audio format")
    }
    let frameCount = AVAudioFrameCount(sampleBuffer.numSamples)
    guard frameCount > 0,
      let pcmBuffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frameCount)
    else {
      throw PrivateMacShareError.protocolError("invalid captured audio buffer")
    }

    let maximumBuffers = max(Int(format.channelCount), 1)
    let listSize = MemoryLayout<AudioBufferList>.size
      + (maximumBuffers - 1) * MemoryLayout<AudioBuffer>.size
    let storage = UnsafeMutableRawPointer.allocate(
      byteCount: listSize,
      alignment: MemoryLayout<AudioBufferList>.alignment)
    defer { storage.deallocate() }
    let sourceList = storage.bindMemory(to: AudioBufferList.self, capacity: 1)
    sourceList.pointee.mNumberBuffers = UInt32(maximumBuffers)
    var retainedBlockBuffer: CMBlockBuffer?
    let result = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
      sampleBuffer,
      bufferListSizeNeededOut: nil,
      bufferListOut: sourceList,
      bufferListSize: listSize,
      blockBufferAllocator: nil,
      blockBufferMemoryAllocator: nil,
      flags: kCMSampleBufferFlag_AudioBufferList_Assure16ByteAlignment,
      blockBufferOut: &retainedBlockBuffer)
    guard result == noErr else {
      throw PrivateMacShareError.protocolError("could not read captured audio")
    }

    try withExtendedLifetime(retainedBlockBuffer) {
      let sources = UnsafeMutableAudioBufferListPointer(sourceList)
      let destinations = UnsafeMutableAudioBufferListPointer(pcmBuffer.mutableAudioBufferList)
      guard sources.count == destinations.count else {
        throw PrivateMacShareError.protocolError("captured audio channel layout changed")
      }
      for index in sources.indices {
        let source = sources[index]
        let destination = destinations[index]
        guard let sourceData = source.mData, let destinationData = destination.mData,
          source.mDataByteSize <= destination.mDataByteSize
        else {
          throw PrivateMacShareError.protocolError("invalid captured audio storage")
        }
        memcpy(destinationData, sourceData, Int(source.mDataByteSize))
        destinations[index].mDataByteSize = source.mDataByteSize
      }
    }
    pcmBuffer.frameLength = frameCount
    return pcmBuffer
  }
}

private struct AudioSampleSource: @unchecked Sendable {
  let sampleBuffer: CMSampleBuffer
  let createdAt: TimeInterval
}

private struct AudioPCMSource: @unchecked Sendable {
  let buffer: AVAudioPCMBuffer
  let presentationTime: CMTime
  let createdAt: TimeInterval
}

private enum AudioInput: @unchecked Sendable {
  case sampleBuffer(AudioSampleSource)
  case pcmBuffer(AudioPCMSource)

  var createdAt: TimeInterval {
    switch self {
    case .sampleBuffer(let source): source.createdAt
    case .pcmBuffer(let source): source.createdAt
    }
  }
}

private struct AudioInputFormatKey: Equatable {
  let sampleRate: Double
  let formatID: AudioFormatID
  let formatFlags: AudioFormatFlags
  let bytesPerPacket: UInt32
  let framesPerPacket: UInt32
  let bytesPerFrame: UInt32
  let channelsPerFrame: UInt32
  let bitsPerChannel: UInt32

  init(_ format: AVAudioFormat) {
    let value = format.streamDescription.pointee
    sampleRate = value.mSampleRate
    formatID = value.mFormatID
    formatFlags = value.mFormatFlags
    bytesPerPacket = value.mBytesPerPacket
    framesPerPacket = value.mFramesPerPacket
    bytesPerFrame = value.mBytesPerFrame
    channelsPerFrame = value.mChannelsPerFrame
    bitsPerChannel = value.mBitsPerChannel
  }
}
