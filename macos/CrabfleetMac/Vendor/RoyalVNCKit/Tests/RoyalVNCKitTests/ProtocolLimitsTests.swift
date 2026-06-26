import Foundation
import Testing

#if os(macOS)
import AppKit
#endif

@testable import RoyalVNCKit

struct ProtocolLimitsTests {
  @Test
  func negotiatesSupportedRFBVersionsWithoutUsingTheWrongSecurityFraming() {
    let maximum = VNCProtocol.ProtocolVersion(majorVersion: 3, minorVersion: 8)

    let legacy = VNCProtocol.ProtocolVersion(majorVersion: 3, minorVersion: 3)
      .compatibleClientVersion(maximumSupported: maximum)
    #expect(legacy?.minorVersion == 3)
    #expect(legacy?.usesLegacySecurityHandshake == true)

    let intermediate = VNCProtocol.ProtocolVersion(majorVersion: 3, minorVersion: 6)
      .compatibleClientVersion(maximumSupported: maximum)
    #expect(intermediate?.minorVersion == 3)
    #expect(intermediate?.usesLegacySecurityHandshake == true)

    #expect(
      VNCProtocol.ProtocolVersion(majorVersion: 3, minorVersion: 7)
        .compatibleClientVersion(maximumSupported: maximum)?.minorVersion == 7
    )
    #expect(
      VNCProtocol.ProtocolVersion(majorVersion: 3, minorVersion: 889)
        .compatibleClientVersion(maximumSupported: maximum)?.minorVersion == 8
    )
    #expect(
      VNCProtocol.ProtocolVersion(majorVersion: 3, minorVersion: 2)
        .compatibleClientVersion(maximumSupported: maximum) == nil
    )
  }

  @Test
  func receivesLegacyRFB33SecurityTypeAsFourByteServerSelection() async throws {
    var rawValue = UInt32(VNCProtocol.SecurityType.none.rawValue).bigEndian
    let data = withUnsafeBytes(of: &rawValue) { Data($0) }
    let connection = BufferConnection(data)

    let securityType = try await VNCProtocol.SecurityTypes.receiveLegacy(connection: connection)

    #expect(securityType == .none)
  }

  @Test
  func prefersAppleRemoteDesktopAuthenticationWhenTheServerOffersIt() throws {
    let macOSScreenSharing = try #require(
      VNCProtocol.SecurityTypes(data: Data([30, 33, 36, 35]))
    )
    #expect(macOSScreenSharing.preferredClientSecurityType == .diffieHellman)

    let conventionalVNC = try #require(VNCProtocol.SecurityTypes(data: Data([1, 2])))
    #expect(conventionalVNC.preferredClientSecurityType == .vnc)

    let passwordless = try #require(VNCProtocol.SecurityTypes(data: Data([1])))
    #expect(passwordless.preferredClientSecurityType == VNCProtocol.SecurityType.none)

    let unsupported = try #require(VNCProtocol.SecurityTypes(data: Data([33, 36, 35])))
    #expect(unsupported.preferredClientSecurityType == nil)
  }

  @Test
  func rejectsUnsupportedAppleRemoteDesktopKeySizesBeforeReadingKeyMaterial() async {
    var generator = UInt16(2).bigEndian
    var oversizedKey = UInt16.max.bigEndian
    var data = Data()
    withUnsafeBytes(of: &generator) { data.append(contentsOf: $0) }
    withUnsafeBytes(of: &oversizedKey) { data.append(contentsOf: $0) }

    await #expect(throws: (any Error).self) {
      try await VNCProtocol.ARDAuthentication.receive(connection: BufferConnection(data))
    }
  }

  @Test
  func acceptsBoundedVariableAppleRemoteDesktopKeySizes() async throws {
    let keySize = UInt16(256)
    var generator = UInt16(2).bigEndian
    var wireKeySize = keySize.bigEndian
    var data = Data()
    withUnsafeBytes(of: &generator) { data.append(contentsOf: $0) }
    withUnsafeBytes(of: &wireKeySize) { data.append(contentsOf: $0) }
    data.append(Data(repeating: 0xA5, count: Int(keySize)))
    data.append(Data(repeating: 0x5A, count: Int(keySize)))

    let authentication = try await VNCProtocol.ARDAuthentication.receive(
      connection: BufferConnection(data)
    )

    #expect(authentication.keySize == keySize)
    #expect(authentication.prime.count == Int(keySize))
    #expect(authentication.peerKey.count == Int(keySize))
  }

  @Test
  func capsAppleRemoteDesktopCredentialsAtValidUTF8Boundaries() {
    let ascii = VNCProtocol.ARDAuthentication.Authentication.credentialBytes(
      for: String(repeating: "a", count: 80)
    )
    #expect(ascii.count == 63)

    let multibyte = VNCProtocol.ARDAuthentication.Authentication.credentialBytes(
      for: String(repeating: "🦀", count: 16)
    )
    #expect(multibyte.count == 60)
    #expect(String(data: multibyte, encoding: .utf8) == String(repeating: "🦀", count: 15))
  }

  @Test
  func padsAppleRemoteDesktopDHValuesToTheAdvertisedWireWidth() {
    let shortKey = Data([0x12, 0x34])
    #expect(
      VNCProtocol.ARDAuthentication.DiffieHellmanKeyAgreement.leftPadded(shortKey, to: 4)
        == Data([0, 0, 0x12, 0x34])
    )
    #expect(
      VNCProtocol.ARDAuthentication.DiffieHellmanKeyAgreement.leftPadded(shortKey, to: 1)
        == nil
    )

    let shortSharedSecret = Data([0xAB])
    #expect(
      VNCProtocol.ARDAuthentication.DiffieHellmanKeyAgreement.leftPadded(
        shortSharedSecret,
        to: 4
      ) == Data([0, 0, 0, 0xAB])
    )
  }

  @Test
  func rejectsUnknownLegacyRFB33SecurityType() async {
    var rawValue = UInt32(99).bigEndian
    let data = withUnsafeBytes(of: &rawValue) { Data($0) }
    let connection = BufferConnection(data)

    await #expect(throws: (any Error).self) {
      try await VNCProtocol.SecurityTypes.receiveLegacy(connection: connection)
    }
  }

  @Test
  func rejectsColourMapRangesOutsideTheProtocolIndexSpace() async {
    var firstColour = UInt16.max.bigEndian
    var numberOfColours = UInt16(2).bigEndian
    var data = Data([0])
    withUnsafeBytes(of: &firstColour) { data.append(contentsOf: $0) }
    withUnsafeBytes(of: &numberOfColours) { data.append(contentsOf: $0) }
    let connection = BufferConnection(data)

    await #expect(throws: (any Error).self) {
      try await VNCProtocol.SetColourMapEntries.receive(
        connection: connection,
        logger: VNCPrintLogger()
      )
    }
  }

  @Test
  func appliesColourMapEntriesAtTheirAdvertisedOffset() {
    let first = VNCProtocol.SetColourMapEntries(
      messageType: VNCProtocol.SetColourMapEntries.messageType,
      firstColour: 4,
      colors: [.init(red: 65_535, green: 0, blue: 0)]
    )
    let second = VNCProtocol.SetColourMapEntries(
      messageType: VNCProtocol.SetColourMapEntries.messageType,
      firstColour: 5,
      colors: [.init(red: 0, green: 65_535, blue: 0)]
    )

    let initial = VNCFramebuffer.ColorMap(entries: first)
    let updated = VNCFramebuffer.ColorMap(entries: second, existing: initial)

    #expect(updated.colorAt(0) == nil)
    #expect(updated.colorAt(4)?.red == 255)
    #expect(updated.colorAt(5)?.green == 255)
  }

  @Test
  func rejectsOversizedClipboardMessages() async {
    let oversizedLength = UInt32(VNCProtocolLimits.maximumClipboardBytes + 1)
    let connection = BufferConnection(serverCutTextHeader(length: oversizedLength))

    await #expect(throws: (any Error).self) {
      try await VNCProtocol.ServerCutText.receive(connection: connection, logger: VNCPrintLogger())
    }
  }

  @Test
  func rejectsMinimumSignedClipboardLength() async {
    let connection = BufferConnection(serverCutTextHeader(length: 0x8000_0000))

    await #expect(throws: (any Error).self) {
      try await VNCProtocol.ServerCutText.receive(connection: connection, logger: VNCPrintLogger())
    }
  }

  @Test
  func rejectsUnadvertisedExtendedClipboardMessages() async {
    let negativeLength = UInt32(bitPattern: Int32(-8))
    let connection = BufferConnection(serverCutTextHeader(length: negativeLength))

    await #expect(throws: (any Error).self) {
      try await VNCProtocol.ServerCutText.receive(connection: connection, logger: VNCPrintLogger())
    }
  }

  @Test
  func boundsAndLosslesslyEncodesOutgoingClipboardMessages() {
    let maximumText = String(repeating: "a", count: VNCProtocolLimits.maximumClipboardBytes)
    let message = VNCProtocol.ClientCutText(text: maximumText)

    #expect(message?.textData.count == VNCProtocolLimits.maximumClipboardBytes)
    #expect(message?.data.count == VNCProtocolLimits.maximumClipboardBytes + 8)
    #expect(
      VNCProtocol.ClientCutText(
        text: maximumText + "a"
      ) == nil
    )
    #expect(VNCProtocol.ClientCutText(text: "emoji 🔐") == nil)
  }

  @Test @MainActor
  func externallyManagedClipboardRoutesWithoutPasteboardPolling() async throws {
    let settings = VNCConnection.Settings(
      isDebugLoggingEnabled: false,
      hostname: "127.0.0.1",
      port: 5900,
      isShared: true,
      isScalingEnabled: true,
      useDisplayLink: false,
      inputMode: .none,
      clipboardMode: .externallyManaged,
      colorDepth: .depth24Bit,
      frameEncodings: [.raw]
    )
    let connection = VNCConnection(settings: settings)
    let delegate = ClipboardConnectionDelegateRecorder()
    connection.clipboardDelegate = delegate
    connection.connectionState = .connected

    connection.startMonitoringClipboard()
    try await Task.sleep(nanoseconds: 20_000_000)
    #expect(!connection.clipboardMonitor.isMonitoring)

    try connection.sendClipboardText("local text")
    let queued = connection.clientToServerMessageQueue.dequeue()?.message
      as? VNCProtocol.ClientCutText
    #expect(queued?.textData == Data("local text".utf8))

    #expect(throws: VNCClipboardError.unsupportedCharacters) {
      try connection.sendClipboardText("emoji 🔐")
    }
    #expect(throws: VNCClipboardError.payloadTooLarge(maximumBytes: 1_048_576)) {
      try connection.sendClipboardText(String(repeating: "a", count: 1_048_577))
    }

    connection.notifyClipboardDelegateAboutText("remote text")
    try await Task.sleep(nanoseconds: 20_000_000)
    #expect(delegate.receivedTexts == ["remote text"])
  }

  @Test @MainActor
  func coalescesExternallyManagedClipboardDeliveryOnMainActor() async throws {
    let settings = VNCConnection.Settings(
      isDebugLoggingEnabled: false,
      hostname: "127.0.0.1",
      port: 5900,
      isShared: true,
      isScalingEnabled: true,
      useDisplayLink: false,
      inputMode: .none,
      clipboardMode: .externallyManaged,
      colorDepth: .depth24Bit,
      frameEncodings: [.raw]
    )
    let connection = VNCConnection(settings: settings)
    let delegate = ClipboardConnectionDelegateRecorder()
    connection.clipboardDelegate = delegate

    for index in 0..<1_000 {
      connection.notifyClipboardDelegateAboutText("remote-\(index)")
    }

    try await Task.sleep(nanoseconds: 30_000_000)
    #expect(delegate.receivedTexts == ["remote-999"])
  }

  @Test
  func continuousUpdatesCapabilityMarkerPreservesOutstandingRequest() {
    let settings = VNCConnection.Settings(
      isDebugLoggingEnabled: false,
      hostname: "127.0.0.1",
      port: 5900,
      isShared: true,
      isScalingEnabled: true,
      useDisplayLink: false,
      inputMode: .none,
      isClipboardRedirectionEnabled: false,
      colorDepth: .depth24Bit,
      frameEncodings: [.raw]
    )
    let connection = VNCConnection(settings: settings)
    connection.framebufferUpdateRequestOutstanding = true

    connection.didReceiveEndOfContinuousUpdates()

    #expect(connection.state.areContinuousUpdatesSupported)
    #expect(connection.framebufferUpdateRequestOutstanding)
  }

  @Test
  func dataStreamChecksBoundsInReleaseBuilds() {
    let stream = DataStream(data: Data([1, 2, 3]))

    #expect(throws: (any Error).self) {
      try stream.read(length: 4)
    }
  }

  @Test
  func rejectsUnrepresentableVNCPasswords() {
    #expect(VNCDESEncryption.encrypt(data: Data(repeating: 0, count: 16), key: "🔐") == nil)
  }

  @Test
  func serializesConcurrentQueueAndDisconnectAccess() {
    let queue = Queue<Int>()
    DispatchQueue.concurrentPerform(iterations: 5_000) { queue.enqueue($0) }

    var values = Set<Int>()
    while let value = queue.dequeue() {
      values.insert(value)
    }
    #expect(values.count == 5_000)

    let state = VNCConnection.State()
    let lock = NSLock()
    var disconnectWinners = 0
    DispatchQueue.concurrentPerform(iterations: 100) { _ in
      if state.requestDisconnect() {
        lock.lock()
        disconnectWinners += 1
        lock.unlock()
      }
    }
    #expect(disconnectWinners == 1)
  }

  @Test
  func asyncQueueWakesForMessagesAndFinish() async {
    let messageQueue = Queue<Int>()
    let messageTask = Task { await messageQueue.next() }
    messageQueue.enqueue(42)
    #expect(await messageTask.value == 42)

    let finishQueue = Queue<Int>()
    let finishTask = Task { await finishQueue.next() }
    finishQueue.finish()
    #expect(await finishTask.value == nil)

    let coalescingQueue = Queue<Int>()
    coalescingQueue.enqueue(1)
    coalescingQueue.enqueue(2, coalescingLastWhere: { $0 == 1 })
    #expect(coalescingQueue.dequeue() == 2)
    #expect(coalescingQueue.dequeue() == nil)
  }

  @Test
  func pointerMotionCoalescingPreservesButtonBoundaries() {
    let settings = VNCConnection.Settings(
      isDebugLoggingEnabled: false,
      hostname: "127.0.0.1",
      port: 5900,
      isShared: true,
      isScalingEnabled: true,
      useDisplayLink: false,
      inputMode: .forwardKeyboardShortcutsIfNotInUseLocally,
      isClipboardRedirectionEnabled: false,
      colorDepth: .depth24Bit,
      frameEncodings: [.raw]
    )
    let connection = VNCConnection(settings: settings)

    connection.enqueueMouseEvent(
      buttons: .left,
      position: .init(x: 10, y: 10),
      coalescible: false
    )
    connection.enqueueMouseEvent(
      buttons: .left,
      position: .init(x: 20, y: 20),
      coalescible: true
    )
    connection.enqueueMouseEvent(
      buttons: .left,
      position: .init(x: 30, y: 30),
      coalescible: true
    )
    connection.enqueueMouseEvent(
      buttons: [],
      position: .init(x: 40, y: 40),
      coalescible: false
    )
    connection.enqueueMouseEvent(
      buttons: [],
      position: .init(x: 50, y: 50),
      coalescible: true
    )
    connection.enqueueMouseEvent(
      buttons: [],
      position: .init(x: 60, y: 60),
      coalescible: true
    )

    var events = [VNCProtocol.PointerEvent]()
    while let item = connection.clientToServerMessageQueue.dequeue() {
      if let event = item.message as? VNCProtocol.PointerEvent {
        events.append(event)
      }
    }

    #expect(events.map(\.xPosition) == [10, 30, 40, 60])
    #expect(events.map(\.buttonMask) == [1, 1, 0, 0])
  }

  @Test
  func disconnectedHandshakeCannotRegressToConnected() {
    let settings = VNCConnection.Settings(
      isDebugLoggingEnabled: false,
      hostname: "127.0.0.1",
      port: 5900,
      isShared: true,
      isScalingEnabled: true,
      useDisplayLink: false,
      inputMode: .none,
      isClipboardRedirectionEnabled: false,
      colorDepth: .depth24Bit,
      frameEncodings: [.raw]
    )
    let connection = VNCConnection(settings: settings)

    connection.disconnect()
    connection.finishConnectingAfterHandshake()

    #expect(connection.connectionState.status == .disconnected)
  }

  @Test @MainActor
  func coalescesFramebufferDeliveryOnMainActor() async throws {
    let settings = VNCConnection.Settings(
      isDebugLoggingEnabled: false,
      hostname: "127.0.0.1",
      port: 5900,
      isShared: true,
      isScalingEnabled: true,
      useDisplayLink: false,
      inputMode: .none,
      isClipboardRedirectionEnabled: false,
      colorDepth: .depth24Bit,
      frameEncodings: [.raw]
    )
    let connection = VNCConnection(settings: settings)
    let delegate = ConnectionDelegateRecorder()
    connection.delegate = delegate
    let framebuffer = try VNCFramebuffer(
      logger: VNCPrintLogger(),
      size: VNCSize(width: 8, height: 8),
      screens: [],
      pixelFormat: VNCProtocol.PixelFormat(depth: 24),
      allocator: nil
    )

    for _ in 0..<1_000 {
      connection.notifyDelegateAboutFramebuffer(
        framebuffer,
        updatedRegion: framebuffer.fullRegion
      )
    }

    try await Task.sleep(nanoseconds: 30_000_000)
    #expect(delegate.framebufferUpdates == 1)
  }

