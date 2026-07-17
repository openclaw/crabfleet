import AppKit
import Combine
import Network
import RoyalVNCKit
import SwiftUI

struct VNCViewportSize: Equatable {
  let width: UInt16
  let height: UInt16

  static func fitting(_ size: CGSize, backingScale: CGFloat = 1) -> Self? {
    guard size.width.isFinite, size.height.isFinite,
      backingScale.isFinite, backingScale > 0
    else {
      return nil
    }

    let pixelSize = CGSize(
      width: size.width * backingScale,
      height: size.height * backingScale
    )
    guard pixelSize.width >= 320, pixelSize.height >= 240 else { return nil }

    let maximum = CGSize(width: 4_096, height: 2_304)
    let fitScale = min(1, maximum.width / pixelSize.width, maximum.height / pixelSize.height)
    let width = max(320, Int((pixelSize.width * fitScale).rounded(.down)) & ~1)
    let height = max(240, Int((pixelSize.height * fitScale).rounded(.down)) & ~1)
    return Self(width: UInt16(width), height: UInt16(height))
  }
}

@MainActor
final class VNCSessionController: NSObject, ObservableObject {
  private struct TCPFallbackRetryState {
    let id: UUID
    let request: VNCConnectionRequest
    var retriesRemaining: Int
    var attempt: Int
  }

  nonisolated static func preferredFrameEncodings(
    supportsHEVC444: Bool
  ) -> [VNCFrameEncodingType] {
    var encodings: [VNCFrameEncodingType] = [
      .crabfleetHEVC, .openH264, .tight, .hextile, .crabfleetAudio,
      .crabfleetQualityControl,
    ]
    if supportsHEVC444 { encodings.insert(.crabfleetChroma444, at: 1) }
    return encodings
  }

  enum Phase: Equatable {
    case idle
    case connecting
    case connected
    case disconnecting
    case failed

    var title: String {
      switch self {
      case .idle: "Ready to connect"
      case .connecting: "Connecting"
      case .connected: "Connected"
      case .disconnecting: "Disconnecting"
      case .failed: "Connection failed"
      }
    }

    var color: Color {
      switch self {
      case .idle: .secondary
      case .connecting, .disconnecting: .orange
      case .connected: .mint
      case .failed: .red
      }
    }

    var isConnectedOrConnecting: Bool {
      [.connecting, .connected, .disconnecting].contains(self)
    }
  }

  @Published private(set) var phase: Phase = .idle
  @Published private(set) var framebuffer: VNCFramebuffer?
  @Published private(set) var framebufferRevision = 0
  @Published private(set) var errorMessage: String?
  @Published private(set) var endpointDescription: String?
  @Published private(set) var transport: DirectRFBTransport?
  @Published private(set) var thumbnail: NSImage?
  @Published private(set) var clipboardEnabled = false
  @Published private(set) var isAudioMuted = false
  @Published var qualityMode: ShareQualityMode {
    didSet {
      defaults.set(qualityMode.rawValue, forKey: qualityModeDefaultsKey)
      _ = connection?.setQualityMode(qualityMode.vncQualityMode)
    }
  }
  private(set) var framebufferUpdateCount: UInt64 = 0

  private let targetID: String
  private let defaults: UserDefaults
  private let qualityModeDefaultsKey: String
  private weak var clipboardCoordinator: ClipboardCoordinator?
  private(set) var connection: VNCConnection?
  private let credentialLock = NSLock()
  private var credentialConnectionID: ObjectIdentifier?
  private var username = ""
  private var password = ""
  private var authenticationSucceeded: (() -> Void)?
  private var thumbnailWorkItem: DispatchWorkItem?
  private var thumbnailGeneration: UInt64 = 0
  private var isPresentingLiveSurface = false
  private var isFocused = false
  private var isApplicationActive = true
  private var quicFallbackTask: Task<Void, Never>?
  private var pendingQUICStream: NWConnection?
  private var quicAttemptID: UUID?
  private var pendingTCPFallbackRequest: VNCConnectionRequest?
  private var tcpFallbackRetryState: TCPFallbackRetryState?
  private var tcpFallbackRetryTask: Task<Void, Never>?
  private let audioPlayer = RemoteAudioPlayer()

