import AppKit
import Combine
import RoyalVNCKit
import SwiftUI

@MainActor
final class VNCSessionController: NSObject, ObservableObject {
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
  @Published private(set) var thumbnail: NSImage?
  @Published private(set) var clipboardEnabled = false
  private(set) var framebufferUpdateCount: UInt64 = 0

  private let targetID: String
  private weak var clipboardCoordinator: ClipboardCoordinator?
  private(set) var connection: VNCConnection?
  private let credentialLock = NSLock()
  private var credentialConnectionID: ObjectIdentifier?
  private var username = ""
  private var password = ""
  private var thumbnailWorkItem: DispatchWorkItem?
  private var thumbnailGeneration: UInt64 = 0
  private var isPresentingLiveSurface = false
  private var isFocused = false
  private var isApplicationActive = true

  init(
    targetID: String = UUID().uuidString,
    clipboardCoordinator: ClipboardCoordinator? = nil
  ) {
    self.targetID = targetID
    self.clipboardCoordinator = clipboardCoordinator
    super.init()
  }

  func connect(
    host: String,
    port: UInt16,
    username: String,
    password: String,
    clipboardEnabled: Bool = true
  ) {
    tearDownConnection()

    self.clipboardEnabled = clipboardEnabled
    endpointDescription = "\(host):\(port)"
    errorMessage = nil
    framebuffer = nil
    framebufferUpdateCount = 0
    phase = .connecting
    clipboardCoordinator?.sessionStateDidChange(self, targetID: targetID)

    let settings = VNCConnection.Settings(
      isDebugLoggingEnabled: false,
      hostname: host,
      port: port,
      isShared: true,
      isScalingEnabled: true,
      useDisplayLink: false,
      inputMode: .forwardKeyboardShortcutsIfNotInUseLocally,
      clipboardMode: clipboardEnabled ? .externallyManaged : .disabled,
      colorDepth: .depth24Bit,
      frameEncodings: [.tight, .hextile]
    )
    let connection = VNCConnection(settings: settings)
    connection.delegate = self
    connection.clipboardDelegate = self
    applyFramebufferUpdatePolicy(to: connection)
    self.connection = connection
    setCredentials(username: username, password: password, for: connection)
    connection.connect()
  }

  func disconnect() {
    guard let connection else {
      phase = .idle
      return
    }
    phase = .disconnecting
    connection.disconnect()
  }

  private func tearDownConnection() {
    connection?.delegate = nil
    connection?.clipboardDelegate = nil
    connection?.disconnect()
    connection = nil
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
    if let connection {
      applyFramebufferUpdatePolicy(to: connection)
    }
  }

  func setApplicationActive(_ isActive: Bool) {
    isApplicationActive = isActive
    if let connection {
      applyFramebufferUpdatePolicy(to: connection)
    }
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
          let image = framebuffer?.snapshot(maxPixelSize: CGSize(width: 640, height: 360)) else {
      return
    }
    thumbnail = image
  }

  deinit {
    thumbnailWorkItem?.cancel()
    connection?.delegate = nil
    connection?.clipboardDelegate = nil
    connection?.disconnect()
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
      phase = .connected
    case .disconnecting:
      phase = .disconnecting
    case .disconnected:
      framebuffer = nil
      self.connection = nil
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

extension VNCSessionController: VNCClipboardDelegate {
  func connection(_ connection: VNCConnection, didReceiveClipboardText text: String) {
    guard self.connection === connection else { return }
    clipboardCoordinator?.receiveRemoteText(text, from: targetID)
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
  fileprivate weak var session: VNCSessionController?
  var isInteractive = true

  override init(frame frameRect: NSRect) {
    super.init(frame: frameRect)
    wantsLayer = true
    layer?.backgroundColor = NSColor.black.cgColor
    layer?.cornerRadius = 9
    layer?.masksToBounds = true
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) {
    fatalError("init(coder:) has not been implemented")
  }

  override func hitTest(_ point: NSPoint) -> NSView? {
    isInteractive ? super.hitTest(point) : nil
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

    DispatchQueue.main.async { [weak self, weak remoteView] in
      guard self?.isInteractive == true else { return }
      remoteView?.window?.makeFirstResponder(remoteView)
    }
  }

  func clear() {
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
}