#if os(macOS)
  @Test @MainActor
  func suppressesRemoteClipboardEchoAndCancelsPendingStarts() async throws {
    let pasteboard = NSPasteboard(name: .init("RoyalVNCKitTests.\(UUID().uuidString)"))
    let clipboard = VNCClipboard(pasteboard: pasteboard)
    let monitor = VNCClipboardMonitor(
      clipboard: clipboard,
      monitoringInterval: 0.01,
      tolerance: 0
    )
    let delegate = ClipboardDelegate()
    monitor.delegate = delegate

    monitor.startMonitoring()
    clipboard.text = "remote"
    monitor.markCurrentChangeAsObserved()
    try await Task.sleep(nanoseconds: 40_000_000)
    #expect(delegate.receivedTexts.isEmpty)

    clipboard.text = "local"
    try await Task.sleep(nanoseconds: 40_000_000)
    #expect(delegate.receivedTexts == ["local"])

    monitor.stopMonitoring()
    monitor.startMonitoring()
    monitor.stopMonitoring()
    try await Task.sleep(nanoseconds: 20_000_000)
    #expect(!monitor.isMonitoring)
  }
#endif

  private func serverCutTextHeader(length: UInt32) -> Data {
    var bigEndianLength = length.bigEndian
    var data = Data([0, 0, 0])
    withUnsafeBytes(of: &bigEndianLength) { data.append(contentsOf: $0) }
    return data
  }
}