  init(
    targetID: String = UUID().uuidString,
    clipboardCoordinator: ClipboardCoordinator? = nil,
    defaults: UserDefaults = .standard
  ) {
    self.targetID = targetID
    self.clipboardCoordinator = clipboardCoordinator
    self.defaults = defaults
    let qualityKey = "org.openclaw.crabfleet.viewer.quality-mode.\(targetID)"
    qualityModeDefaultsKey = qualityKey
    qualityMode = defaults.string(forKey: qualityKey)
      .flatMap(ShareQualityMode.init(rawValue:)) ?? .auto
    super.init()
  }

  func connect(
    host: String,
    port: UInt16,
    username: String,
    password: String,
    clipboardEnabled: Bool = true,
    quic: QUICConnectionConfiguration? = nil,
    authenticationSucceeded: (() -> Void)? = nil
  ) {
    tearDownConnection()

    self.clipboardEnabled = clipboardEnabled
    endpointDescription = "\(host):\(port)"
    errorMessage = nil
    framebuffer = nil
    framebufferUpdateCount = 0
    phase = .connecting
    self.authenticationSucceeded = authenticationSucceeded
    clipboardCoordinator?.sessionStateDidChange(self, targetID: targetID)

    let request = VNCConnectionRequest(
      host: host,
      port: Int(port),
      username: username,
      password: password,
      clipboardEnabled: clipboardEnabled,
      quic: quic)
    if let quic {
      do {
        guard let quicPort = NWEndpoint.Port(rawValue: UInt16(quic.port)) else {
          throw QUICTransportError.invalidPin
        }
        let endpoint = NWEndpoint.hostPort(host: NWEndpoint.Host(host), port: quicPort)
        let networkConnection = NWConnection(
          to: endpoint,
          using: try QUICParameters.client(expectedCertHash: quic.certHash))
        let attemptID = UUID()
        pendingTCPFallbackRequest = request
        quicAttemptID = attemptID
        startQUICStream(networkConnection, request: request, attemptID: attemptID)
        scheduleTCPFallback(attemptID: attemptID)
        return
      } catch {
        quicAttemptID = nil
        pendingTCPFallbackRequest = nil
      }
    }
    startConnection(request: request, transport: .tcp)
  }

  private func startConnection(
    request: VNCConnectionRequest,
    transport: DirectRFBTransport,
    networkConnection: NWConnection? = nil,
    clientProtocolVersionAlreadySent: Bool = false,
    networkConnectionAlreadyStarted: Bool = false
  ) {
    let settings = VNCConnection.Settings(
      isDebugLoggingEnabled: false,
      hostname: request.host,
      port: UInt16(clamping: request.port),
      isShared: true,
      isScalingEnabled: true,
      useDisplayLink: false,
      inputMode: .forwardKeyboardShortcutsIfNotInUseLocally,
      clipboardMode: request.clipboardEnabled ? .externallyManaged : .disabled,
      colorDepth: .depth24Bit,
      frameEncodings: Self.preferredFrameEncodings(
        supportsHEVC444: VNCHEVC444Capability.isSupported)
    )
    let connection = if let networkConnection {
      VNCConnection(
        settings: settings,
        networkConnection: networkConnection,
        clientProtocolVersionAlreadySent: clientProtocolVersionAlreadySent,
        networkConnectionAlreadyStarted: networkConnectionAlreadyStarted)
    } else {
      VNCConnection(settings: settings)
    }
    connection.delegate = self
    connection.clipboardDelegate = self
    connection.audioDelegate = self
    applyFramebufferUpdatePolicy(to: connection)
    self.connection = connection
    self.transport = transport
    setCredentials(username: request.username, password: request.password, for: connection)
    connection.connect()
  }

  private func startQUICStream(
    _ networkConnection: NWConnection,
    request: VNCConnectionRequest,
    attemptID: UUID
  ) {
    guard quicAttemptID == attemptID, connection == nil else { return }
    pendingQUICStream = networkConnection
    networkConnection.stateUpdateHandler = { [weak self, weak networkConnection] state in
      guard let self, let networkConnection else { return }
      Task { @MainActor in
        guard self.quicAttemptID == attemptID, self.pendingQUICStream === networkConnection else {
          return
        }
        switch state {
        case .failed, .cancelled:
          self.fallbackToTCP(attemptID: attemptID)
        default:
          break
        }
      }
    }
    networkConnection.start(queue: .global(qos: .userInitiated))
    networkConnection.send(
      content: Data("RFB 003.008\n".utf8),
      completion: .contentProcessed { [weak self, weak networkConnection] error in
        guard let self, let networkConnection else { return }
        Task { @MainActor in
          guard self.quicAttemptID == attemptID,
            self.pendingQUICStream === networkConnection
          else { return }
          guard error == nil else {
            self.fallbackToTCP(attemptID: attemptID)
            return
          }
          networkConnection.stateUpdateHandler = nil
          self.pendingQUICStream = nil
          self.startConnection(
            request: request,
            transport: .quic,
            networkConnection: networkConnection,
            clientProtocolVersionAlreadySent: true,
            networkConnectionAlreadyStarted: true)
        }
      })
  }

