import AVFoundation
import CoreMedia
import Testing

@testable import CrabfleetMac

struct AudioEncoderTests {
  @Test
  func emitsAACConfigurationBeforeEncodedPackets() async throws {
    let format = try #require(
      AVAudioFormat(standardFormatWithSampleRate: 48_000, channels: 2))
    let buffer = try #require(AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 1_024))
    buffer.frameLength = 1_024
    if let channels = buffer.floatChannelData {
      for channel in 0..<Int(format.channelCount) {
        channels[channel].initialize(repeating: 0, count: 1_024)
      }
    }

    let encoder = MacAudioEncoder()
    var events = encoder.events.makeAsyncIterator()
    encoder.submit(buffer, presentationTime: CMTime(value: 1, timescale: 1))

    let first = await events.next()
    guard case .config(let configuration) = first else {
      Issue.record("encoder did not emit configuration first")
      return
    }
    #expect(configuration.channels == 2)
    #expect(configuration.sampleRate == 48_000)

    encoder.submit(buffer, presentationTime: CMTime(value: 1_024, timescale: 48_000))
    var packet: EncodedAudioPacket?
    var latestConfiguration = configuration
    for _ in 0..<3 {
      switch await events.next() {
      case .packet(let value):
        packet = value
      case .config(let value):
        latestConfiguration = value
        continue
      case .failed(let message):
        Issue.record("encoder failed: \(message)")
        return
      default:
        continue
      }
      break
    }
    let encodedPacket = try #require(packet)
    #expect(!encodedPacket.data.isEmpty)
    #expect(encodedPacket.configuration == latestConfiguration)
    encoder.invalidate()
  }
}

struct RemoteAudioJitterBufferTests {
  @Test
  func primesInsideTargetWindow() {
    var buffer = RemoteAudioJitterBuffer(sampleRate: 48_000, targetDelayMs: 100)
    for timestamp in [0, 21, 42, 63] as [UInt32] {
      #expect(buffer.enqueue(packet(timestamp)) == .buffered)
    }
    #expect(buffer.enqueue(packet(84)) == .ready([
      packet(0), packet(21), packet(42), packet(63), packet(84),
    ]))
    #expect(buffer.enqueue(packet(105)) == .ready([packet(105)]))
  }

  @Test
  func dropsLatePackets() {
    var buffer = RemoteAudioJitterBuffer(sampleRate: 48_000)
    #expect(buffer.enqueue(packet(100)) == .buffered)
    #expect(buffer.enqueue(packet(99)) == .droppedLate)
    #expect(buffer.enqueue(packet(100)) == .droppedLate)
  }

  @Test
  func resyncsAfterLongGap() {
    var buffer = RemoteAudioJitterBuffer(sampleRate: 48_000)
    #expect(buffer.enqueue(packet(100)) == .buffered)
    #expect(buffer.enqueue(packet(700)) == .resynced)
    #expect(buffer.enqueue(packet(721)) == .buffered)
  }

  @Test
  func acceptsTimestampWrap() {
    var buffer = RemoteAudioJitterBuffer(sampleRate: 48_000)
    #expect(buffer.enqueue(packet(UInt32.max - 10)) == .buffered)
    #expect(buffer.enqueue(packet(10)) == .buffered)
  }

  private func packet(_ timestampMs: UInt32) -> RemoteAudioJitterBuffer.Packet {
    .init(timestampMs: timestampMs, payload: Data([UInt8(truncatingIfNeeded: timestampMs)]))
  }
}

struct RemoteAudioPlayerTests {
  @Test
  func muteAppliesWhilePacketsKeepArriving() async {
    let queue = DispatchQueue(label: "org.openclaw.crabfleet.remote-audio-test")
    let queueGate = DispatchSemaphore(value: 0)
    queue.async { queueGate.wait() }
    let node = AVAudioPlayerNode()
    node.volume = 1
    let player = RemoteAudioPlayer(player: node, queue: queue)
    let started = AudioTestSignal()
    let producer = Task {
      var timestampMs: UInt32 = 0
      while !Task.isCancelled {
        player.receive(.packet(timestampMs: timestampMs, payload: Data([0])))
        timestampMs &+= 21
        await started.signal()
        await Task.yield()
      }
    }
    await started.wait()

    player.setMuted(true)
    #expect(node.volume == 0)

    producer.cancel()
    await producer.value
    queueGate.signal()
  }
}

