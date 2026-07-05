import Foundation
import Network
import RoyalVNCKit

enum TailnetRFBServerEvent: Equatable, Sendable {
  case listening
  case authorizing(String)
  case connected(String)
  case disconnected
  case listenerFailed(String)
  case sessionFailed(String)
}

final class TailnetRFBServer: @unchecked Sendable {
  typealias EventHandler = @Sendable (TailnetRFBServerEvent) -> Void

  private let identity: TailnetIdentity
  private let runner: any TailscaleCommandRunning
  private let capture: MacScreenCapture
  private let descriptor: CapturedDisplayDescriptor
  private let input: any RemoteInputForwarding
  private let clipboard: (any HostClipboardSyncing)?
  private let peerAuthorizer: (any TailnetPeerAuthorizing)?
  private let port: UInt16
  private let queue = DispatchQueue(label: "org.openclaw.crabfleet.rfb-listener")
  private let lock = NSLock()
  private let eventHandler: EventHandler
  private var listener: NWListener?
  private var session: RFBHostSession?

  init(
    identity: TailnetIdentity,
    runner: any TailscaleCommandRunning,
    capture: MacScreenCapture,
    descriptor: CapturedDisplayDescriptor,
    input: any RemoteInputForwarding,
    clipboard: (any HostClipboardSyncing)? = nil,
    peerAuthorizer: (any TailnetPeerAuthorizing)? = nil,
    port: UInt16,
    eventHandler: @escaping EventHandler
  ) {
    self.identity = identity
    self.runner = runner
    self.capture = capture
    self.descriptor = descriptor
    self.input = input
    self.clipboard = clipboard
    self.peerAuthorizer = peerAuthorizer
    self.port = port
    self.eventHandler = eventHandler
  }

  func start() throws {
    // A listener with `requiredLocalEndpoint` hands out child connections
    // that re-bind that endpoint and fail with EADDRINUSE on current macOS,
    // so the port binds wide and every accepted connection must instead prove
    // it arrived on the expected local address before any protocol bytes.
    let parameters = NWParameters.tcp
    parameters.allowLocalEndpointReuse = true
    guard let listenerPort = NWEndpoint.Port(rawValue: port) else {
      throw PrivateMacShareError.listenerFailed("invalid port")
    }
    let listener = try NWListener(using: parameters, on: listenerPort)
    listener.stateUpdateHandler = { [weak self] state in
      guard let self else { return }
      switch state {
      case .ready:
        eventHandler(.listening)
      case .failed(let error):
        eventHandler(.listenerFailed(error.localizedDescription))
      case .cancelled:
        break
      default:
        break
      }
    }
    listener.newConnectionHandler = { [weak self] connection in
      self?.accept(connection)
    }
    self.listener = listener
    listener.start(queue: queue)
  }

  func stop() {
    let values = withLock { () -> (NWListener?, RFBHostSession?) in
      defer {
        listener = nil
        session = nil
      }
      return (listener, session)
    }
    values.0?.cancel()
    values.1?.stop()
    capture.setConsumerActive(false)
  }

  private func accept(_ connection: NWConnection) {
    let hasActiveSession = withLock { self.session != nil }
    guard !hasActiveSession else {
      connection.cancel()
      return
    }

    let authorizer =
      peerAuthorizer
      ?? TailnetPeerAuthorizer(
        runner: runner,
        expectedIdentity: identity
      )
    let newSession = RFBHostSession(
      connection: connection,
      authorizer: authorizer,
      capture: capture,
      descriptor: descriptor,
      input: input,
      clipboard: clipboard,
      requiredLocalAddress: identity.ipv4Address,
      desktopName: "Crabfleet — \(identity.hostName)",
      didAuthorize: { [weak capture] in capture?.setConsumerActive(true) },
      eventHandler: eventHandler,
      didFinish: { [weak self] finishedSession in
        self?.clear(finishedSession)
      }
    )
    withLock { self.session = newSession }
    newSession.start()
  }

  private func clear(_ finishedSession: RFBHostSession) {
    withLock {
      if session === finishedSession {
        session = nil
        capture.setConsumerActive(false)
      }
    }
  }