  private func scheduleTCPFallback(attemptID: UUID) {
    quicFallbackTask?.cancel()
    quicFallbackTask = Task { [weak self] in
      try? await Task.sleep(for: .seconds(2))
      guard !Task.isCancelled, let self else { return }
      self.fallbackToTCP(attemptID: attemptID)
    }
  }

  private func fallbackToTCP(attemptID: UUID) {
    guard quicAttemptID == attemptID, let request = pendingTCPFallbackRequest else { return }
    quicAttemptID = nil
    pendingTCPFallbackRequest = nil
    quicFallbackTask?.cancel()
    quicFallbackTask = nil
    connection?.delegate = nil
    connection?.clipboardDelegate = nil
    connection?.audioDelegate = nil
    connection?.disconnect()
    pendingQUICStream?.stateUpdateHandler = nil
    pendingQUICStream?.cancel()
    pendingQUICStream = nil
    connection = nil
    clearCredentials()
    phase = .connecting
    errorMessage = nil
    tcpFallbackRetryState = TCPFallbackRetryState(
      id: UUID(),
      request: request,
      retriesRemaining: 3,
      attempt: 0)
    startConnection(request: request, transport: .tcp)
  }

  private func scheduleTCPFallbackRetry(after connection: VNCConnection) -> Bool {
    guard self.connection === connection, transport == .tcp,
      var state = tcpFallbackRetryState, state.retriesRemaining > 0
    else {
      clearTCPFallbackRetry()
      return false
    }
    state.retriesRemaining -= 1
    state.attempt += 1
    tcpFallbackRetryState = state
    connection.delegate = nil
    connection.clipboardDelegate = nil
    connection.audioDelegate = nil
    self.connection = nil
    clearCredentials()
    phase = .connecting
    errorMessage = nil

    tcpFallbackRetryTask?.cancel()
    tcpFallbackRetryTask = Task { [weak self] in
      try? await Task.sleep(for: .milliseconds(200 * state.attempt))
      guard !Task.isCancelled, let self,
        self.tcpFallbackRetryState?.id == state.id,
        self.connection == nil
      else { return }
      self.tcpFallbackRetryTask = nil
      self.startConnection(request: state.request, transport: .tcp)
    }
    return true
  }

  private func clearTCPFallbackRetry() {
    tcpFallbackRetryTask?.cancel()
    tcpFallbackRetryTask = nil
    tcpFallbackRetryState = nil
  }

  func beginConnecting(endpoint: String) {
    tearDownConnection()
    endpointDescription = endpoint
    errorMessage = nil
    framebuffer = nil
    framebufferUpdateCount = 0
    phase = .connecting
    clipboardCoordinator?.sessionStateDidChange(self, targetID: targetID)
  }

  func failConnection(_ message: String) {
    tearDownConnection()
    phase = .failed
    errorMessage = message
    clipboardCoordinator?.sessionStateDidChange(self, targetID: targetID)
  }

  func disconnect() {
    clearTCPFallbackRetry()
    quicFallbackTask?.cancel()
    quicFallbackTask = nil
    quicAttemptID = nil
    pendingTCPFallbackRequest = nil
    pendingQUICStream?.stateUpdateHandler = nil
    pendingQUICStream?.cancel()
    pendingQUICStream = nil
    guard let connection else {
      phase = .idle
      transport = nil
      return
    }
    phase = .disconnecting
    connection.disconnect()
  }

