import AppKit
import Foundation
import RoyalVNCKit
import Testing

@testable import CrabfleetMac

struct HostShareWireTests {
  @Test
  func cursorPseudoEncodingsMatchRFBFixtures() throws {
    let image = RFBCursorImage(
      width: 2,
      height: 1,
      hotspotX: 1,
      hotspotY: 0,
      rgba: Data([
        0x11, 0x22, 0x33, 0xFF,
        0x20, 0x10, 0x08, 0x80,
      ]))

    #expect(
      try RFBWire.cursorWithAlphaUpdate(image: image)
        == Data([
          0, 0, 0, 1,
          0, 1, 0, 0, 0, 2, 0, 1, 0xFF, 0xFF, 0xFE, 0xC6,
          0, 0, 0, 0,
          0x11, 0x22, 0x33, 0xFF, 0x20, 0x10, 0x08, 0x80,
        ]))
    #expect(
      try RFBWire.cursorUpdate(image: image)
        == Data([
          0, 0, 0, 1,
          0, 1, 0, 0, 0, 2, 0, 1, 0xFF, 0xFF, 0xFF, 0x11,
          0x33, 0x22, 0x11, 0,
          0x10, 0x20, 0x40, 0,
          0xC0,
        ]))
    #expect(
      RFBWire.pointerPositionUpdate(x: 0x1234, y: 0x5678)
        == Data([
          0, 0, 0, 1,
          0x12, 0x34, 0x56, 0x78, 0, 0, 0, 0, 0xFF, 0xFF, 0xFF, 0x18,
        ]))
    #expect(
      RFBWire.hiddenCursorUpdate(encoding: .cursorWithAlpha)
        == Data([
          0, 0, 0, 1,
          0, 0, 0, 0, 0, 0, 0, 0, 0xFF, 0xFF, 0xFE, 0xC6,
          0, 0, 0, 0,
        ]))
  }

  @Test
  func classicCursorMasksFaintAntialiasingAsTransparent() throws {
    let update = try RFBWire.cursorUpdate(
      image: RFBCursorImage(
        width: 1,
        height: 1,
        hotspotX: 0,
        hotspotY: 0,
        rgba: Data([0x10, 0x08, 0x04, 0x7F])))

    #expect(update.last == 0)
  }

  @Test
  func cursorWireRejectsInvalidDimensionsAndPayloads() {
    for image in [
      RFBCursorImage(width: 0, height: 1, hotspotX: 0, hotspotY: 0, rgba: Data()),
      RFBCursorImage(width: 129, height: 1, hotspotX: 0, hotspotY: 0, rgba: Data(count: 516)),
      RFBCursorImage(width: 1, height: 1, hotspotX: 1, hotspotY: 0, rgba: Data(count: 4)),
      RFBCursorImage(width: 1, height: 1, hotspotX: 0, hotspotY: 0, rgba: Data(count: 3)),
    ] {
      #expect(throws: (any Error).self) { _ = try RFBWire.cursorWithAlphaUpdate(image: image) }
      #expect(throws: (any Error).self) { _ = try RFBWire.cursorUpdate(image: image) }
    }
  }

  @Test
  func cursorNegotiationPrefersAlphaThenClassic() {
    #expect(
      RFBWire.preferredCursorEncoding(
        from: [RFBWire.cursorEncoding, RFBWire.cursorWithAlphaEncoding]) == .cursorWithAlpha)
    #expect(RFBWire.preferredCursorEncoding(from: [RFBWire.cursorEncoding]) == .cursor)
    #expect(RFBWire.preferredCursorEncoding(from: [RFBWire.pointerPositionEncoding]) == nil)
  }

  @Test
  func audioMessagesMatchWireFormat() throws {
    #expect(
      try RFBWire.audioConfig(
        channels: 2,
        sampleRate: 48_000,
        magicCookie: Data([0x11, 0x90]))
        == Data([200, 1, 1, 2, 0, 0, 0xBB, 0x80, 0, 0, 0, 2, 0x11, 0x90]))
    #expect(
      try RFBWire.audioPacket(timestampMs: 0xFFFF_FFFE, payload: Data([0xAA, 0xBB]))
        == Data([200, 2, 0, 0, 0xFF, 0xFF, 0xFF, 0xFE, 0, 0, 0, 2, 0xAA, 0xBB]))
    #expect(RFBWire.audioStop() == Data([200, 3, 0, 0]))
  }

  @Test
  func audioWireRejectsInvalidBounds() {
    #expect(throws: (any Error).self) {
      _ = try RFBWire.audioConfig(channels: 0, sampleRate: 48_000, magicCookie: Data())
    }
    #expect(throws: (any Error).self) {
      _ = try RFBWire.audioPacket(timestampMs: 0, payload: Data())
    }
    #expect(throws: (any Error).self) {
      _ = try RFBWire.audioPacket(
        timestampMs: 0,
        payload: Data(count: RFBWire.maximumAudioPayloadBytes + 1))
    }
  }

  @Test
  func audioNegotiationRequiresToggleAndCAF1() {
    #expect(
      RFBWire.shouldStreamAudio(
        hostEnabled: true,
        encodings: [RFBWire.crabfleetAudioEncoding]))
    #expect(!RFBWire.shouldStreamAudio(hostEnabled: false, encodings: [RFBWire.crabfleetAudioEncoding]))
    #expect(!RFBWire.shouldStreamAudio(hostEnabled: true, encodings: [RFBWire.openH264Encoding]))
  }

  @Test
  func extendedDesktopSizeUpdateEncodesOneScreen() throws {
    let update = try RFBWire.extendedDesktopSizeUpdate(
      reason: 1,
      status: 0,
      width: 1_280,
      height: 720
    )

    #expect(
      update
        == Data([
          0, 0,  // FramebufferUpdate + padding
          0, 1,  // one rectangle
          0, 1,  // x = reason (client-requested)
          0, 0,  // y = status (no error)
          0x05, 0x00,  // width 1280
          0x02, 0xD0,  // height 720
          0xFF, 0xFF, 0xFE, 0xCC,  // ExtendedDesktopSize (-308)
          1, 0, 0, 0,  // one screen + padding
          0, 0, 0, 1,  // screen id
          0, 0, 0, 0,  // position
          0x05, 0x00, 0x02, 0xD0,  // screen size
          0, 0, 0, 0,  // flags
        ])
    )
  }

  @Test
  func extendedDesktopSizeUpdateRejectsInvalidDimensions() {
    #expect(throws: (any Error).self) {
      _ = try RFBWire.extendedDesktopSizeUpdate(reason: 0, status: 0, width: 0, height: 720)
    }
    #expect(throws: (any Error).self) {
      _ = try RFBWire.extendedDesktopSizeUpdate(reason: 0, status: 0, width: 70_000, height: 720)
    }
  }

  @Test
  func legacyServerCutTextRequiresLatin1() {
    let encoded = RFBWire.legacyServerCutText(text: "héllo")

    #expect(
      encoded == Data([3, 0, 0, 0, 0, 0, 0, 5]) + Data([0x68, 0xE9, 0x6C, 0x6C, 0x6F])
    )
    #expect(RFBWire.legacyServerCutText(text: "emoji 🦀") == nil)
  }

  @Test
  func emptyExtendedClipboardTextRemainsRequestable() throws {
    let caps = VNCExtendedClipboardCaps(
      supportsText: true,
      maximumUnsolicitedTextBytes: 0,
      actions: VNCExtendedClipboard.notifyAction
    )
    let packet = try #require(
      RFBWire.hostClipboardPayload(text: "", extendedNegotiated: true, caps: caps)
    )

    #expect(packet[0] == 3)
    #expect(try VNCExtendedClipboard.decode(body: packet.subdata(in: 8..<packet.count)) == .notify(text: true))
  }

  @Test
  func resizedDimensionsAspectFitTheSourceIntoTheRequest() {
    // Exact aspect match scales cleanly.
    let exact = MacScreenCapture.resizedDimensions(
      requestedWidth: 1_280,
      requestedHeight: 800,
      sourcePixelWidth: 2_880,
      sourcePixelHeight: 1_800
    )
    #expect(exact.width == 1_280)
    #expect(exact.height == 800)

    // Requests beyond the native pixel size never upscale.
    let capped = MacScreenCapture.resizedDimensions(
      requestedWidth: 5_000,
      requestedHeight: 5_000,
      sourcePixelWidth: 1_600,
      sourcePixelHeight: 1_000
    )
    #expect(capped.width == 1_600)
    #expect(capped.height == 1_000)

    // Tiny requests clamp to the 320×240 floor, aspect-fit within it.
    let floored = MacScreenCapture.resizedDimensions(
      requestedWidth: 100,
      requestedHeight: 100,
      sourcePixelWidth: 2_880,
      sourcePixelHeight: 1_800
    )
    #expect(floored.width == 320)
    #expect(floored.height == 200)

    let h264 = MacScreenCapture.resizedDimensions(
      requestedWidth: 4_096,
      requestedHeight: 2_304,
      sourcePixelWidth: 5_120,
      sourcePixelHeight: 2_880,
      maximumWidth: 4_096,
      maximumHeight: 2_304
    )
    #expect(h264.width == 4_096)
    #expect(h264.height == 2_304)
  }
}

