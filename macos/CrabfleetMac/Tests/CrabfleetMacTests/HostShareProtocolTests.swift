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
      RFBWire.pointerPositionUpdate(x: 1, y: 0)
        == Data([
          0, 0, 0, 1,
          0, 1, 0, 0, 0, 0, 0, 0, 0xFF, 0xFF, 0xFF, 0x18,
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
  func pendingStaticVideoRequestWakesForCursorRectangle() async throws {
    let arbiter = FramebufferUpdateArbiter<Int>()
    let videoMailbox = VideoMailbox<Int>()
    let snapshot = SystemCursorSnapshot(image: nil, position: CGPoint(x: 7, y: 9))
    let clock = ContinuousClock()
    let startedAt = clock.now

    async let pending = arbiter.next(videoMailbox: videoMailbox, timeout: .seconds(2))
    try await Task.sleep(for: .milliseconds(20))
    arbiter.offerCursor(snapshot)

    guard case .cursor(let delivered) = await pending else {
      Issue.record("pending framebuffer request did not wake for cursor")
      return
    }
    #expect(delivered == snapshot)
    #expect(startedAt.duration(to: clock.now) < .milliseconds(250))
    #expect(
      RFBWire.pointerPositionUpdate(x: 7, y: 9)
        == Data([
          0, 0, 0, 1,
          0, 7, 0, 9, 0, 0, 0, 0, 0xFF, 0xFF, 0xFF, 0x18,
        ]))
  }

  @Test
  func cursorAndVideoAvailabilityAlternateWithoutBlockingStaticCursor() async {
    let arbiter = FramebufferUpdateArbiter<Int>()
    let videoMailbox = VideoMailbox<Int>()
    let first = SystemCursorSnapshot(image: nil, position: CGPoint(x: 1, y: 1))
    let second = SystemCursorSnapshot(image: nil, position: CGPoint(x: 2, y: 2))

    videoMailbox.offer(1)
    arbiter.signalVideo()
    arbiter.offerCursor(first)
    guard case .cursor(let deliveredFirst) =
      await arbiter.next(videoMailbox: videoMailbox, timeout: .milliseconds(50))
    else {
      Issue.record("cursor did not win the first ready pair")
      return
    }
    #expect(deliveredFirst == first)
    arbiter.recordCursorResponse()

    arbiter.offerCursor(second)
    guard case .video(let deliveredVideo) =
      await arbiter.next(videoMailbox: videoMailbox, timeout: .milliseconds(50))
    else {
      Issue.record("ready video did not follow cursor-only response")
      return
    }
    #expect(deliveredVideo == 1)
    arbiter.recordVideoResponse()

    videoMailbox.offer(2)
    arbiter.signalVideo()
    guard case .cursor(let deliveredSecond) =
      await arbiter.next(videoMailbox: videoMailbox, timeout: .milliseconds(50))
    else {
      Issue.record("cursor did not resume after video response")
      return
    }
    #expect(deliveredSecond == second)
  }

  @Test
  func stoppedCaptureAcceptsCursorSessionLifecycle() async throws {
    let capture = MacScreenCapture()
    let sessionID = UUID()

    try await capture.addCursorSession(id: sessionID)
    try await capture.updateCursorSession(id: sessionID, negotiated: true)
    #expect(!capture.showsCapturedCursor)
    await capture.stop()
    #expect(capture.showsCapturedCursor)

    try await capture.addCursorSession(id: sessionID)
    try await capture.updateCursorSession(id: sessionID, negotiated: false)
    try await capture.removeCursorSession(id: sessionID)
  }

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
    let onePixel = try #require(
      CursorCoordinateMapper.pointerPosition(
        CGPoint(x: 820, y: 500),
        descriptor: descriptor,
        frameWidth: 1,
        frameHeight: 1))
    #expect(onePixel.x == 0)
    #expect(onePixel.y == 0)
    #expect(
      CursorCoordinateMapper.pointerPosition(
        CGPoint(x: 820, y: 500),
        descriptor: descriptor,
        frameWidth: 0,
        frameHeight: 1) == nil)

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

  @Test
  func continuousCursorTrafficDoesNotStarveTightVideo() async throws {
    let descriptor = CapturedDisplayDescriptor(
      displayID: 1,
      displayBounds: CGRect(x: 0, y: 0, width: 100, height: 100),
      frameWidth: 100,
      frameHeight: 100,
      sourcePixelWidth: 200,
      sourcePixelHeight: 200)
    let image = SystemCursorImage(
      width: 2,
      height: 2,
      pointWidth: 2,
      pointHeight: 2,
      hotspot: CGPoint(x: 1, y: 1),
      rgba: Data(repeating: 0xAA, count: 16),
      contentHash: Data([0xFA, 0xCE]))
    let snapshots = ThreadSafeSnapshotBox(
      SystemCursorSnapshot(image: image, position: CGPoint(x: 10, y: 10)))
    let capture = MacScreenCapture()
    await capture.frameStore.update(
      .init(jpegData: Data([0xFF, 0xD8, 0xFF, 0xD9]), sequence: 1, width: 100, height: 100))

    let cursorEncodings = clientSetEncodings([
      RFBWire.tightEncoding,
      RFBWire.cursorWithAlphaEncoding,
      RFBWire.pointerPositionEncoding,
    ])
    var incoming = RFBVersion.serverBanner
    incoming.append(contentsOf: [1, 1])  // None security, shared ClientInit.
    incoming.append(cursorEncodings)
    incoming.append(clientFramebufferUpdateRequest(width: 100, height: 100))
    incoming.append(clientFramebufferUpdateRequest(width: 100, height: 100))

    let stream = FeedableRFBByteStream(incoming: incoming)
    let finished = ThreadSafeFlag()
    let session = RFBHostSession(
      byteStream: stream,
      capture: capture,
      descriptor: descriptor,
      input: HandshakeRemoteInput(),
      clipboard: nil,
      remoteAddressOverride: "Crabfleet browser",
      skipTailnetCheck: true,
      desktopName: "Crabfleet — Cursor Fairness Test",
      handshakeTimeout: .seconds(1),
      viewOnly: false,
      audioEnabled: false,
      qualityMode: .auto,
      cursorSnapshotProvider: { snapshots.value },
      captureOutputSizeUpdater: { _, _ in },
      didAuthorize: {},
      eventHandler: { _ in },
      didFinish: { _ in finished.set() })

    session.start()
    let clock = ContinuousClock()
    let deadline = clock.now.advanced(by: .seconds(3))
    func waitFor(_ predicate: @escaping () -> Bool) async throws {
      while !predicate(), clock.now < deadline {
        try await Task.sleep(for: .milliseconds(5))
      }
      #expect(predicate())
    }

    // Initial cursor shape/position and first JPEG frame flow out.
    let jpegMarker = Data([0xFF, 0xD8, 0xFF, 0xD9])
    try await waitFor { stream.outgoing.range(of: jpegMarker) != nil }

    // A fresh desktop frame arrives while every subsequent request also has
    // fresh cursor traffic (position changes each time). Video must still
    // get its turn: the second JPEG payload must appear even though cursor
    // updates never stop.
    let second = Data([0xFF, 0xD8, 0x01, 0xFF, 0xD9])
    await capture.frameStore.update(
      .init(jpegData: second, sequence: 2, width: 100, height: 100))
    for step in 0..<8 {
      snapshots.set(
        SystemCursorSnapshot(
          image: image,
          position: CGPoint(x: 10 + step, y: 10)))
      stream.feed(cursorEncodings)
      stream.feed(clientFramebufferUpdateRequest(width: 100, height: 100))
    }
    try await waitFor { stream.outgoing.range(of: second) != nil }
    session.stop()
  }

  @Test
  func cursorReappearingAtSamePositionResendsPointerAfterHide() async throws {
    let descriptor = CapturedDisplayDescriptor(
      displayID: 1,
      displayBounds: CGRect(x: 0, y: 0, width: 100, height: 100),
      frameWidth: 100,
      frameHeight: 100,
      sourcePixelWidth: 200,
      sourcePixelHeight: 200)
    let image = SystemCursorImage(
      width: 2,
      height: 2,
      pointWidth: 2,
      pointHeight: 2,
      hotspot: CGPoint(x: 1, y: 1),
      rgba: Data([
        0xFF, 0, 0, 0xFF, 0, 0, 0xFF, 0xFF,
        0, 0xFF, 0, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF,
      ]),
      contentHash: Data([0xC0, 0xDE]))
    let visible = SystemCursorSnapshot(image: image, position: CGPoint(x: 75, y: 25))
    let hidden = SystemCursorSnapshot(image: nil, position: CGPoint(x: 75, y: 25))
    let snapshots = ThreadSafeSnapshotBox(visible)
    let capture = MacScreenCapture()
    await capture.frameStore.update(
      .init(jpegData: Data([0xFF, 0xD8, 0xFF, 0xD9]), sequence: 1, width: 100, height: 100))

    let cursorEncodings = clientSetEncodings([
      RFBWire.tightEncoding,
      RFBWire.cursorWithAlphaEncoding,
      RFBWire.pointerPositionEncoding,
    ])
    var incoming = RFBVersion.serverBanner
    incoming.append(contentsOf: [1, 1])  // None security, shared ClientInit.
    incoming.append(cursorEncodings)
    for _ in 0..<4 {
      incoming.append(clientFramebufferUpdateRequest(width: 100, height: 100))
    }

    let mappedImage = try #require(
      CursorCoordinateMapper.cursorImage(
        image,
        descriptor: descriptor,
        frameWidth: 100,
        frameHeight: 100))
    let mappedPosition = try #require(
      CursorCoordinateMapper.pointerPosition(
        visible.position,
        descriptor: descriptor,
        frameWidth: 100,
        frameHeight: 100))
    let shape = try RFBWire.cursorWithAlphaUpdate(image: mappedImage)
    let pointer = RFBWire.pointerPositionUpdate(x: mappedPosition.x, y: mappedPosition.y)
    let hiddenUpdate = RFBWire.hiddenCursorUpdate(encoding: .cursorWithAlpha)

    let stream = FeedableRFBByteStream(incoming: incoming)
    let finished = ThreadSafeFlag()
    let session = RFBHostSession(
      byteStream: stream,
      capture: capture,
      descriptor: descriptor,
      input: HandshakeRemoteInput(),
      clipboard: nil,
      remoteAddressOverride: "Crabfleet browser",
      skipTailnetCheck: true,
      desktopName: "Crabfleet — Cursor Hide Test",
      handshakeTimeout: .seconds(1),
      viewOnly: false,
      audioEnabled: false,
      qualityMode: .auto,
      cursorSnapshotProvider: { snapshots.value },
      captureOutputSizeUpdater: { _, _ in },
      didAuthorize: {},
      eventHandler: { _ in },
      didFinish: { _ in finished.set() })

    session.start()
    let clock = ContinuousClock()
    let deadline = clock.now.advanced(by: .seconds(2))
    func waitFor(_ predicate: @escaping () -> Bool) async throws {
      while !predicate(), clock.now < deadline {
        try await Task.sleep(for: .milliseconds(5))
      }
      #expect(predicate())
    }

    try await waitFor { stream.outgoing.range(of: pointer) != nil }
    // Re-sending identical SetEncodings force-resamples the cursor provider,
    // standing in for the 60 Hz monitor the loopback harness does not run.
    snapshots.set(hidden)
    stream.feed(cursorEncodings)
    for _ in 0..<3 {
      stream.feed(clientFramebufferUpdateRequest(width: 100, height: 100))
    }
    try await waitFor { stream.outgoing.range(of: hiddenUpdate) != nil }
    snapshots.set(visible)
    stream.feed(cursorEncodings)
    for _ in 0..<4 {
      stream.feed(clientFramebufferUpdateRequest(width: 100, height: 100))
    }
    try await waitFor { () -> Bool in
      let outgoing = stream.outgoing
      guard let hiddenRange = outgoing.range(of: hiddenUpdate) else { return false }
      return outgoing.range(of: pointer, in: hiddenRange.upperBound..<outgoing.endIndex) != nil
    }
    session.stop()

    let outgoing = stream.outgoing
    let firstShape = try #require(outgoing.range(of: shape))
    let firstPointer = try #require(
      outgoing.range(of: pointer, in: firstShape.upperBound..<outgoing.endIndex))
    let hiddenRange = try #require(
      outgoing.range(of: hiddenUpdate, in: firstPointer.upperBound..<outgoing.endIndex))
    let secondShape = try #require(
      outgoing.range(of: shape, in: hiddenRange.upperBound..<outgoing.endIndex))
    _ = try #require(
      outgoing.range(of: pointer, in: secondShape.upperBound..<outgoing.endIndex))
  }

  @Test
  func resizeReplaysStationaryCursorShapeAndPointerAtNewGeometry() async throws {
    let descriptor = CapturedDisplayDescriptor(
      displayID: 1,
      displayBounds: CGRect(x: 0, y: 0, width: 100, height: 100),
      frameWidth: 100,
      frameHeight: 100,
      sourcePixelWidth: 200,
      sourcePixelHeight: 200)
    let image = SystemCursorImage(
      width: 2,
      height: 2,
      pointWidth: 2,
      pointHeight: 2,
      hotspot: CGPoint(x: 1, y: 1),
      rgba: Data([
        0xFF, 0, 0, 0xFF, 0, 0, 0xFF, 0xFF,
        0, 0xFF, 0, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF,
      ]),
      contentHash: Data([0xC0, 0xDE]))
    let snapshot = SystemCursorSnapshot(
      image: image,
      position: CGPoint(x: 75, y: 25))
    let capture = MacScreenCapture()
    await capture.frameStore.update(
      .init(jpegData: Data([0xFF, 0xD8, 0xFF, 0xD9]), sequence: 1, width: 100, height: 100))

    var incoming = RFBVersion.serverBanner
    incoming.append(contentsOf: [1, 1])  // None security, shared ClientInit.
    incoming.append(
      clientSetEncodings([
        RFBWire.tightEncoding,
        RFBWire.cursorWithAlphaEncoding,
        RFBWire.pointerPositionEncoding,
        RFBWire.extendedDesktopSizeEncoding,
      ]))
    // Five requests per phase: announce, cursor shape, pointer, and slack for
    // the video turns the cursor/video fairness gate interleaves.
    for _ in 0..<5 {
      incoming.append(clientFramebufferUpdateRequest(width: 100, height: 100))
    }
    incoming.append(clientSetDesktopSize(width: 200, height: 200))
    for _ in 0..<5 {
      incoming.append(clientFramebufferUpdateRequest(width: 200, height: 200))
    }

    let initialImage = try #require(
      CursorCoordinateMapper.cursorImage(
        image,
        descriptor: descriptor,
        frameWidth: 100,
        frameHeight: 100))
    let resizedImage = try #require(
      CursorCoordinateMapper.cursorImage(
        image,
        descriptor: descriptor,
        frameWidth: 200,
        frameHeight: 200))
    let initialPosition = try #require(
      CursorCoordinateMapper.pointerPosition(
        snapshot.position,
        descriptor: descriptor,
        frameWidth: 100,
        frameHeight: 100))
    let resizedPosition = try #require(
      CursorCoordinateMapper.pointerPosition(
        snapshot.position,
        descriptor: descriptor,
        frameWidth: 200,
        frameHeight: 200))
    let initialShape = try RFBWire.cursorWithAlphaUpdate(image: initialImage)
    let resizedShape = try RFBWire.cursorWithAlphaUpdate(image: resizedImage)
    let initialPointer = RFBWire.pointerPositionUpdate(
      x: initialPosition.x,
      y: initialPosition.y)
    let resizedPointer = RFBWire.pointerPositionUpdate(
      x: resizedPosition.x,
      y: resizedPosition.y)

    let stream = InMemoryRFBByteStream(incoming: incoming)
    let finished = ThreadSafeFlag()
    let resizeCompletedAt = ThreadSafeTimestamp()
    let session = RFBHostSession(
      byteStream: stream,
      capture: capture,
      descriptor: descriptor,
      input: HandshakeRemoteInput(),
      clipboard: nil,
      remoteAddressOverride: "Crabfleet browser",
      skipTailnetCheck: true,
      desktopName: "Crabfleet — Cursor Resize Test",
      handshakeTimeout: .seconds(1),
      viewOnly: false,
      audioEnabled: false,
      qualityMode: .auto,
      cursorSnapshotProvider: { snapshot },
      captureOutputSizeUpdater: { width, height in
        await capture.frameStore.update(
          .init(
            jpegData: Data([0xFF, 0xD8, 0xFF, 0xD9]),
            sequence: 2,
            width: width,
            height: height))
        resizeCompletedAt.set(ProcessInfo.processInfo.systemUptime)
      },
      didAuthorize: {},
      eventHandler: { _ in },
      didFinish: { _ in finished.set() })

    let clock = ContinuousClock()
    let startedAt = clock.now
    session.start()
    let deadline = startedAt.advanced(by: .seconds(1))
    while stream.outgoing.range(of: resizedPointer) == nil, clock.now < deadline {
      try await Task.sleep(for: .milliseconds(5))
    }
    let deliveredAt = ProcessInfo.processInfo.systemUptime
    session.stop()

    let outgoing = stream.outgoing
    let initialShapeRange = try #require(outgoing.range(of: initialShape))
    let initialPointerRange = try #require(
      outgoing.range(of: initialPointer, in: initialShapeRange.upperBound..<outgoing.endIndex))
    let resizedShapeRange = try #require(
      outgoing.range(of: resizedShape, in: initialPointerRange.upperBound..<outgoing.endIndex))
    _ = try #require(
      outgoing.range(of: resizedPointer, in: resizedShapeRange.upperBound..<outgoing.endIndex))
    #expect(initialImage.width == 2)
    #expect(resizedImage.width == 4)
    #expect(initialPosition.x == 74)
    #expect(initialPosition.y == 25)
    #expect(resizedPosition.x == 149)
    #expect(resizedPosition.y == 50)
    let resizeTimestamp = try #require(resizeCompletedAt.value)
    #expect(deliveredAt - resizeTimestamp < 0.25)

    let finishDeadline = clock.now.advanced(by: .seconds(1))
    while !finished.value, clock.now < finishDeadline {
      try await Task.sleep(for: .milliseconds(5))
    }
    #expect(finished.value)
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