  private func tearDownConnection() {
    clearTCPFallbackRetry()
    quicFallbackTask?.cancel()
    quicFallbackTask = nil
    quicAttemptID = nil
    pendingTCPFallbackRequest = nil
    pendingQUICStream?.stateUpdateHandler = nil
    pendingQUICStream?.cancel()
    pendingQUICStream = nil
    connection?.delegate = nil
    connection?.clipboardDelegate = nil
    connection?.audioDelegate = nil
    connection?.disconnect()
    audioPlayer.stop()
    connection = nil
    transport = nil
    authenticationSucceeded = nil
    framebuffer = nil
    framebufferRevision += 1
    clearCredentials()
    cancelThumbnailCapture()
  }

  private func clearCredentials() {
    credentialLock.lock()
    defer { credentialLock.unlock() }
    credentialConnectionID = nil
    username = ""
    password = ""
  }

  private func setCredentials(username: String, password: String, for connection: VNCConnection) {
    credentialLock.lock()
    defer { credentialLock.unlock() }
    credentialConnectionID = ObjectIdentifier(connection)
    self.username = username
    self.password = password
  }

  private func credentials(for connection: VNCConnection) -> (username: String, password: String)? {
    credentialLock.lock()
    defer { credentialLock.unlock() }
    guard credentialConnectionID == ObjectIdentifier(connection) else { return nil }
    return (username, password)
  }

  func setLiveSurfacePresented(_ isPresented: Bool) {
    isPresentingLiveSurface = isPresented
    if isPresented {
      cancelThumbnailCapture()
    } else {
      scheduleThumbnailCapture(delay: 0)
    }
  }

  func setFocused(_ isFocused: Bool) {
    self.isFocused = isFocused
    applyAudioMutePolicy()
    if let connection {
      applyFramebufferUpdatePolicy(to: connection)
    }
  }

  func setApplicationActive(_ isActive: Bool) {
    isApplicationActive = isActive
    applyAudioMutePolicy()
    if let connection {
      applyFramebufferUpdatePolicy(to: connection)
    }
  }

  @discardableResult
  func requestDesktopSize(_ size: VNCViewportSize) -> Bool {
    connection?.requestDesktopSize(width: size.width, height: size.height) ?? false
  }

  private func applyFramebufferUpdatePolicy(to connection: VNCConnection) {
    if !isApplicationActive {
      connection.setFramebufferUpdatePolicy(.maximumFPS(0.5))
    } else if isFocused {
      connection.setFramebufferUpdatePolicy(.interactive)
    } else {
      connection.setFramebufferUpdatePolicy(.maximumFPS(4))
    }
  }

  func toggleAudioMuted() {
    isAudioMuted.toggle()
    applyAudioMutePolicy()
  }

  private func applyAudioMutePolicy() {
    audioPlayer.setMuted(isAudioMuted || !isFocused || !isApplicationActive)
  }

  private func scheduleThumbnailCapture(delay: TimeInterval = 0.35) {
    guard !isPresentingLiveSurface, thumbnailWorkItem == nil else { return }

    thumbnailGeneration &+= 1
    let generation = thumbnailGeneration
    let workItem = DispatchWorkItem { [weak self] in
      guard let self, self.thumbnailGeneration == generation else { return }
      self.thumbnailWorkItem = nil
      self.captureThumbnail()
    }
    thumbnailWorkItem = workItem
    DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: workItem)
  }

  private func cancelThumbnailCapture() {
    thumbnailGeneration &+= 1
    thumbnailWorkItem?.cancel()
    thumbnailWorkItem = nil
  }

  private func captureThumbnail() {
    guard !isPresentingLiveSurface,
      let image = framebuffer?.snapshot(maxPixelSize: CGSize(width: 640, height: 360))
    else {
      return
    }
    thumbnail = image
  }

  deinit {
    quicFallbackTask?.cancel()
    tcpFallbackRetryTask?.cancel()
    pendingQUICStream?.stateUpdateHandler = nil
    pendingQUICStream?.cancel()
    thumbnailWorkItem?.cancel()
    connection?.delegate = nil
    connection?.clipboardDelegate = nil
    connection?.audioDelegate = nil
    connection?.disconnect()
    audioPlayer.stop()
  }
}