struct CursorPipelinePolicyTests {
  @Test
  func captureBakesUnlessEveryActiveSessionNegotiatedCursor() {
    let first = UUID()
    let second = UUID()
    var state = CursorCaptureNegotiationState()

    #expect(state.showsCursor)
    state.join(first)
    #expect(state.showsCursor)
    state.setNegotiated(true, for: first)
    #expect(!state.showsCursor)
    state.join(second)
    #expect(state.showsCursor)
    state.setNegotiated(true, for: second)
    #expect(!state.showsCursor)
    state.setNegotiated(false, for: first)
    #expect(state.showsCursor)
    state.leave(first)
    #expect(!state.showsCursor)
    state.leave(second)
    #expect(state.showsCursor)
  }

  @Test
  func cursorContentHashDeduplicatesOnlyIdenticalImages() {
    let first = RFBCursorImage(
      width: 1, height: 1, hotspotX: 0, hotspotY: 0, rgba: Data([1, 2, 3, 4]))
    let changed = RFBCursorImage(
      width: 1, height: 1, hotspotX: 0, hotspotY: 0, rgba: Data([1, 2, 3, 5]))
    var deduplicator = CursorImageDeduplicator()

    let firstSend = deduplicator.shouldSend(hash: first.contentHash)
    let duplicateSend = deduplicator.shouldSend(hash: first.contentHash)
    let changedSend = deduplicator.shouldSend(hash: changed.contentHash)
    #expect(firstSend)
    #expect(!duplicateSend)
    #expect(changedSend)
  }

