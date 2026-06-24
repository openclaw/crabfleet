import Foundation
import Network

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
    port: UInt16,
    eventHandler: @escaping EventHandler
  ) {
    self.identity = identity
    self.runner = runner
    self.capture = capture
    self.descriptor = descriptor
    self.input = input
    self.port = port
    self.eventHandler = eventHandler
  }

  func start() throws {
    let parameters = NWParameters.tcp
    guard let listenerPort = NWEndpoint.Port(rawValue: port) else {
      throw PrivateMacShareError.listenerFailed("invalid port")
    }
    parameters.requiredLocalEndpoint = .hostPort(
      host: NWEndpoint.Host(identity.ipv4Address),
      port: listenerPort
    )
    let listener = try NWListener(using: parameters)
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

    let authorizer = TailnetPeerAuthorizer(
      runner: runner,
      expectedIdentity: identity
    )
    let newSession = RFBHostSession(
      connection: connection,
      authorizer: authorizer,
      frameStore: capture.frameStore,
      descriptor: descriptor,
      input: input,
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
  private let authorizer: TailnetPeerAuthorizer
  private let frameStore: CapturedDesktopFrameStore
  private let descriptor: CapturedDisplayDescriptor
  private let input: any RemoteInputForwarding
  private let desktopName: String
  private let didAuthorize: @Sendable () -> Void
  private let queue = DispatchQueue(label: "org.openclaw.crabfleet.rfb-session")
  private let eventHandler: TailnetRFBServer.EventHandler
  private let didFinish: @Sendable (RFBHostSession) -> Void
  private let lock = NSLock()
  private var started = false
  private var finished = false
  private var task: Task<Void, Never>?

  init(
    connection: NWConnection,
    authorizer: TailnetPeerAuthorizer,
    frameStore: CapturedDesktopFrameStore,
    descriptor: CapturedDisplayDescriptor,
    input: any RemoteInputForwarding,
    desktopName: String,
    didAuthorize: @escaping @Sendable () -> Void,
    eventHandler: @escaping TailnetRFBServer.EventHandler,
    didFinish: @escaping @Sendable (RFBHostSession) -> Void
  ) {
    self.connection = connection
    self.authorizer = authorizer
    self.frameStore = frameStore
    self.descriptor = descriptor
    self.input = input
    self.desktopName = desktopName
    self.didAuthorize = didAuthorize
    self.eventHandler = eventHandler
    self.didFinish = didFinish
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
    guard let remoteAddress = Self.remoteAddress(from: connection.endpoint) else {
      throw PrivateMacShareError.protocolError("missing peer address")
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
        width: descriptor.frameWidth,
        height: descriptor.frameHeight,
        name: desktopName
      ))
  }

  private func messageLoop(io: RFBConnectionIO) async throws {
    var supportsTightEncoding = false
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
        supportsTightEncoding = (0..<count).contains {
          encodingData.readInt32(at: $0 * 4) == RFBWire.tightEncoding
        }

      case 3:  // FramebufferUpdateRequest
        _ = try await io.readExactly(9)
        guard supportsTightEncoding else {
          throw PrivateMacShareError.protocolError("the client did not offer Tight encoding")
        }
        if hasSentFrame {
          try await Task.sleep(for: .milliseconds(66))
        }
        let frame = try await waitForFrame()
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

      case 6:  // ClientCutText; consume but do not touch the host clipboard.
        let header = try await io.readExactly(7)
        let length = Int(header.readUInt32(at: 3))
        guard length <= RFBWire.maximumClipboardBytes else {
          throw PrivateMacShareError.protocolError("clipboard payload is too large")
        }
        _ = try await io.readExactly(length)

      default:
        throw PrivateMacShareError.protocolError("unsupported client message \(messageType)")
      }
    }
  }

  private func waitForFrame() async throws -> CapturedDesktopFrame {
    for _ in 0..<150 {
      if let frame = await frameStore.latest() { return frame }
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
    lock.unlock()
    connection.cancel()
    eventHandler(event)
    didFinish(self)
  }

  private static func remoteAddress(from endpoint: NWEndpoint) -> String? {
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