extension VNCSessionController: VNCConnectionDelegate {
  func connection(
    _ connection: VNCConnection,
    stateDidChange connectionState: VNCConnection.ConnectionState
  ) {
    guard self.connection === connection else { return }
    switch connectionState.status {
    case .connecting:
      phase = .connecting
    case .connected:
      quicFallbackTask?.cancel()
      quicFallbackTask = nil
      quicAttemptID = nil
      pendingTCPFallbackRequest = nil
      clearTCPFallbackRetry()
      phase = .connected
      let authenticationSucceeded = self.authenticationSucceeded
      self.authenticationSucceeded = nil
      authenticationSucceeded?()
      _ = connection.setQualityMode(qualityMode.vncQualityMode)
    case .disconnecting:
      phase = pendingTCPFallbackRequest == nil ? .disconnecting : .connecting
    case .disconnected:
      if pendingTCPFallbackRequest != nil, transport == .quic {
        if let quicAttemptID { fallbackToTCP(attemptID: quicAttemptID) }
        return
      }
      if scheduleTCPFallbackRetry(after: connection) {
        clipboardCoordinator?.sessionStateDidChange(self, targetID: targetID)
        return
      }
      framebuffer = nil
      self.connection = nil
      audioPlayer.stop()
      clearCredentials()
      cancelThumbnailCapture()
      if let error = connectionState.error {
        self.phase = .failed
        errorMessage = error.localizedDescription
      } else {
        phase = .idle
        errorMessage = nil
      }
    @unknown default:
      phase = .failed
      errorMessage = "RoyalVNCKit returned an unknown connection state."
    }
    clipboardCoordinator?.sessionStateDidChange(self, targetID: targetID)
  }

  func connection(
    _ connection: VNCConnection,
    credentialFor authenticationType: VNCAuthenticationType,
    completion: @escaping (VNCCredential?) -> Void
  ) {
    guard let credentials = credentials(for: connection) else {
      completion(nil)
      return
    }
    if authenticationType.requiresUsername {
      completion(
        VNCUsernamePasswordCredential(
          username: credentials.username,
          password: credentials.password
        ))
    } else if authenticationType.requiresPassword {
      completion(VNCPasswordCredential(password: credentials.password))
    } else {
      completion(nil)
    }
  }

  func connection(
    _ connection: VNCConnection,
    prefersUsernameAuthentication authenticationType: VNCAuthenticationType
  ) -> Bool {
    if authenticationType == .appleRemoteDesktop {
      return !(credentials(for: connection)?.password.isEmpty ?? true)
    }
    return authenticationType.requiresUsername
      && !(credentials(for: connection)?.username.isEmpty ?? true)
  }

  func connection(_ connection: VNCConnection, didCreateFramebuffer framebuffer: VNCFramebuffer) {
    publish(framebuffer, from: connection)
  }

  func connection(_ connection: VNCConnection, didResizeFramebuffer framebuffer: VNCFramebuffer) {
    publish(framebuffer, from: connection)
  }

  func connection(
    _ connection: VNCConnection,
    didUpdateFramebuffer framebuffer: VNCFramebuffer,
    x: UInt16,
    y: UInt16,
    width: UInt16,
    height: UInt16
  ) {
    guard self.connection === connection else { return }
    framebufferUpdateCount &+= 1
    scheduleThumbnailCapture()
  }

  func connection(_ connection: VNCConnection, didUpdateCursor cursor: VNCCursor) {}

  private func publish(_ framebuffer: VNCFramebuffer, from connection: VNCConnection) {
    guard self.connection === connection else { return }
    self.framebuffer = framebuffer
    framebufferRevision += 1
    scheduleThumbnailCapture(delay: 0)
  }
}

private extension ShareQualityMode {
  var vncQualityMode: VNCQualityMode {
    switch self {
    case .auto: .auto
    case .sharp: .sharp
    case .smooth: .smooth
    }
  }
}

extension VNCSessionController: VNCClipboardDelegate {
  func connection(_ connection: VNCConnection, didReceiveClipboardText text: String) {
    guard self.connection === connection else { return }
    clipboardCoordinator?.receiveRemoteText(text, from: targetID)
  }
}

extension VNCSessionController: VNCAudioDelegate {
  func connection(_ connection: VNCConnection, didReceiveAudio message: VNCAudioMessage) {
    guard self.connection === connection else { return }
    audioPlayer.receive(message)
  }
}

extension VNCSessionController: ClipboardSessionEndpoint {
  var isClipboardConnected: Bool {
    phase == .connected
  }

  func sendClipboardText(_ text: String) throws {
    guard clipboardEnabled, let connection else {
      throw VNCClipboardError.notConnected
    }
    try connection.sendClipboardText(text)
  }
}