private func clientSetEncodings(_ encodings: [Int32]) -> Data {
  var message = Data([2, 0])
  message.appendBigEndian(UInt16(encodings.count))
  for encoding in encodings { message.appendBigEndian(encoding) }
  return message
}

private func clientFramebufferUpdateRequest(width: UInt16, height: UInt16) -> Data {
  var message = Data([3, 1])
  message.appendBigEndian(UInt16(0))
  message.appendBigEndian(UInt16(0))
  message.appendBigEndian(width)
  message.appendBigEndian(height)
  return message
}

private func clientSetDesktopSize(width: UInt16, height: UInt16) -> Data {
  var message = Data([251, 0])
  message.appendBigEndian(width)
  message.appendBigEndian(height)
  message.append(contentsOf: [1, 0])
  message.appendBigEndian(UInt32(0))  // Screen ID.
  message.appendBigEndian(UInt16(0))
  message.appendBigEndian(UInt16(0))
  message.appendBigEndian(width)
  message.appendBigEndian(height)
  message.appendBigEndian(UInt32(0))  // Flags.
  return message
}

private final class FeedableRFBByteStream: RFBByteStream, @unchecked Sendable {
  private let lock = NSLock()
  private var incoming = Data()
  private var sent = Data()

  init(incoming: Data = Data()) {
    self.incoming = incoming
  }