  private func withLock<T>(_ body: () -> T) -> T {
    lock.lock()
    defer { lock.unlock() }
    return body()
  }
}

private final class RFBHostSession: @unchecked Sendable {
  private let connection: NWConnection
  private let authorizer: any TailnetPeerAuthorizing
  private let capture: MacScreenCapture
  private let descriptor: CapturedDisplayDescriptor
  private let input: any RemoteInputForwarding
  private let clipboard: (any HostClipboardSyncing)?
  private let requiredLocalAddress: String
  private let desktopName: String
  private let didAuthorize: @Sendable () -> Void
  private let queue = DispatchQueue(label: "org.openclaw.crabfleet.rfb-session")
  private let eventHandler: TailnetRFBServer.EventHandler
  private let didFinish: @Sendable (RFBHostSession) -> Void
  private let lock = NSLock()
  private var started = false
  private var finished = false
  private var task: Task<Void, Never>?
  private var pushIO: RFBConnectionIO?

  // Negotiated per-connection state; only the protocol task mutates it.
  private var supportsTightEncoding = false
  private var supportsExtendedDesktopSize = false
  private var supportsExtendedClipboard = false
  private var sentServerClipboardCaps = false
  private var needsDesktopSizeAnnounce = false
  private var clientClipboardCaps: VNCExtendedClipboardCaps?
  private var currentWidth: Int
  private var currentHeight: Int

  init(
    connection: NWConnection,
    authorizer: any TailnetPeerAuthorizing,
    capture: MacScreenCapture,
    descriptor: CapturedDisplayDescriptor,
    input: any RemoteInputForwarding,
    clipboard: (any HostClipboardSyncing)?,
    requiredLocalAddress: String,
    desktopName: String,
    didAuthorize: @escaping @Sendable () -> Void,
    eventHandler: @escaping TailnetRFBServer.EventHandler,
    didFinish: @escaping @Sendable (RFBHostSession) -> Void
  ) {
    self.connection = connection
    self.authorizer = authorizer
    self.capture = capture
    self.descriptor = descriptor
    self.input = input
    self.clipboard = clipboard
    self.requiredLocalAddress = requiredLocalAddress
    self.desktopName = desktopName
    self.didAuthorize = didAuthorize
    self.eventHandler = eventHandler
    self.didFinish = didFinish
    currentWidth = descriptor.frameWidth
    currentHeight = descriptor.frameHeight
  }

  func start() {
    connection.stateUpdateHandler = { [weak self] state in
      guard let self else { return }
      switch state {
      case .ready:
        beginProtocolIfNeeded()
      case .failed(let error):
        finish(event: .sessionFailed(error.localizedDescription))
      case .cancelled:
        finish(event: .disconnected)
      default:
        break
      }
    }
    connection.start(queue: queue)
  }

  func stop() {
    task?.cancel()
    connection.cancel()
    finish(event: .disconnected)
  }

  private func beginProtocolIfNeeded() {
    lock.lock()
    guard !started else {
      lock.unlock()
      return
    }
    started = true
    lock.unlock()

    task = Task { [weak self] in
      guard let self else { return }
      do {
        try await runProtocol()
        finish(event: .disconnected)
      } catch is CancellationError {
        finish(event: .disconnected)
      } catch {
        finish(event: .sessionFailed(error.localizedDescription))
      }
    }
  }

  private func runProtocol() async throws {
    guard let remoteAddress = Self.address(from: connection.endpoint) else {
      throw PrivateMacShareError.protocolError("missing peer address")
    }

    // The wide port bind accepts connections from any interface; only the
    // shared address may proceed, checked before any protocol bytes go out.
    guard let localAddress = Self.address(from: connection.currentPath?.localEndpoint),
      localAddress == requiredLocalAddress
    else {
      throw PrivateMacShareError.protocolError(
        "connection did not arrive on the shared tailnet address")
    }

    eventHandler(.authorizing(remoteAddress))
    let isAuthorized = await authorizer.authorize(remoteAddress: remoteAddress)
    try Task.checkCancellation()
    guard isAuthorized else {
      throw PrivateMacShareError.protocolError("peer is not another device for this Tailscale user")
    }
    didAuthorize()

    let io = RFBConnectionIO(connection: connection)
    try await handshake(io: io)
    withLock { pushIO = io }
    attachClipboard()
    eventHandler(.connected(remoteAddress))
    try await messageLoop(io: io)
  }