struct RemoteDesktopView: NSViewRepresentable {
  @ObservedObject var session: VNCSessionController
  var interactive = true

  func makeNSView(context: Context) -> RemoteDesktopContainerView {
    RemoteDesktopContainerView()
  }

  func updateNSView(_ view: RemoteDesktopContainerView, context: Context) {
    view.isInteractive = interactive
    guard let framebuffer = session.framebuffer,
      let connection = session.connection
    else {
      view.clear()
      return
    }
    view.show(
      framebuffer: framebuffer,
      revision: session.framebufferRevision,
      connection: connection,
      delegate: session
    )
    session.setLiveSurfacePresented(true)
  }

  static func dismantleNSView(_ view: RemoteDesktopContainerView, coordinator: Void) {
    view.clear()
  }
}

final class RemoteDesktopContainerView: NSView {
  private var framebufferView: VNCCAFramebufferView?
  private weak var displayedFramebuffer: VNCFramebuffer?
  private weak var displayedConnection: VNCConnection?
  private weak var originalDelegate: VNCConnectionDelegate?
  private var displayedRevision: Int?
  private var resizeWorkItem: DispatchWorkItem?
  private var pendingResizeSize: VNCViewportSize?
  private var lastRequestedSize: VNCViewportSize?
  fileprivate weak var session: VNCSessionController?
  var isInteractive = true

  override init(frame frameRect: NSRect) {
    super.init(frame: frameRect)
    wantsLayer = true
    layer?.backgroundColor = NSColor.black.cgColor
    layer?.masksToBounds = true
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) {
    fatalError("init(coder:) has not been implemented")
  }

  override func hitTest(_ point: NSPoint) -> NSView? {
    isInteractive ? super.hitTest(point) : nil
  }

  override func layout() {
    super.layout()
    scheduleDesktopResize()
  }

  override func viewDidChangeBackingProperties() {
    super.viewDidChangeBackingProperties()
    scheduleDesktopResize()
  }

  func show(
    framebuffer: VNCFramebuffer,
    revision: Int,
    connection: VNCConnection,
    delegate: VNCConnectionDelegate
  ) {
    guard displayedFramebuffer !== framebuffer || displayedRevision != revision else { return }
    clear()

    let remoteView = VNCCAFramebufferView(
      frame: bounds,
      framebuffer: framebuffer,
      connection: connection,
      connectionDelegate: delegate
    )
    remoteView.autoresizingMask = [.width, .height]
    addSubview(remoteView)
    framebufferView = remoteView
    displayedFramebuffer = framebuffer
    displayedConnection = connection
    originalDelegate = delegate
    displayedRevision = revision
    session = delegate as? VNCSessionController
    scheduleDesktopResize()

    DispatchQueue.main.async { [weak self, weak remoteView] in
      guard self?.isInteractive == true else { return }
      remoteView?.window?.makeFirstResponder(remoteView)
    }
  }

  func clear() {
    resizeWorkItem?.cancel()
    resizeWorkItem = nil
    pendingResizeSize = nil
    lastRequestedSize = nil
    session?.setLiveSurfacePresented(false)
    if let framebufferView, displayedConnection?.delegate === framebufferView {
      displayedConnection?.delegate = originalDelegate
    }
    framebufferView?.removeFromSuperview()
    framebufferView = nil
    displayedFramebuffer = nil
    displayedConnection = nil
    originalDelegate = nil
    displayedRevision = nil
    session = nil
  }

  private func scheduleDesktopResize() {
    guard isInteractive,
      session?.phase == .connected,
      let targetSize = VNCViewportSize.fitting(
        bounds.size,
        backingScale: window?.backingScaleFactor ?? 1
      )
    else { return }

    if targetSize == lastRequestedSize {
      pendingResizeSize = nil
      resizeWorkItem?.cancel()
      resizeWorkItem = nil
      return
    }

    pendingResizeSize = targetSize
    guard resizeWorkItem == nil else { return }

    let workItem = DispatchWorkItem { [weak self] in
      guard let self else { return }
      self.resizeWorkItem = nil
      guard let pendingSize = self.pendingResizeSize else { return }
      self.pendingResizeSize = nil
      guard self.session?.requestDesktopSize(pendingSize) == true else { return }
      self.lastRequestedSize = pendingSize
    }
    resizeWorkItem = workItem
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.08, execute: workItem)
  }
}