  @Test
  func pointerEchoSuppressionExpiresAfter250Milliseconds() {
    #expect(
      !CursorEchoPolicy.shouldSendPointerPosition(
        positionChanged: true, lastLocalInput: 10, now: 10.249))
    #expect(
      CursorEchoPolicy.shouldSendPointerPosition(
        positionChanged: true, lastLocalInput: 10, now: 10.25))
    #expect(
      !CursorEchoPolicy.shouldSendPointerPosition(
        positionChanged: false, lastLocalInput: nil, now: 20))
  }

  @Test
  func cursorCoordinatesInvertRemoteInputMapping() throws {
    let descriptor = CapturedDisplayDescriptor(
      displayID: 1,
      displayBounds: CGRect(x: 100, y: 50, width: 1_440, height: 900),
      frameWidth: 2_880,
      frameHeight: 1_800,
      sourcePixelWidth: 2_880,
      sourcePixelHeight: 1_800)
    let position = CursorCoordinateMapper.pointerPosition(
      CGPoint(x: 820, y: 500),
      descriptor: descriptor,
      frameWidth: descriptor.frameWidth,
      frameHeight: descriptor.frameHeight)
    #expect(position?.x == 1_440)
    #expect(position?.y == 900)
    #expect(
      CursorCoordinateMapper.pointerPosition(
        CGPoint(x: 99, y: 500),
        descriptor: descriptor,
        frameWidth: descriptor.frameWidth,
        frameHeight: descriptor.frameHeight) == nil)

    let image = SystemCursorImage(
      width: 32,
      height: 32,
      pointWidth: 16,
      pointHeight: 16,
      hotspot: CGPoint(x: 2, y: 3),
      rgba: Data(repeating: 0x7F, count: 32 * 32 * 4),
      contentHash: Data([1]))
    let mapped = try #require(
      CursorCoordinateMapper.cursorImage(
        image,
        descriptor: descriptor,
        frameWidth: descriptor.frameWidth,
        frameHeight: descriptor.frameHeight))
    #expect(mapped.width == 32)
    #expect(mapped.height == 32)
    #expect(mapped.hotspotX == 4)
    #expect(mapped.hotspotY == 6)
  }
}