struct AudioSendDeadlineTests {
  @Test
  func queuedExpiredSendNeverStarts() async {
    let waiter = QueuedSendWaiter(deadline: ContinuousClock().now)

    #expect(!waiter.beginSending())
    await #expect(throws: RFBSendExpiredError.self) {
      try await waiter.wait()
    }
  }

  @Test
  func lateSuccessfulSendDoesNotBecomeSessionFailure() async throws {
    let clock = AudioDeadlineTestClock()
    let waiter = QueuedSendWaiter(
      deadline: clock.now.advanced(by: .milliseconds(10)),
      now: { clock.now })

    #expect(waiter.beginSending())
    clock.advance(by: .milliseconds(20))
    waiter.complete(.success(()))

    try await waiter.wait()
  }

  @Test
  func expiryWhileSendIsInFlightIsANonfatalDrop() async {
    let waiter = QueuedSendWaiter(
      deadline: ContinuousClock().now.advanced(by: .seconds(1)))

    #expect(waiter.beginSending())
    waiter.expire()
    await #expect(throws: RFBSendExpiredError.self) {
      try await waiter.wait()
    }

    waiter.complete(.success(()))
    await #expect(throws: RFBSendExpiredError.self) {
      try await waiter.wait()
    }
  }

  @Test
  func stalledPredecessorBoundsDeadlineSendBacklog() async {
    let stalledSend = SuspendedAudioSend()
    let queue = RFBSendQueue { _ in await stalledSend.send() }
    let predecessor = Task { try await queue.send(Data([0]), deadline: nil) }
    await stalledSend.waitUntilStarted()

    for byte in UInt8(1)...2 {
      await #expect(throws: RFBSendExpiredError.self) {
        try await queue.send(
          Data([byte]),
          deadline: ContinuousClock().now.advanced(by: .milliseconds(10)))
      }
    }
    #expect(await queue.pendingDeadlineSendCount == 2)

    let startedAt = ContinuousClock().now
    for byte in UInt8(3)...12 {
      await #expect(throws: RFBSendExpiredError.self) {
        try await queue.send(
          Data([byte]),
          deadline: ContinuousClock().now.advanced(by: .seconds(5)))
      }
    }
    #expect(ContinuousClock().now - startedAt < .seconds(1))
    #expect(await queue.pendingDeadlineSendCount == 2)
    #expect(await stalledSend.sendCount == 1)

    await stalledSend.release()
    _ = try? await predecessor.value
  }
}

private final class AudioDeadlineTestClock: @unchecked Sendable {
  private let lock = NSLock()
  private var value = ContinuousClock().now

  var now: ContinuousClock.Instant {
    lock.withLock { value }
  }

  func advance(by duration: Duration) {
    lock.withLock { value = value.advanced(by: duration) }
  }
}

private actor AudioTestSignal {
  private var isSignaled = false
  private var waiters: [CheckedContinuation<Void, Never>] = []

  func signal() {
    guard !isSignaled else { return }
    isSignaled = true
    waiters.forEach { $0.resume() }
    waiters.removeAll()
  }

  func wait() async {
    guard !isSignaled else { return }
    await withCheckedContinuation { waiters.append($0) }
  }
}

private actor SuspendedAudioSend {
  private var started = false
  private var startWaiters: [CheckedContinuation<Void, Never>] = []
  private var sendContinuation: CheckedContinuation<Void, Never>?
  private(set) var sendCount = 0

  func send() async {
    sendCount += 1
    started = true
    startWaiters.forEach { $0.resume() }
    startWaiters.removeAll()
    await withCheckedContinuation { sendContinuation = $0 }
  }

  func waitUntilStarted() async {
    guard !started else { return }
    await withCheckedContinuation { startWaiters.append($0) }
  }

  func release() {
    sendContinuation?.resume()
    sendContinuation = nil
  }
}