  private func handshake(io: RFBConnectionIO) async throws {
    try await io.send(RFBVersion.serverBanner)
    let clientBanner = try await io.readExactly(12)
    guard let version = RFBVersion(banner: clientBanner) else {
      throw PrivateMacShareError.protocolError("unsupported RFB version")
    }

    if version == .v3Point3 {
      var security = Data()
      security.appendBigEndian(UInt32(1))
      try await io.send(security)
    } else {
      try await io.send(Data([1, 1]))
      guard try await io.readUInt8() == 1 else {
        throw PrivateMacShareError.protocolError("unsupported security selection")
      }
      if version >= .v3Point8 {
        var securityResult = Data()
        securityResult.appendBigEndian(UInt32(0))
        try await io.send(securityResult)
      }
    }

    _ = try await io.readUInt8()  // ClientInit shared flag
    try await io.send(
      try RFBWire.serverInit(
        width: currentWidth,
        height: currentHeight,
        name: desktopName
      ))
  }

  private func messageLoop(io: RFBConnectionIO) async throws {
    var hasSentFrame = false

    while !Task.isCancelled {
      let messageType = try await io.readUInt8()
      switch messageType {
      case 0:  // SetPixelFormat
        let payload = try await io.readExactly(19)
        let format = RFBPixelFormat(data: Data(payload[3..<19]))
        guard format == .bgra8888 else {
          throw PrivateMacShareError.protocolError("only 24-bit true-color pixels are supported")
        }

      case 2:  // SetEncodings
        let header = try await io.readExactly(3)
        let count = Int(header.readUInt16(at: 1))
        guard count <= 256 else {
          throw PrivateMacShareError.protocolError("too many requested encodings")
        }
        let encodingData = try await io.readExactly(count * 4)
        let encodings = (0..<count).map { encodingData.readInt32(at: $0 * 4) }
        supportsTightEncoding = encodings.contains(RFBWire.tightEncoding)
        if encodings.contains(RFBWire.extendedDesktopSizeEncoding),
          !supportsExtendedDesktopSize
        {
          supportsExtendedDesktopSize = true
          needsDesktopSizeAnnounce = true
        }
        withLock {
          supportsExtendedClipboard = encodings.contains(RFBWire.extendedClipboardEncoding)
        }
        try await sendServerClipboardCapsIfNeeded(io: io)

      case 3:  // FramebufferUpdateRequest
        _ = try await io.readExactly(9)
        guard supportsTightEncoding else {
          throw PrivateMacShareError.protocolError("the client did not offer Tight encoding")
        }
        if needsDesktopSizeAnnounce {
          needsDesktopSizeAnnounce = false
          try await io.send(
            try RFBWire.extendedDesktopSizeUpdate(
              reason: 0,
              status: 0,
              width: currentWidth,
              height: currentHeight
            ))
        }
        if hasSentFrame {
          try await Task.sleep(for: .milliseconds(66))
        }
        let frame = try await waitForMatchingFrame()
        try await io.send(try RFBWire.tightJPEGUpdate(frame: frame))
        hasSentFrame = true

      case 4:  // KeyEvent
        let payload = try await io.readExactly(7)
        input.keyEvent(down: payload[0] != 0, keysym: payload.readUInt32(at: 3))

      case 5:  // PointerEvent
        let payload = try await io.readExactly(5)
        input.pointerEvent(
          buttonMask: payload[0],
          x: payload.readUInt16(at: 1),
          y: payload.readUInt16(at: 3)
        )

      case 6:  // ClientCutText
        try await receiveClientCutText(io: io)

      case 251:  // SetDesktopSize
        try await receiveSetDesktopSize(io: io)

      default:
        throw PrivateMacShareError.protocolError("unsupported client message \(messageType)")
      }
    }
  }

  // MARK: - Clipboard

  private func attachClipboard() {
    clipboard?.attach { [weak self] text in
      self?.pushHostClipboard(text)
    }
  }

