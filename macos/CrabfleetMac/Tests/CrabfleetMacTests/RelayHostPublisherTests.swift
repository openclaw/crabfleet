import Foundation
import Testing

@testable import CrabfleetMac

struct RelayHostPublisherTests {
  @Test
  func websocketByteStreamReassemblesReadsAndChunksWrites() async throws {
    let task = RecordingRelayWebSocketTask(incoming: [
      .data(Data([1, 2])),
      .data(Data([3, 4, 5])),
    ])
    let stream = RelayWebSocketByteStream(task: task)

    try await stream.waitForIncomingData()
    #expect(try await stream.readExactly(4) == Data([1, 2, 3, 4]))
    #expect(try await stream.readExactly(1) == Data([5]))

    let payload = Data(repeating: 0x2a, count: RelayWebSocketByteStream.sendChunkBytes * 2 + 1)
    try await stream.send(payload)
    #expect(task.sentData.map(\.count) == [256 * 1_024, 256 * 1_024, 1])
    #expect(task.sentData.reduce(into: Data()) { $0.append($1) } == payload)
  }

  @Test
  func websocketByteStreamRejectsTextAndOversizedMessages() async {
    let text = RelayWebSocketByteStream(
      task: RecordingRelayWebSocketTask(incoming: [.string("not RFB")])
    )
    await #expect(throws: (any Error).self) {
      _ = try await text.readExactly(1)
    }

    let oversized = RelayWebSocketByteStream(
      task: RecordingRelayWebSocketTask(incoming: [
        .data(Data(count: RelayWebSocketByteStream.maximumMessageBytes + 1))
      ])
    )
    await #expect(throws: (any Error).self) {
      _ = try await oversized.readExactly(1)
    }
  }

  @Test
  func websocketByteStreamDropsExpiredDeadlineSends() async {
    let task = RecordingRelayWebSocketTask(incoming: [])
    let stream = RelayWebSocketByteStream(task: task)

    await #expect(throws: RFBSendExpiredError.self) {
      try await stream.send(Data([1]), deadline: ContinuousClock().now)
    }
    #expect(task.sentData.isEmpty)
  }

  @Test
  func relaySessionSendsServerBannerBeforeWaitingForViewerBytes() async throws {
    let clientBanner = Data("RFB 003.008\n".utf8)
    let task = RecordingRelayWebSocketTask(incoming: [.data(clientBanner)])
    let stream = SessionClaimingRFBByteStream(
      base: RelayWebSocketByteStream(task: task),
      gate: RFBHostSessionGate(),
      onAcquire: {},
      onRelease: {}
    )

    try await stream.send(RFBVersion.serverBanner)
    #expect(task.sentData == [RFBVersion.serverBanner])
    #expect(try await stream.readExactly(12) == clientBanner)
    stream.finishHandshake()
    stream.finishClaim()
  }

  @Test
  func onlyAuthenticatedRelayPublisherSessionKeepsSecurityNoneBypass() async throws {
    var viewerHandshake = RFBVersion.serverBanner
    viewerHandshake.append(contentsOf: [1, 1])  // None selection, shared ClientInit.
    let task = RecordingRelayWebSocketTask(incoming: [.data(viewerHandshake)])
    let descriptor = CapturedDisplayDescriptor(
      displayID: 1,
      displayBounds: CGRect(x: 0, y: 0, width: 64, height: 64),
      frameWidth: 64,
      frameHeight: 64,
      sourcePixelWidth: 64,
      sourcePixelHeight: 64)
    let publisher = RelayHostPublisher(
      endpoint: try #require(URL(string: "wss://fleet.example.test/relay")),
      relayAccess: "test-auth-token",
      capture: MacScreenCapture(),
      descriptor: descriptor,
      input: RelayNoopInput(),
      clipboard: nil,
      sessionGate: RFBHostSessionGate(),
      eventHandler: { _ in },
      taskFactory: { _ in task })

    publisher.start()
    defer { publisher.stop() }
    let deadline = ContinuousClock().now.advanced(by: .seconds(2))
    while task.sentData.count < 4, ContinuousClock().now < deadline {
      try await Task.sleep(for: .milliseconds(10))
    }

    let sent = task.sentData
    #expect(sent.count >= 4)
    guard sent.count >= 4 else { return }
    #expect(sent[0] == RFBVersion.serverBanner)
    #expect(sent[1] == Data([1, 1]))
    #expect(sent[2] == Data([0, 0, 0, 0]))
  }

  @Test
  func registrationBuildsSecureRelayEndpoint() throws {
    let registration = try #require(
      CrabfleetDesktopRegistration(environment: [
        "CRABFLEET_API_URL": "https://fleet.example",
        "CRABFLEET_SESSION_COOKIE": "test-cookie-placeholder",
      ])
    )

    #expect(
      registration.relayHostURL(hostID: "studio")?.absoluteString
        == "wss://fleet.example/api/desktop-hosts/studio/relay/host"
    )
  }

  @Test @MainActor
  func browserRelayDefaultsOnAndPersistsUserChoice() throws {
    let suiteName = "CrabfleetMacTests.\(UUID().uuidString)"
    let defaults = try #require(UserDefaults(suiteName: suiteName))
    defaults.removePersistentDomain(forName: suiteName)
    let controller = PrivateMacShareController(
      runner: StaticRelayTailscaleRunner(),
      desktopRegistration: nil,
      defaults: defaults
    )

    #expect(controller.browserAccessEnabled)
    controller.browserAccessEnabled = false
    #expect(defaults.object(forKey: PrivateMacShareController.browserAccessDefaultsKey) as? Bool == false)
  }
}

private struct RelayNoopInput: RemoteInputForwarding {
  func keyEvent(down: Bool, keysym: UInt32) {}
  func pointerEvent(buttonMask: UInt8, x: UInt16, y: UInt16) {}
}

private final class RecordingRelayWebSocketTask: RelayWebSocketTasking, @unchecked Sendable {
  private let lock = NSLock()
  private var incoming: [URLSessionWebSocketTask.Message]
  private var sent = [Data]()

  init(incoming: [URLSessionWebSocketTask.Message]) {
    self.incoming = incoming
  }

  var sentData: [Data] { withLock { sent } }

  func resume() {}

  func receive() async throws -> URLSessionWebSocketTask.Message {
    try withLock {
      guard !incoming.isEmpty else {
        throw PrivateMacShareError.protocolError("test websocket ended")
      }
      return incoming.removeFirst()
    }
  }

  func send(_ message: URLSessionWebSocketTask.Message) async throws {
    guard case .data(let data) = message else {
      throw PrivateMacShareError.protocolError("test expected binary data")
    }
    withLock { sent.append(data) }
  }

  func cancel(with closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {}

  private func withLock<T>(_ body: () throws -> T) rethrows -> T {
    lock.lock()
    defer { lock.unlock() }
    return try body()
  }
}

private struct StaticRelayTailscaleRunner: TailscaleCommandRunning {
  func run(arguments: [String]) async throws -> TailscaleCommandResult {
    throw PrivateMacShareError.tailscaleOffline
  }
}