struct RFBHostSessionStreamTests {
  @Test
  func readsAByteFromDataWithANonzeroStartIndex() async throws {
    #expect(try await SlicedRFBByteStream().readUInt8() == 42)
  }

  @Test
  func directAndRelayStreamsShareFourSessionGate() async throws {
    let gate = RFBHostSessionGate()
    let acquired = ThreadSafeFlag()
    let released = ThreadSafeFlag()
    let direct = DirectSessionClaimingRFBByteStream(
      base: InMemoryRFBByteStream(incoming: Data([1, 2])),
      gate: gate,
      onAcquire: { acquired.set() },
      onRelease: { released.set() }
    )

    #expect(gate.activeCount == 0)
    #expect(gate.reservedCount == 1)
    #expect(!acquired.value)
    #expect(try await direct.readExactly(2) == Data([1, 2]))
    #expect(acquired.value)
    #expect(gate.activeCount == 1)
    #expect(gate.reservedCount == 0)

    let relayTask = RecordingHostRelayWebSocketTask(incoming: [.data(Data([3]))])
    let relay = SessionClaimingRFBByteStream(
      base: RelayWebSocketByteStream(task: relayTask),
      gate: gate,
      onAcquire: {},
      onRelease: {}
    )
    #expect(try await relay.readExactly(1) == Data([3]))
    #expect(gate.activeCount == 2)

    let third = try #require(gate.acquire())
    let fourth = try #require(gate.acquire())
    #expect(gate.activeCount == 4)

    let rejected = DirectSessionClaimingRFBByteStream(
      base: InMemoryRFBByteStream(incoming: Data([4])),
      gate: gate,
      onAcquire: {},
      onRelease: {})
    await #expect(throws: (any Error).self) {
      _ = try await rejected.readExactly(1)
    }
    #expect(!rejected.hasClaim)

    direct.finishClaim()
    relay.finishClaim()
    gate.release(third)
    gate.release(fourth)
    #expect(released.value)
    #expect(gate.activeCount == 0)
  }

  @Test
  func sharedGateSerializesResizeAndPublishesNewDimensions() throws {
    let gate = RFBHostSessionGate()
    let descriptor = CapturedDisplayDescriptor(
      displayID: 7,
      displayBounds: CGRect(x: 0, y: 0, width: 1_920, height: 1_080),
      frameWidth: 1_280,
      frameHeight: 720,
      sourcePixelWidth: 1_920,
      sourcePixelHeight: 1_080)
    gate.configure(descriptor: descriptor)
    let first = try #require(gate.acquire())
    #expect(gate.beginResize())
    #expect(gate.acquire() == nil)
    #expect(gate.reserve() == nil)
    gate.finishResize(width: 1_600, height: 900)
    #expect(gate.descriptor(basedOn: descriptor).frameWidth == 1_600)
    #expect(gate.descriptor(basedOn: descriptor).frameHeight == 900)

    let second = try #require(gate.acquire())
    #expect(!gate.beginResize())
    gate.release(first)
    gate.release(second)
  }

  @Test
  func handshakeUsesLatestSharedDimensions() async throws {
    var clientHandshake = RFBVersion.serverBanner
    clientHandshake.append(1)  // None security
    clientHandshake.append(1)  // shared ClientInit
    let stream = InMemoryRFBByteStream(incoming: clientHandshake)
    let finished = ThreadSafeFlag()
    let descriptor = CapturedDisplayDescriptor(
      displayID: 1,
      displayBounds: CGRect(x: 0, y: 0, width: 640, height: 480),
      frameWidth: 640,
      frameHeight: 480,
      sourcePixelWidth: 640,
      sourcePixelHeight: 480
    )
    let gate = RFBHostSessionGate()
    gate.configure(descriptor: descriptor)
    let session = RFBHostSession(
      byteStream: stream,
      capture: MacScreenCapture(),
      descriptor: descriptor,
      input: HandshakeRemoteInput(),
      clipboard: nil,
      desktopSizeProvider: { gate.descriptor(basedOn: descriptor) },
      remoteAddressOverride: "Crabfleet browser",
      skipTailnetCheck: true,
      desktopName: "Crabfleet — Test Mac",
      handshakeTimeout: .seconds(1),
      viewOnly: false,
      audioEnabled: true,
      qualityMode: .auto,
      didAuthorize: {},
      eventHandler: { _ in },
      didFinish: { _ in finished.set() }
    )

    let resizeClaim = try #require(gate.acquire())
    #expect(gate.beginResize())
    gate.finishResize(width: 800, height: 600)
    gate.release(resizeClaim)

    session.start()
    let clock = ContinuousClock()
    let deadline = clock.now.advanced(by: .seconds(1))
    while !finished.value, clock.now < deadline {
      try await Task.sleep(for: .milliseconds(10))
    }
    session.stop()
    #expect(finished.value)

    var expected = RFBVersion.serverBanner
    expected.append(contentsOf: [1, 1])
    expected.append(contentsOf: [0, 0, 0, 0])
    expected.append(
      try RFBWire.serverInit(width: 800, height: 600, name: "Crabfleet — Test Mac")
    )
    #expect(stream.outgoing == expected)
  }
}