#if os(macOS)
private final class ClipboardDelegate: VNCClipboardMonitorDelegate {
  var receivedTexts = [String]()

  func clipboardMonitorShouldMonitor(_ clipboardMonitor: VNCClipboardMonitor) -> Bool {
    true
  }

  func clipboardMonitor(_ clipboardMonitor: VNCClipboardMonitor, didChangeText text: String) {
    receivedTexts.append(text)
  }
}

@MainActor
private final class ConnectionDelegateRecorder: VNCConnectionDelegate {
  var framebufferUpdates = 0

  func connection(
    _ connection: VNCConnection,
    stateDidChange connectionState: VNCConnection.ConnectionState
  ) {}

  func connection(
    _ connection: VNCConnection,
    credentialFor authenticationType: VNCAuthenticationType,
    completion: @escaping (VNCCredential?) -> Void
  ) {
    completion(nil)
  }

  func connection(_ connection: VNCConnection, didCreateFramebuffer framebuffer: VNCFramebuffer) {}
  func connection(_ connection: VNCConnection, didResizeFramebuffer framebuffer: VNCFramebuffer) {}

  func connection(
    _ connection: VNCConnection,
    didUpdateFramebuffer framebuffer: VNCFramebuffer,
    x: UInt16,
    y: UInt16,
    width: UInt16,
    height: UInt16
  ) {
    framebufferUpdates += 1
  }

  func connection(_ connection: VNCConnection, didUpdateCursor cursor: VNCCursor) {}
}

@MainActor
private final class ClipboardConnectionDelegateRecorder: VNCClipboardDelegate {
  var receivedTexts = [String]()

  func connection(_ connection: VNCConnection, didReceiveClipboardText text: String) {
    receivedTexts.append(text)
  }
}
#endif

private final class BufferConnection: NetworkConnectionReading {
  private let data: Data
  private var offset = 0

  init(_ data: Data) {
    self.data = data
  }

  func read(minimumLength: Int, maximumLength: Int) async throws -> Data {
    let remaining = data.count - offset
    guard minimumLength > 0, maximumLength >= minimumLength, remaining >= minimumLength else {
      throw VNCError.protocol(.noData)
    }

    let count = min(maximumLength, remaining)
    defer { offset += count }
    return data.subdata(in: offset..<(offset + count))
  }
}
