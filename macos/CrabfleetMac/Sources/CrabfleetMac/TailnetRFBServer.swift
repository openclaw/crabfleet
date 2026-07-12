import CoreMedia
import Foundation
import Network
import RoyalVNCKit

enum TailnetRFBServerEvent: Equatable, Sendable {
  case listening
  case authorizing(String)
  case connected(String)
  case streaming(TailnetStreamStats)
  case disconnected
  case listenerFailed(String)
  case sessionFailed(String)
}

struct TailnetStreamStats: Equatable, Sendable {
  let codec: String
  let hardwareAccelerated: Bool
  let framesPerSecond: Double
  let megabitsPerSecond: Double
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
  private let handshakeTimeout: Duration
  private let queue = DispatchQueue(label: "org.openclaw.crabfleet.rfb-listener")
  private let lock = NSLock()
  private let eventHandler: EventHandler
  private var listener: NWListener?
  private var session: RFBHostSession?
  private var viewOnly = false

  init(
    identity: TailnetIdentity,
    runner: any TailscaleCommandRunning,
    capture: MacScreenCapture,
    descriptor: CapturedDisplayDescriptor,
    input: any RemoteInputForwarding,
    clipboard: (any HostClipboardSyncing)? = nil,
    peerAuthorizer: (any TailnetPeerAuthorizing)? = nil,
    port: UInt16,
    handshakeTimeout: Duration = .seconds(10),
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
    self.handshakeTimeout = handshakeTimeout
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

  func setViewOnly(_ enabled: Bool) {
    let activeSession = withLock { () -> RFBHostSession? in
      viewOnly = enabled
      return session
    }
    activeSession?.setViewOnly(enabled)
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
      handshakeTimeout: handshakeTimeout,
      viewOnly: false,
      didAuthorize: { [weak capture] in capture?.setConsumerActive(true) },
      eventHandler: eventHandler,
      didFinish: { [weak self] finishedSession in
        self?.clear(finishedSession)
      }
    )
    withLock {
      self.session = newSession
      newSession.setViewOnly(viewOnly)
    }
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
  private let inputGate: RemoteInputSessionGate
  private let clipboard: (any HostClipboardSyncing)?
  private let requiredLocalAddress: String
  private let desktopName: String
  private let handshakeTimeout: Duration
  private let didAuthorize: @Sendable () -> Void
  private let queue = DispatchQueue(label: "org.openclaw.crabfleet.rfb-session")
  private let eventHandler: TailnetRFBServer.EventHandler
  private let didFinish: @Sendable (RFBHostSession) -> Void
  private let lock = NSLock()
  private var started = false
  private var finished = false
  private var handshakeFinished = false
  private var handshakeTimedOut = false
  private var task: Task<Void, Never>?
  private var pushIO: RFBConnectionIO?

  // Negotiated per-connection state; only the protocol task mutates it.
  private var supportsTightEncoding = false
  private var supportsOpenH264 = false
  private var supportsExtendedDesktopSize = false
  private var supportsExtendedClipboard = false
  private var sentServerClipboardCaps = false
  private var needsDesktopSizeAnnounce = false
  private var clientClipboardCaps: VNCExtendedClipboardCaps?
  private var currentWidth: Int
  private var currentHeight: Int
  private var videoEncoder: MacVideoEncoder?
  private var videoFrameMailbox: VideoMailbox<EncodedVideoFrame>?
  private var videoPixelMailbox: VideoMailbox<VideoPixelSource>?
  private var videoFrameConsumer: Task<Void, Never>?
  private var videoPathBroken = false
  private var needsContextReset = false
  private var forceNextKeyframe = false
  private var rateController = VideoRateController()
  private var lastStatsTimestamp = ProcessInfo.processInfo.systemUptime

  init(
    connection: NWConnection,
    authorizer: any TailnetPeerAuthorizing,
    capture: MacScreenCapture,
    descriptor: CapturedDisplayDescriptor,
    input: any RemoteInputForwarding,
    clipboard: (any HostClipboardSyncing)?,
    requiredLocalAddress: String,
    desktopName: String,
    handshakeTimeout: Duration,
    viewOnly: Bool,
    didAuthorize: @escaping @Sendable () -> Void,
    eventHandler: @escaping TailnetRFBServer.EventHandler,
    didFinish: @escaping @Sendable (RFBHostSession) -> Void
  ) {
    self.connection = connection
    self.authorizer = authorizer
    self.capture = capture
    self.descriptor = descriptor
    self.input = input
    inputGate = RemoteInputSessionGate(input: input, viewOnly: viewOnly)
    self.clipboard = clipboard
    self.requiredLocalAddress = requiredLocalAddress
    self.desktopName = desktopName
    self.handshakeTimeout = handshakeTimeout
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

  func setViewOnly(_ enabled: Bool) {
    inputGate.setViewOnly(enabled)
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
    try await handshakeBeforeDeadline(io: io)
    withLock { pushIO = io }
    attachClipboard()
    eventHandler(.connected(remoteAddress))
    rateController = VideoRateController()
    lastStatsTimestamp = ProcessInfo.processInfo.systemUptime
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

  private func handshakeBeforeDeadline(io: RFBConnectionIO) async throws {
    let deadlineTask = Task { [weak self, handshakeTimeout] in
      do {
        try await Task.sleep(for: handshakeTimeout)
      } catch {
        return
      }
      self?.expireHandshake()
    }
    do {
      try await handshake(io: io)
      deadlineTask.cancel()
      let timedOut = withLock { () -> Bool in
        handshakeFinished = true
        return handshakeTimedOut
      }
      guard !timedOut else {
        throw PrivateMacShareError.protocolError("RFB handshake timed out")
      }
    } catch {
      deadlineTask.cancel()
      if withLock({ handshakeTimedOut }) {
        throw PrivateMacShareError.protocolError("RFB handshake timed out")
      }
      throw error
    }
  }

  private func expireHandshake() {
    let shouldCancel = withLock { () -> Bool in
      guard !finished, !handshakeFinished else { return false }
      handshakeTimedOut = true
      return true
    }
    if shouldCancel {
      finish(event: .sessionFailed("RFB handshake timed out"))
    }
  }

  private func messageLoop(io: RFBConnectionIO) async throws {
    var hasSentJPEGFrame = false
    var lastSentJPEGSequence: UInt64 = 0

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
        supportsOpenH264 = encodings.contains(RFBWire.openH264Encoding)
        if encodings.contains(RFBWire.extendedDesktopSizeEncoding),
          !supportsExtendedDesktopSize
        {
          supportsExtendedDesktopSize = true
          needsDesktopSizeAnnounce = true
        }
        withLock {
          supportsExtendedClipboard = encodings.contains(RFBWire.extendedClipboardEncoding)
        }
        if !supportsOpenH264 {
          if activeVideoEncoder != nil { await stopVideoPath(markBroken: false) }
          if supportsTightEncoding { try await prepareTightFallback(io: io) }
        }
        try await sendServerClipboardCapsIfNeeded(io: io)

      case 3:  // FramebufferUpdateRequest
        let payload = try await io.readExactly(9)
        let incremental = payload[0] != 0
        guard selectedFrameEncoding != nil else {
          throw PrivateMacShareError.protocolError("the client did not offer a supported encoding")
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
        if selectedFrameEncoding == .openH264 {
          if activeVideoEncoder == nil {
            do {
              try await startVideoPath()
            } catch {
              await stopVideoPath(markBroken: true)
              if supportsTightEncoding {
                try await prepareTightFallback(io: io)
              }
            }
          }
          if let encoder = activeVideoEncoder {
            if !incremental { requestKeyframe() }
            switch await nextVideoUpdate(encoder: encoder) {
            case .frame(let frame):
              let flags: UInt32 = needsContextReset ? 0x2 : 0
              let update = try RFBWire.openH264Update(
                width: currentWidth,
                height: currentHeight,
                payload: frame.data,
                flags: flags)
              let sendSeconds = try await timedSend(update, io: io)
              needsContextReset = false
              recordFrameStats(
                byteCount: frame.data.count,
                sendSeconds: sendSeconds,
                codec: "H.264",
                hardwareAccelerated: encoder.isHardwareAccelerated,
                encoder: encoder)
              continue
            case .idle:
              // Nothing changed on screen; answer the request anyway so the
              // client's request loop and input keep flowing.
              try await io.send(RFBWire.emptyUpdate())
              emitStatsIfDue(codec: "H.264", hardwareAccelerated: encoder.isHardwareAccelerated)
              continue
            case .failed:
              await stopVideoPath(markBroken: true)
              if supportsTightEncoding {
                try await prepareTightFallback(io: io)
              }
            }
          }
        }

        guard selectedFrameEncoding == .tight else {
          throw PrivateMacShareError.protocolError("the Open H.264 encoder failed and Tight was not offered")
        }
        if hasSentJPEGFrame { try await Task.sleep(for: .milliseconds(66)) }
        let frame = try await waitForMatchingFrame()
        // Deduplicate only incremental requests: a non-incremental request is
        // an explicit ask for the full framebuffer contents.
        if incremental, frame.sequence == lastSentJPEGSequence {
          try await io.send(RFBWire.emptyUpdate())
          emitStatsIfDue(codec: "JPEG", hardwareAccelerated: false)
          continue
        }
        let update = try RFBWire.tightJPEGUpdate(frame: frame)
        let sendSeconds = try await timedSend(update, io: io)
        recordFrameStats(
          byteCount: frame.jpegData.count,
          sendSeconds: sendSeconds,
          codec: "JPEG",
          hardwareAccelerated: false,
          encoder: nil)
        lastSentJPEGSequence = frame.sequence
        hasSentJPEGFrame = true

      case 4:  // KeyEvent
        let payload = try await io.readExactly(7)
        inputGate.keyEvent(down: payload[0] != 0, keysym: payload.readUInt32(at: 3))

      case 5:  // PointerEvent
        let payload = try await io.readExactly(5)
        inputGate.pointerEvent(
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

    let payload = RFBWire.hostClipboardPayload(
      text: text,
      extendedNegotiated: extendedNegotiated,
      caps: caps
    )
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

    let videoWasActive = activeVideoEncoder != nil
    let isUsingH264 = selectedFrameEncoding == .openH264
    let target = MacScreenCapture.resizedDimensions(
      requestedWidth: requestedWidth,
      requestedHeight: requestedHeight,
      sourcePixelWidth: descriptor.sourcePixelWidth,
      sourcePixelHeight: descriptor.sourcePixelHeight,
      maximumWidth: isUsingH264 ? 4_096 : 2_560,
      maximumHeight: isUsingH264 ? 2_304 : 1_600
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
    if videoWasActive {
      do {
        try await restartVideoPath()
      } catch {
        await stopVideoPath(markBroken: true)
        guard supportsTightEncoding else {
          throw PrivateMacShareError.protocolError(
            "the Open H.264 encoder failed after resize and Tight was not offered")
        }
        let tightTarget = MacScreenCapture.resizedDimensions(
          requestedWidth: requestedWidth,
          requestedHeight: requestedHeight,
          sourcePixelWidth: descriptor.sourcePixelWidth,
          sourcePixelHeight: descriptor.sourcePixelHeight)
        if tightTarget.width != currentWidth || tightTarget.height != currentHeight {
          try await capture.updateOutputSize(width: tightTarget.width, height: tightTarget.height)
          currentWidth = tightTarget.width
          currentHeight = tightTarget.height
          input.updateFrameSize(width: currentWidth, height: currentHeight)
        }
      }
    }
    try await io.send(
      try RFBWire.extendedDesktopSizeUpdate(
        reason: 1,
        status: 0,
        width: currentWidth,
        height: currentHeight
      ))
  }

  // MARK: - Video

  /// Captured pixel buffers flow into a latest-wins mailbox and are encoded
  /// one at a time as the connection drains: every encoded frame is sent, so
  /// the H.264 reference chain stays intact and stale frames are dropped
  /// before they cost encoder time.
  private func startVideoPath() async throws {
    let encoder = try MacVideoEncoder(width: currentWidth, height: currentHeight)
    let pixelMailbox = VideoMailbox<VideoPixelSource>()
    _ = replaceVideoEncoder(with: encoder)
    withLock { videoPixelMailbox = pixelMailbox }
    startVideoFrameConsumer(for: encoder)
    rateController = VideoRateController()
    lastStatsTimestamp = ProcessInfo.processInfo.systemUptime
    needsContextReset = true
    requestKeyframe()
    capture.setVideoFrameHandler { pixelBuffer, presentationTime in
      pixelMailbox.offer(
        VideoPixelSource(pixelBuffer: pixelBuffer, presentationTime: presentationTime))
    }
    do {
      try await capture.updateFrameInterval(framesPerSecond: 60)
    } catch {
      capture.setVideoFrameHandler(nil)
      stopVideoFrameConsumer()
      finishPixelMailbox()
      encoder.invalidate()
      _ = replaceVideoEncoder(with: nil)
      throw error
    }
  }

  private func restartVideoPath() async throws {
    capture.setVideoFrameHandler(nil)
    stopVideoFrameConsumer()
    finishPixelMailbox()
    replaceVideoEncoder(with: nil)?.invalidate()
    try await startVideoPath()
  }

  private func stopVideoPath(markBroken: Bool) async {
    if markBroken { videoPathBroken = true }
    capture.setVideoFrameHandler(nil)
    stopVideoFrameConsumer()
    finishPixelMailbox()
    replaceVideoEncoder(with: nil)?.invalidate()
    needsContextReset = false
    withLock { forceNextKeyframe = false }
    rateController = VideoRateController()
    lastStatsTimestamp = ProcessInfo.processInfo.systemUptime
    try? await capture.updateFrameInterval(framesPerSecond: 15)
  }

  private func finishPixelMailbox() {
    let mailbox = withLock { () -> VideoMailbox<VideoPixelSource>? in
      defer { videoPixelMailbox = nil }
      return videoPixelMailbox
    }
    mailbox?.finish()
  }

  private func prepareTightFallback(io: RFBConnectionIO) async throws {
    guard currentWidth > 2_560 || currentHeight > 1_600 else { return }
    let target = MacScreenCapture.resizedDimensions(
      requestedWidth: currentWidth,
      requestedHeight: currentHeight,
      sourcePixelWidth: descriptor.sourcePixelWidth,
      sourcePixelHeight: descriptor.sourcePixelHeight)
    guard target.width != currentWidth || target.height != currentHeight else { return }
    try await capture.updateOutputSize(width: target.width, height: target.height)
    currentWidth = target.width
    currentHeight = target.height
    input.updateFrameSize(width: currentWidth, height: currentHeight)
    if supportsExtendedDesktopSize {
      try await io.send(
        try RFBWire.extendedDesktopSizeUpdate(
          reason: 0,
          status: 0,
          width: currentWidth,
          height: currentHeight))
    }
  }

  private var selectedFrameEncoding: RFBWire.FrameEncodingSelection? {
    var encodings: [Int32] = []
    if supportsOpenH264 { encodings.append(RFBWire.openH264Encoding) }
    if supportsTightEncoding { encodings.append(RFBWire.tightEncoding) }
    return RFBWire.preferredFrameEncoding(
      from: encodings, videoPathBroken: videoPathBroken)
  }

  private var activeVideoEncoder: MacVideoEncoder? {
    withLock { videoEncoder }
  }

  @discardableResult
  private func replaceVideoEncoder(with encoder: MacVideoEncoder?) -> MacVideoEncoder? {
    withLock {
      defer { videoEncoder = encoder }
      return videoEncoder
    }
  }

  private func requestKeyframe() {
    withLock { forceNextKeyframe = true }
  }

  private func startVideoFrameConsumer(for encoder: MacVideoEncoder) {
    let mailbox = VideoMailbox<EncodedVideoFrame>()
    let consumer = Task { [weak self] in
      for await frame in encoder.frames {
        // With one frame in flight a drop cannot happen; if it ever does the
        // client missed pixels, so resync with a keyframe.
        mailbox.offer(frame, onDrop: { self?.requestKeyframe() })
      }
      mailbox.finish()
    }
    let previous = withLock { () -> (Task<Void, Never>?, VideoMailbox<EncodedVideoFrame>?) in
      defer {
        videoFrameConsumer = consumer
        videoFrameMailbox = mailbox
      }
      return (videoFrameConsumer, videoFrameMailbox)
    }
    previous.0?.cancel()
    previous.1?.finish()
  }

  private func stopVideoFrameConsumer() {
    let previous = withLock { () -> (Task<Void, Never>?, VideoMailbox<EncodedVideoFrame>?) in
      defer {
        videoFrameConsumer = nil
        videoFrameMailbox = nil
      }
      return (videoFrameConsumer, videoFrameMailbox)
    }
    previous.0?.cancel()
    previous.1?.finish()
  }

  private func consumeForceNextKeyframe() -> Bool {
    withLock {
      defer { forceNextKeyframe = false }
      return forceNextKeyframe
    }
  }

  private func pendingKeyframeRequested() -> Bool {
    withLock { forceNextKeyframe }
  }

  private enum VideoUpdateOutcome {
    case frame(EncodedVideoFrame)
    case idle
    case failed
  }

  /// Encodes at most one captured frame for this update request. `.idle`
  /// means the screen has not changed (and no keyframe is owed), `.failed`
  /// means the encoder produced no output for a submitted frame.
  private func nextVideoUpdate(encoder: MacVideoEncoder) async -> VideoUpdateOutcome {
    let mailboxes = withLock { (videoPixelMailbox, videoFrameMailbox) }
    guard let pixelMailbox = mailboxes.0, let encodedMailbox = mailboxes.1,
      !encodedMailbox.isFinished
    else {
      return .failed
    }

    var source = await pixelMailbox.next(timeout: .milliseconds(100))
    if let candidate = source, !matchesCurrentSize(candidate.pixelBuffer) {
      source = nil  // stale capture output from before a resize
    }
    if source == nil, needsContextReset || pendingKeyframeRequested() {
      source = await keyframeSource()
    }
    guard let source else { return .idle }

    let forceKeyframe = consumeForceNextKeyframe() || needsContextReset
    guard
      encoder.encode(
        source.pixelBuffer,
        presentationTime: source.presentationTime,
        forceKeyframe: forceKeyframe)
    else {
      // Rejected input (for example a timestamp raced behind a synthetic
      // keyframe stamp) produces no output; try again on the next request.
      if forceKeyframe { requestKeyframe() }
      return .idle
    }

    while let frame = await encodedMailbox.next(timeout: .seconds(1)) {
      guard frame.width >= currentWidth, frame.height >= currentHeight,
        frame.width <= currentWidth + 15, frame.height <= currentHeight + 15
      else { continue }
      return .frame(frame)
    }
    return .failed
  }

  /// A source for keyframes owed while the screen is idle: the last streamed
  /// buffer if it still matches, otherwise a one-shot screenshot. Re-encoded
  /// buffers get a fresh host-clock stamp to stay monotonic.
  private func keyframeSource() async -> VideoPixelSource? {
    if let cached = capture.latestVideoFrame(), matchesCurrentSize(cached.pixelBuffer) {
      return VideoPixelSource(
        pixelBuffer: cached.pixelBuffer,
        presentationTime: CMClockGetTime(CMClockGetHostTimeClock()))
    }
    guard let snapshot = await capture.snapshotVideoFrame(),
      matchesCurrentSize(snapshot.pixelBuffer)
    else {
      return nil
    }
    return VideoPixelSource(
      pixelBuffer: snapshot.pixelBuffer,
      presentationTime: CMClockGetTime(CMClockGetHostTimeClock()))
  }

  private func matchesCurrentSize(_ pixelBuffer: CVPixelBuffer) -> Bool {
    CVPixelBufferGetWidth(pixelBuffer) == currentWidth
      && CVPixelBufferGetHeight(pixelBuffer) == currentHeight
  }

  private func timedSend(_ data: Data, io: RFBConnectionIO) async throws -> Double {
    let clock = ContinuousClock()
    let start = clock.now
    try await io.send(data)
    let duration = start.duration(to: clock.now)
    let components = duration.components
    return Double(components.seconds) + Double(components.attoseconds) / 1e18
  }

  private func recordFrameStats(
    byteCount: Int,
    sendSeconds: Double,
    codec: String,
    hardwareAccelerated: Bool,
    encoder: MacVideoEncoder?
  ) {
    let now = ProcessInfo.processInfo.systemUptime
    if let bitrate = rateController.recordFrame(
      byteCount: byteCount,
      sendSeconds: sendSeconds,
      timestamp: now)
    {
      encoder?.setAverageBitrate(bitrate)
    }
    emitStatsIfDue(codec: codec, hardwareAccelerated: hardwareAccelerated, now: now)
  }

  private func emitStatsIfDue(
    codec: String,
    hardwareAccelerated: Bool,
    now: Double = ProcessInfo.processInfo.systemUptime
  ) {
    guard now - lastStatsTimestamp >= 2 else { return }
    lastStatsTimestamp = now
    let snapshot = rateController.statsSnapshot(now: now)
    eventHandler(
      .streaming(
        TailnetStreamStats(
          codec: codec,
          hardwareAccelerated: hardwareAccelerated,
          framesPerSecond: snapshot.fps,
          megabitsPerSecond: snapshot.megabitsPerSecond)))
  }

  /// Waits for a frame matching the announced framebuffer size, discarding
  /// stale frames captured before a resize took effect. The store can be
  /// stale after an H.264 fallback on a static screen, so one snapshot
  /// refresh is attempted before giving up.
  private func waitForMatchingFrame() async throws -> CapturedDesktopFrame {
    var didRequestSnapshot = false
    for iteration in 0..<150 {
      if let frame = await capture.frameStore.latest(),
        frame.width == currentWidth,
        frame.height == currentHeight
      {
        return frame
      }
      if iteration >= 25, !didRequestSnapshot {
        didRequestSnapshot = true
        _ = await capture.refreshJPEGFrame()
        continue
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
    capture.setVideoFrameHandler(nil)
    stopVideoFrameConsumer()
    finishPixelMailbox()
    let encoder = replaceVideoEncoder(with: nil)
    encoder?.invalidate()
    inputGate.finish()
    clipboard?.detach()
    connection.cancel()
    guard encoder != nil else {
      completeFinish(event: event)
      return
    }
    Task { [self] in
      try? await capture.updateFrameInterval(framesPerSecond: 15)
      completeFinish(event: event)
    }
  }

  private func completeFinish(event: TailnetRFBServerEvent) {
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

extension RFBWire {
  static func hostClipboardPayload(
    text: String,
    extendedNegotiated: Bool,
    caps: VNCExtendedClipboardCaps?
  ) -> Data? {
    guard extendedNegotiated, let caps, caps.supportsText else {
      // Legacy path: silently skip text that cannot survive Latin-1.
      return legacyServerCutText(text: text)
    }

    let wireByteCount = VNCExtendedClipboard.wireTextByteCount(text)
    switch VNCExtendedClipboard.textRoute(wireByteCount: wireByteCount, caps: caps) {
    case .provide:
      return (try? VNCExtendedClipboard.encodeProvide(text: text)).map {
        VNCExtendedClipboard.frame(messageType: 3, body: $0)
      }
    case .notify:
      return VNCExtendedClipboard.frame(
        messageType: 3,
        body: VNCExtendedClipboard.encodeNotify(hasText: true)
      )
    case .legacy:
      return legacyServerCutText(text: text)
    }
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