@MainActor
struct HostClipboardBridgeTests {
  @Test
  func baselinesExistingClipboardAndPushesOnlyNewLocalChanges() async throws {
    let pasteboard = NSPasteboard(name: .init("CrabfleetMacTests.\(UUID().uuidString)"))
    pasteboard.clearContents()
    pasteboard.setString("pre-existing", forType: .string)

    let recorder = PushRecorder()
    let bridge = HostClipboardBridge(pasteboard: pasteboard, pollingInterval: 0.01)
    bridge.attach { recorder.append($0) }

    try await Task.sleep(for: .milliseconds(60))
    #expect(recorder.values.isEmpty)

    pasteboard.clearContents()
    pasteboard.setString("host copy", forType: .string)
    try await waitUntil { recorder.values == ["host copy"] }
    #expect(bridge.currentText() == "host copy")

    bridge.detach()
  }

  @Test
  func clientTextLandsOnPasteboardWithoutEchoingBack() async throws {
    let pasteboard = NSPasteboard(name: .init("CrabfleetMacTests.\(UUID().uuidString)"))
    pasteboard.clearContents()

    let recorder = PushRecorder()
    let bridge = HostClipboardBridge(pasteboard: pasteboard, pollingInterval: 0.01)
    bridge.attach { recorder.append($0) }
    try await Task.sleep(for: .milliseconds(30))

    bridge.receiveClientText("from client")
    try await waitUntil { pasteboard.string(forType: .string) == "from client" }
    #expect(bridge.currentText() == "from client")

    // Several poll cycles must not bounce the client's own text back.
    try await Task.sleep(for: .milliseconds(80))
    #expect(recorder.values.isEmpty)

    // A genuinely new local copy still goes out.
    pasteboard.clearContents()
    pasteboard.setString("newer host copy", forType: .string)
    try await waitUntil { recorder.values == ["newer host copy"] }

    bridge.detach()
  }

  @Test
  func multicastsHostAndPeerClipboardWithoutRebaselining() async throws {
    let pasteboard = NSPasteboard(name: .init("CrabfleetMacTests.\(UUID().uuidString)"))
    pasteboard.clearContents()
    pasteboard.setString("initial", forType: .string)
    let firstID = UUID()
    let secondID = UUID()
    let first = PushRecorder()
    let second = PushRecorder()
    let bridge = HostClipboardBridge(pasteboard: pasteboard, pollingInterval: 10)
    bridge.attach(id: firstID) { first.append($0) }
    try await Task.sleep(for: .milliseconds(30))

    pasteboard.clearContents()
    pasteboard.setString("host copy", forType: .string)
    bridge.attach(id: secondID) { second.append($0) }
    bridge.poll()
    #expect(first.values == ["host copy"])
    #expect(second.values == ["host copy"])

    bridge.receiveClientText(id: firstID, text: "first viewer copy")
    try await waitUntil { second.values == ["host copy", "first viewer copy"] }
    #expect(first.values == ["host copy"])
    #expect(pasteboard.string(forType: .string) == "first viewer copy")
    bridge.detachAll()
  }