  private func sendServerClipboardCapsIfNeeded(io: RFBConnectionIO) async throws {
    let clipboardNegotiated = withLock { supportsExtendedClipboard }
    guard clipboardNegotiated, clipboard != nil, !sentServerClipboardCaps else { return }
    sentServerClipboardCaps = true
    let body = VNCExtendedClipboard.encodeCaps(
      maximumUnsolicitedTextBytes: UInt32(RFBWire.maximumClipboardBytes)
    )
    try await io.send(VNCExtendedClipboard.frame(messageType: 3, body: body))
  }

  private func receiveClientCutText(io: RFBConnectionIO) async throws {
    let header = try await io.readExactly(7)
    let length = Int(header.readInt32(at: 3))

    if length >= 0 {
      guard length <= RFBWire.maximumClipboardBytes else {
        throw PrivateMacShareError.protocolError("clipboard payload is too large")
      }
      let payload = try await io.readExactly(length)
      guard let clipboard else { return }
      guard let text = String(data: payload, encoding: .isoLatin1) else { return }
      clipboard.receiveClientText(text)
      return
    }

    let bodyLength = -length
    guard bodyLength <= RFBWire.maximumExtendedClipboardBodyBytes else {
      throw PrivateMacShareError.protocolError("extended clipboard payload is too large")
    }
    let body = try await io.readExactly(bodyLength)
    let clipboardNegotiated = withLock { supportsExtendedClipboard }
    guard let clipboard, clipboardNegotiated else { return }

    // The body is fully consumed, so malformed messages are dropped without
    // desynchronizing the connection.
    guard let message = try? VNCExtendedClipboard.decode(body: body) else { return }

    switch message {
    case .caps(let caps):
      withLock { clientClipboardCaps = caps }

    case .notify(let hasText):
      guard hasText else { return }
      try await io.send(
        VNCExtendedClipboard.frame(
          messageType: 3,
          body: VNCExtendedClipboard.encodeRequestText()
        ))

    case .provide(let text):
      guard let text else { return }
      clipboard.receiveClientText(text)

    case .request(let wantsText):
      guard wantsText else { return }
      let text = clipboard.currentText() ?? ""
      guard let body = try? VNCExtendedClipboard.encodeProvide(text: text) else { return }
      try await io.send(VNCExtendedClipboard.frame(messageType: 3, body: body))

    case .peek:
      try await io.send(
        VNCExtendedClipboard.frame(
          messageType: 3,
          body: VNCExtendedClipboard.encodeNotify(hasText: clipboard.currentText() != nil)
        ))
    }
  }

  private func pushHostClipboard(_ text: String) {
    let (io, extendedNegotiated, caps) = withLock {
      (pushIO, supportsExtendedClipboard, clientClipboardCaps)
    }
    guard let io else { return }

    let payload: Data?
    if extendedNegotiated, let caps, caps.supportsText {
      let wireByteCount = VNCExtendedClipboard.wireTextByteCount(text)
      switch VNCExtendedClipboard.textRoute(wireByteCount: wireByteCount, caps: caps) {
      case .provide:
        payload = (try? VNCExtendedClipboard.encodeProvide(text: text)).map {
          VNCExtendedClipboard.frame(messageType: 3, body: $0)
        }
      case .notify:
        payload = VNCExtendedClipboard.frame(
          messageType: 3,
          body: VNCExtendedClipboard.encodeNotify(hasText: true)
        )
      case .legacy:
        payload = RFBWire.legacyServerCutText(text: text)
      }
    } else {
      // Legacy path: silently skip text that cannot survive Latin-1.
      payload = RFBWire.legacyServerCutText(text: text)
    }

    guard let payload else { return }
    Task {
      try? await io.send(payload)
    }
  }

  // MARK: - Desktop resize