  var outgoing: Data {
    lock.lock()
    defer { lock.unlock() }
    return sent
  }

  func feed(_ data: Data) {
    lock.lock()
    incoming.append(data)
    lock.unlock()
  }

  func readExactly(_ count: Int) async throws -> Data {
    guard count >= 0 else {
      throw PrivateMacShareError.protocolError("in-memory stream ended")
    }
    while true {
      let chunk: Data? = {
        lock.lock()
        defer { lock.unlock() }
        guard incoming.count >= count else { return nil }
        let result = incoming.prefix(count)
        incoming.removeFirst(count)
        return Data(result)
      }()
      if let chunk { return chunk }
      try await Task.sleep(for: .milliseconds(2))
    }
  }

  func send(_ data: Data) async throws {
    lock.lock()
    sent.append(data)
    lock.unlock()
  }

  func send(_ data: Data, deadline: ContinuousClock.Instant?) async throws {
    if let deadline, ContinuousClock().now >= deadline { throw RFBSendExpiredError() }
    try await send(data)
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

@MainActor
struct CursorVisibilityProbeTests {
  @Test
  func systemCursorVisibilityProbeResolves() {
    // The probe resolves the deprecated-but-exported CGCursorIsVisible symbol
    // at runtime. If this expectation ever fails, macOS dropped the symbol and
    // hidden-cursor suppression silently degrades to always-visible.
    #expect(MacCursorMonitor.systemCursorVisibility != nil)
  }
}

private final class ThreadSafeSnapshotBox: @unchecked Sendable {
  private let lock = NSLock()
  private var storage: SystemCursorSnapshot

  init(_ value: SystemCursorSnapshot) {
    storage = value
  }

  var value: SystemCursorSnapshot {
    lock.lock()
    defer { lock.unlock() }
    return storage
  }

  func set(_ value: SystemCursorSnapshot) {
    lock.lock()
    storage = value
    lock.unlock()
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

private final class ThreadSafeTimestamp: @unchecked Sendable {
  private let lock = NSLock()
  private var storage: TimeInterval?

  var value: TimeInterval? {
    lock.lock()
    defer { lock.unlock() }
    return storage
  }

  func set(_ value: TimeInterval) {
    lock.lock()
    storage = value
    lock.unlock()
  }
}