  @Test
  func forwardsClipboardClearsAndLocallyReusedClientValues() async throws {
    let pasteboard = NSPasteboard(name: .init("CrabfleetMacTests.\(UUID().uuidString)"))
    pasteboard.clearContents()
    pasteboard.setString("initial", forType: .string)

    let recorder = PushRecorder()
    let bridge = HostClipboardBridge(pasteboard: pasteboard, pollingInterval: 0.01)
    bridge.attach { recorder.append($0) }
    try await Task.sleep(for: .milliseconds(30))

    bridge.receiveClientText("reused")
    try await waitUntil { pasteboard.string(forType: .string) == "reused" }
    bridge.poll()
    #expect(recorder.values.isEmpty)

    pasteboard.clearContents()
    pasteboard.setString("other", forType: .string)
    bridge.poll()
    #expect(recorder.values == ["other"])

    pasteboard.clearContents()
    bridge.poll()
    #expect(recorder.values == ["other", ""])

    pasteboard.clearContents()
    pasteboard.setString("reused", forType: .string)
    bridge.poll()
    #expect(recorder.values == ["other", "", "reused"])
    bridge.detach()
  }

  @Test
  func ignoresNonTextChangesButForwardsEmptyText() async throws {
    let pasteboard = NSPasteboard(name: .init("CrabfleetMacTests.\(UUID().uuidString)"))
    pasteboard.clearContents()
    pasteboard.setString("initial", forType: .string)

    let recorder = PushRecorder()
    let bridge = HostClipboardBridge(pasteboard: pasteboard, pollingInterval: 0.01)
    bridge.attach { recorder.append($0) }
    try await Task.sleep(for: .milliseconds(30))

    let item = NSPasteboardItem()
    item.setData(Data([0x00, 0x01]), forType: .init("com.example.crabfleet.binary"))
    pasteboard.clearContents()
    pasteboard.writeObjects([item])
    bridge.poll()
    #expect(recorder.values.isEmpty)
    #expect(bridge.currentText() == nil)

    bridge.receiveClientText("initial")
    try await waitUntil { pasteboard.string(forType: .string) == "initial" }
    #expect(bridge.currentText() == "initial")

    pasteboard.clearContents()
    pasteboard.setString("", forType: .string)
    bridge.poll()
    #expect(recorder.values == [""])
    #expect(bridge.currentText() == "")
    bridge.detach()
  }

  private func waitUntil(
    timeout: Duration = .seconds(1),
    condition: @escaping @MainActor () -> Bool
  ) async throws {
    let clock = ContinuousClock()
    let deadline = clock.now.advanced(by: timeout)
    while clock.now < deadline {
      if condition() { return }
      try await Task.sleep(for: .milliseconds(10))
    }
    #expect(condition())
  }
}

@MainActor
struct ClipboardDirectionTests {
  @Test
  func sendOnlyKeepsRemoteTextOffTheMacPasteboard() async throws {
    let pasteboard = NSPasteboard(name: .init("CrabfleetMacTests.\(UUID().uuidString)"))
    pasteboard.clearContents()
    pasteboard.setString("local", forType: .string)

    let defaults = try ephemeralDefaults()
    let coordinator = ClipboardCoordinator(
      pasteboard: pasteboard,
      pollingInterval: 0.01,
      defaults: defaults
    )
    coordinator.direction = .sendOnly

    let session = DirectionEndpointRecorder()
    coordinator.focus(session: session, targetID: "target")
    try await Task.sleep(for: .milliseconds(30))

    coordinator.receiveRemoteText("remote secret", from: "target")
    #expect(pasteboard.string(forType: .string) == "local")
    #expect(coordinator.hasPendingRemoteClipboard(for: "target"))
    #expect(coordinator.state == .remoteAvailable)

    // The explicit recovery action still applies remote text deliberately.
    coordinator.applyRemoteClipboard(for: "target")
    #expect(pasteboard.string(forType: .string) == "remote secret")
  }

  @Test
  func receiveOnlyNeverAutoSendsLocalChanges() async throws {
    let pasteboard = NSPasteboard(name: .init("CrabfleetMacTests.\(UUID().uuidString)"))
    pasteboard.clearContents()

    let defaults = try ephemeralDefaults()
    let coordinator = ClipboardCoordinator(
      pasteboard: pasteboard,
      pollingInterval: 0.01,
      defaults: defaults
    )
    coordinator.direction = .receiveOnly

    let session = DirectionEndpointRecorder()
    coordinator.focus(session: session, targetID: "target")
    try await Task.sleep(for: .milliseconds(30))

    pasteboard.clearContents()
    pasteboard.setString("local change", forType: .string)
    try await Task.sleep(for: .milliseconds(100))
    #expect(session.sentTexts.isEmpty)

    // The explicit toolbar action still sends deliberately.
    coordinator.sendCurrentClipboard()
    #expect(session.sentTexts == ["local change"])
  }