  private func receiveSetDesktopSize(io: RFBConnectionIO) async throws {
    let header = try await io.readExactly(7)
    let requestedWidth = Int(header.readUInt16(at: 1))
    let requestedHeight = Int(header.readUInt16(at: 3))
    let screenCount = Int(header[5])
    guard screenCount <= 16 else {
      throw PrivateMacShareError.protocolError("too many screens in resize request")
    }
    _ = try await io.readExactly(screenCount * 16)

    guard supportsExtendedDesktopSize else {
      throw PrivateMacShareError.protocolError("resize requested without ExtendedDesktopSize")
    }

    let target = MacScreenCapture.resizedDimensions(
      requestedWidth: requestedWidth,
      requestedHeight: requestedHeight,
      sourcePixelWidth: descriptor.sourcePixelWidth,
      sourcePixelHeight: descriptor.sourcePixelHeight
    )

    if target.width == currentWidth, target.height == currentHeight {
      try await io.send(
        try RFBWire.extendedDesktopSizeUpdate(
          reason: 1,
          status: 0,
          width: currentWidth,
          height: currentHeight
        ))
      return
    }

    do {
      try await capture.updateOutputSize(width: target.width, height: target.height)
    } catch {
      // Status 2 = out of resources; the rectangle echoes the attempted layout.
      try await io.send(
        try RFBWire.extendedDesktopSizeUpdate(
          reason: 1,
          status: 2,
          width: requestedWidth,
          height: requestedHeight
        ))
      return
    }

    currentWidth = target.width
    currentHeight = target.height
    input.updateFrameSize(width: target.width, height: target.height)
    try await io.send(
      try RFBWire.extendedDesktopSizeUpdate(
        reason: 1,
        status: 0,
        width: target.width,
        height: target.height
      ))
  }

  /// Waits for a frame matching the announced framebuffer size, discarding
  /// stale frames captured before a resize took effect.
  private func waitForMatchingFrame() async throws -> CapturedDesktopFrame {
    for _ in 0..<150 {
      if let frame = await capture.frameStore.latest(),
        frame.width == currentWidth,
        frame.height == currentHeight
      {
        return frame
      }
      try await Task.sleep(for: .milliseconds(20))
    }
    throw PrivateMacShareError.captureUnavailable
  }

  private func finish(event: TailnetRFBServerEvent) {
    lock.lock()
    guard !finished else {
      lock.unlock()
      return
    }
    finished = true
    pushIO = nil
    lock.unlock()
    clipboard?.detach()
    connection.cancel()
    eventHandler(event)
    didFinish(self)
  }

  private func withLock<T>(_ body: () -> T) -> T {
    lock.lock()
    defer { lock.unlock() }
    return body()
  }

  private static func address(from endpoint: NWEndpoint?) -> String? {
    guard case .hostPort(let host, _) = endpoint else { return nil }
    let value = String(describing: host)
    return value.split(separator: "%", maxSplits: 1).first.map(String.init)
  }
}

private struct RFBConnectionIO: Sendable {
  let connection: NWConnection

  func readUInt8() async throws -> UInt8 {
    try await readExactly(1)[0]
  }

  func readExactly(_ count: Int) async throws -> Data {
    guard count >= 0 else {
      throw PrivateMacShareError.protocolError("invalid read size")
    }
    guard count > 0 else { return Data() }

    var result = Data(capacity: count)
    while result.count < count {
      let remaining = count - result.count
      let chunk = try await receive(maximumLength: remaining)
      guard !chunk.isEmpty else {
        throw PrivateMacShareError.protocolError("peer closed the connection")
      }
      result.append(chunk)
    }
    return result
  }

  func send(_ data: Data) async throws {
    try await withCheckedThrowingContinuation {
      (continuation: CheckedContinuation<Void, Error>) in
      connection.send(
        content: data,
        completion: .contentProcessed { error in
          if let error {
            continuation.resume(throwing: error)
          } else {
            continuation.resume(returning: ())
          }
        })
    }
  }

  private func receive(maximumLength: Int) async throws -> Data {
    try await withCheckedThrowingContinuation { continuation in
      connection.receive(minimumIncompleteLength: 1, maximumLength: maximumLength) {
        data, _, isComplete, error in
        if let error {
          continuation.resume(throwing: error)
        } else if let data, !data.isEmpty {
          continuation.resume(returning: data)
        } else if isComplete {
          continuation.resume(
            throwing: PrivateMacShareError.protocolError("peer closed the connection")
          )
        } else {
          continuation.resume(returning: Data())
        }
      }
    }
  }
}