  @Test
  func directionPersistsThroughDefaults() throws {
    let defaults = try ephemeralDefaults()
    let pasteboard = NSPasteboard(name: .init("CrabfleetMacTests.\(UUID().uuidString)"))

    let first = ClipboardCoordinator(
      pasteboard: pasteboard,
      pollingInterval: 0.01,
      defaults: defaults
    )
    #expect(first.direction == .bidirectional)
    first.direction = .receiveOnly

    let second = ClipboardCoordinator(
      pasteboard: pasteboard,
      pollingInterval: 0.01,
      defaults: defaults
    )
    #expect(second.direction == .receiveOnly)
  }

  private func ephemeralDefaults() throws -> UserDefaults {
    let suiteName = "CrabfleetMacTests.\(UUID().uuidString)"
    let defaults = try #require(UserDefaults(suiteName: suiteName))
    defaults.removePersistentDomain(forName: suiteName)
    return defaults
  }
}

private final class PushRecorder: @unchecked Sendable {
  private let lock = NSLock()
  private var storage = [String]()

  var values: [String] {
    lock.lock()
    defer { lock.unlock() }
    return storage
  }

  func append(_ value: String) {
    lock.lock()
    storage.append(value)
    lock.unlock()
  }
}

private final class DirectionEndpointRecorder: ClipboardSessionEndpoint {
  var clipboardEnabled = true
  var isClipboardConnected = true
  var sentTexts = [String]()

  func sendClipboardText(_ text: String) throws {
    sentTexts.append(text)
  }
}

private final class InMemoryRFBByteStream: RFBByteStream, @unchecked Sendable {
  private let lock = NSLock()
  private var incoming: Data
  private var sent = Data()

  init(incoming: Data) {
    self.incoming = incoming
  }

  var outgoing: Data {
    lock.lock()
    defer { lock.unlock() }
    return sent
  }

  func readExactly(_ count: Int) async throws -> Data {
    try withLock {
      guard count >= 0, incoming.count >= count else {
        throw PrivateMacShareError.protocolError("in-memory stream ended")
      }
      let result = incoming.prefix(count)
      incoming.removeFirst(count)
      return Data(result)
    }
  }

  func send(_ data: Data) async throws {
    withLock { sent.append(data) }
  }

  func send(_ data: Data, deadline: ContinuousClock.Instant?) async throws {
    if let deadline, ContinuousClock().now >= deadline { throw RFBSendExpiredError() }
    try await send(data)
  }

  private func withLock<T>(_ body: () throws -> T) rethrows -> T {
    lock.lock()
    defer { lock.unlock() }
    return try body()
  }
}

private final class RecordingHostRelayWebSocketTask: RelayWebSocketTasking, @unchecked Sendable {
  private let lock = NSLock()
  private var incoming: [URLSessionWebSocketTask.Message]

  init(incoming: [URLSessionWebSocketTask.Message]) {
    self.incoming = incoming
  }

  func resume() {}

  func receive() async throws -> URLSessionWebSocketTask.Message {
    try withLock {
      guard !incoming.isEmpty else {
        throw PrivateMacShareError.protocolError("test relay ended")
      }
      return incoming.removeFirst()
    }
  }

  func send(_ message: URLSessionWebSocketTask.Message) async throws {}
  func cancel(with closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {}

  private func withLock<T>(_ body: () throws -> T) rethrows -> T {
    lock.lock()
    defer { lock.unlock() }
    return try body()
  }
}

private struct HandshakeRemoteInput: RemoteInputForwarding {
  func keyEvent(down: Bool, keysym: UInt32) {}
  func pointerEvent(buttonMask: UInt8, x: UInt16, y: UInt16) {}
}

private struct SlicedRFBByteStream: RFBByteStream {
  func readExactly(_ count: Int) async throws -> Data {
    let data = Data([0, 42])
    return data[data.index(after: data.startIndex)...]
  }

  func send(_ data: Data) async throws {}

  func send(_ data: Data, deadline: ContinuousClock.Instant?) async throws {
    if let deadline, ContinuousClock().now >= deadline { throw RFBSendExpiredError() }
  }
}

private final class ThreadSafeFlag: @unchecked Sendable {
  private let lock = NSLock()
  private var storage = false

  var value: Bool {
    lock.lock()
    defer { lock.unlock() }
    return storage
  }

  func set() {
    lock.lock()
    storage = true
    lock.unlock()
  }
}
