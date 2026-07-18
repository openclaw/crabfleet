import AppKit
import Combine
import Network
import RoyalVNCKit
import SwiftUI

private enum NativeFileTransferError: Error, LocalizedError {
  case unavailable
  case unexpectedResponse
  case sizeMismatch

  var errorDescription: String? {
    switch self {
    case .unavailable: "The shared folder is unavailable."
    case .unexpectedResponse: "The host returned an unexpected file-transfer response."
    case .sizeMismatch: "The transferred file size did not match."
    }
  }
}

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
      .crabfleetFileSharing,
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
  @Published private(set) var sharedFolderName: String?
  @Published private(set) var sharedFolderWritesAllowed = false
  @Published private(set) var sharedFolderEntries: [VNCFileEntry] = []
  @Published private(set) var sharedFolderPath = ""
  @Published private(set) var fileTransferStatus: String?
  @Published private(set) var fileTransferProgress: Double?
  @Published var isFileBrowserVisible = false
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
  private let frameEncodings: [VNCFrameEncodingType]
  private let quicFallbackDelay: Duration
  private weak var clipboardCoordinator: ClipboardCoordinator?
  private(set) var connection: VNCConnection?
  private let credentialLock = NSLock()
  private var credentialConnectionID: ObjectIdentifier?
  private var username = ""
  private var password = ""
  private var prefersPasswordOnlyARD = false
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
  private var nextFileRequestID: UInt32 = 1
  private var pendingFileRequests: [
    UInt32: CheckedContinuation<VNCFileSharingMessage, any Error>
  ] = [:]

  init(
    targetID: String = UUID().uuidString,
    clipboardCoordinator: ClipboardCoordinator? = nil,
    defaults: UserDefaults = .standard,
    frameEncodings: [VNCFrameEncodingType]? = nil,
    quicFallbackDelay: Duration = .seconds(2)
  ) {
    self.targetID = targetID
    self.clipboardCoordinator = clipboardCoordinator
    self.defaults = defaults
    self.frameEncodings =
      frameEncodings
      ?? Self.preferredFrameEncodings(supportsHEVC444: VNCHEVC444Capability.isSupported)
    self.quicFallbackDelay = quicFallbackDelay
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
    prefersPasswordOnlyARD: Bool = false,
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
      quic: quic,
      prefersPasswordOnlyARD: prefersPasswordOnlyARD)
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
      frameEncodings: frameEncodings
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
    connection.fileSharingDelegate = self
    applyFramebufferUpdatePolicy(to: connection)
    self.connection = connection
    self.transport = transport
    setCredentials(
      username: request.username,
      password: request.password,
      prefersPasswordOnlyARD: request.prefersPasswordOnlyARD,
      for: connection)
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
    quicFallbackTask = Task { [weak self, quicFallbackDelay] in
      try? await Task.sleep(for: quicFallbackDelay)
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
    resetFileSharing(error: NativeFileTransferError.unavailable)
    connection?.delegate = nil
    connection?.clipboardDelegate = nil
    connection?.audioDelegate = nil
    connection?.fileSharingDelegate = nil
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
    resetFileSharing(error: NativeFileTransferError.unavailable)
    connection.delegate = nil
    connection.clipboardDelegate = nil
    connection.audioDelegate = nil
    connection.fileSharingDelegate = nil
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
    connection?.fileSharingDelegate = nil
    connection?.disconnect()
    audioPlayer.stop()
    connection = nil
    transport = nil
    authenticationSucceeded = nil
    framebuffer = nil
    framebufferRevision += 1
    clearCredentials()
    cancelThumbnailCapture()
    resetFileSharing(error: NativeFileTransferError.unavailable)
  }

  private func clearCredentials() {
    credentialLock.lock()
    defer { credentialLock.unlock() }
    credentialConnectionID = nil
    username = ""
    password = ""
    prefersPasswordOnlyARD = false
  }

  private func setCredentials(
    username: String,
    password: String,
    prefersPasswordOnlyARD: Bool,
    for connection: VNCConnection
  ) {
    credentialLock.lock()
    defer { credentialLock.unlock() }
    credentialConnectionID = ObjectIdentifier(connection)
    self.username = username
    self.password = password
    self.prefersPasswordOnlyARD = prefersPasswordOnlyARD
  }

  private func credentials(
    for connection: VNCConnection
  ) -> (username: String, password: String, prefersPasswordOnlyARD: Bool)? {
    credentialLock.lock()
    defer { credentialLock.unlock() }
    guard credentialConnectionID == ObjectIdentifier(connection) else { return nil }
    return (username, password, prefersPasswordOnlyARD)
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

  func showFileBrowser() {
    guard sharedFolderName != nil else { return }
    isFileBrowserVisible.toggle()
    if isFileBrowserVisible { refreshSharedFolder() }
  }

  func refreshSharedFolder(path: String? = nil) {
    let requestedPath = path ?? sharedFolderPath
    Task { [weak self] in
      guard let self else { return }
      do {
        let message = try await requestFile { connection, id in
          try connection.requestSharedFolderList(id: id, path: requestedPath)
        }
        guard case .list(_, let entries) = message else {
          throw NativeFileTransferError.unexpectedResponse
        }
        sharedFolderPath = requestedPath
        sharedFolderEntries = entries
        fileTransferStatus = nil
      } catch {
        fileTransferStatus = error.localizedDescription
      }
    }
  }

  func openSharedFolderEntry(_ entry: VNCFileEntry) {
    let path = sharedFolderPath.isEmpty ? entry.name : "\(sharedFolderPath)/\(entry.name)"
    if entry.isDirectory {
      refreshSharedFolder(path: path)
    } else {
      downloadSharedFile(path: path, entry: entry)
    }
  }

  func navigateSharedFolderUp() {
    guard !sharedFolderPath.isEmpty else { return }
    refreshSharedFolder(path: sharedFolderPath.split(separator: "/").dropLast().joined(separator: "/"))
  }

  func chooseFilesToUpload() {
    guard sharedFolderWritesAllowed else { return }
    let panel = NSOpenPanel()
    panel.title = "Upload to \(sharedFolderName ?? "shared folder")"
    panel.prompt = "Upload"
    panel.canChooseDirectories = false
    panel.canChooseFiles = true
    panel.allowsMultipleSelection = true
    guard panel.runModal() == .OK else { return }
    uploadSharedFiles(panel.urls)
  }

  func createSharedFolderDirectory() {
    guard sharedFolderWritesAllowed else { return }
    let field = NSTextField(string: "")
    field.placeholderString = "Folder name"
    field.frame = NSRect(x: 0, y: 0, width: 280, height: 24)
    let alert = NSAlert()
    alert.messageText = "New folder"
    alert.informativeText = "Create a folder inside \(sharedFolderName ?? "the shared folder")."
    alert.accessoryView = field
    alert.addButton(withTitle: "Create")
    alert.addButton(withTitle: "Cancel")
    guard alert.runModal() == .alertFirstButtonReturn else { return }
    let name = field.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !name.isEmpty, !name.contains("/"), name != ".", name != ".." else {
      fileTransferStatus = "Choose a single folder name."
      return
    }
    let path = sharedFolderPath.isEmpty ? name : "\(sharedFolderPath)/\(name)"
    Task { [weak self] in
      guard let self else { return }
      do {
        let message = try await requestFile { connection, id in
          try connection.createSharedFolderDirectory(id: id, path: path)
        }
        guard case .operation(_, 6) = message else {
          throw NativeFileTransferError.unexpectedResponse
        }
        refreshSharedFolder()
      } catch {
        fileTransferStatus = error.localizedDescription
      }
    }
  }

  func uploadSharedFiles(_ urls: [URL]) {
    guard sharedFolderWritesAllowed, !urls.isEmpty else { return }
    Task { [weak self] in
      guard let self else { return }
      for url in urls {
        do { try await uploadSharedFile(url) } catch {
          fileTransferStatus = error.localizedDescription
          return
        }
      }
      refreshSharedFolder()
    }
  }

  private func downloadSharedFile(path: String, entry: VNCFileEntry) {
    let panel = NSSavePanel()
    panel.nameFieldStringValue = entry.name
    panel.canCreateDirectories = true
    guard panel.runModal() == .OK, let destination = panel.url else { return }
    Task { [weak self] in
      guard let self else { return }
      let temporary = destination.deletingLastPathComponent().appendingPathComponent(
        ".crabfleet-download-\(UUID().uuidString).tmp")
      do {
        guard FileManager.default.createFile(atPath: temporary.path, contents: nil) else {
          throw CocoaError(.fileWriteUnknown)
        }
        let handle = try FileHandle(forWritingTo: temporary)
        var offset: UInt64 = 0
        fileTransferStatus = "Downloading \(entry.name)…"
        do {
          while offset < entry.size || (entry.size == 0 && offset == 0) {
            let length = UInt32(min(UInt64(256 * 1_024), max(1, entry.size - offset)))
            let message = try await requestFile { connection, id in
              try connection.requestSharedFolderChunk(
                id: id, path: path, offset: offset, length: length)
            }
            guard case .chunk(_, let receivedOffset, let bytes, let endOfFile) = message,
              receivedOffset == offset
            else { throw NativeFileTransferError.unexpectedResponse }
            try handle.write(contentsOf: bytes)
            offset += UInt64(bytes.count)
            fileTransferProgress = entry.size == 0 ? 1 : Double(offset) / Double(entry.size)
            if endOfFile { break }
            guard !bytes.isEmpty else { throw NativeFileTransferError.sizeMismatch }
          }
          guard offset == entry.size else { throw NativeFileTransferError.sizeMismatch }
          try handle.synchronize()
          try handle.close()
        } catch {
          try? handle.close()
          throw error
        }
        if FileManager.default.fileExists(atPath: destination.path) {
          _ = try FileManager.default.replaceItemAt(destination, withItemAt: temporary)
        } else {
          try FileManager.default.moveItem(at: temporary, to: destination)
        }
        fileTransferProgress = nil
        fileTransferStatus = "Downloaded \(entry.name)"
      } catch {
        try? FileManager.default.removeItem(at: temporary)
        fileTransferProgress = nil
        fileTransferStatus = error.localizedDescription
      }
    }
  }

  private func uploadSharedFile(_ url: URL) async throws {
    let values = try url.resourceValues(forKeys: [.fileSizeKey, .isRegularFileKey])
    guard values.isRegularFile == true, let byteCount = values.fileSize, byteCount >= 0,
      UInt64(byteCount) <= 512 * 1_024 * 1_024
    else { throw NativeFileTransferError.unavailable }
    let path = sharedFolderPath.isEmpty ? url.lastPathComponent : "\(sharedFolderPath)/\(url.lastPathComponent)"
    let id = allocateFileRequestID()
    let handle = try FileHandle(forReadingFrom: url)
    defer { try? handle.close() }
    fileTransferStatus = "Uploading \(url.lastPathComponent)…"
    let begin = try await requestFile(id: id) { connection, id in
      try connection.beginSharedFolderUpload(id: id, path: path, size: UInt64(byteCount))
    }
    guard case .operation(_, 3) = begin else { throw NativeFileTransferError.unexpectedResponse }
    do {
      var sent: UInt64 = 0
      while let bytes = try handle.read(upToCount: 256 * 1_024), !bytes.isEmpty {
        let chunk = try await requestFile(id: id) { connection, id in
          try connection.sendSharedFolderUploadChunk(id: id, bytes: bytes)
        }
        guard case .operation(_, 4) = chunk else { throw NativeFileTransferError.unexpectedResponse }
        sent += UInt64(bytes.count)
        fileTransferProgress = byteCount == 0 ? 1 : Double(sent) / Double(byteCount)
      }
      let end = try await requestFile(id: id) { connection, id in
        connection.finishSharedFolderUpload(id: id)
      }
      guard case .operation(_, 5) = end else { throw NativeFileTransferError.unexpectedResponse }
    } catch {
      _ = try? await requestFile(id: id) { connection, id in
        connection.abortSharedFolderUpload(id: id)
      }
      throw error
    }
    fileTransferProgress = nil
    fileTransferStatus = "Uploaded \(url.lastPathComponent)"
  }

  private func requestFile(
    id: UInt32? = nil,
    send: (VNCConnection, UInt32) throws -> Bool
  ) async throws -> VNCFileSharingMessage {
    guard let connection, sharedFolderName != nil else { throw NativeFileTransferError.unavailable }
    let requestID = id ?? allocateFileRequestID()
    return try await withCheckedThrowingContinuation { continuation in
      pendingFileRequests[requestID] = continuation
      do {
        guard try send(connection, requestID) else {
          pendingFileRequests.removeValue(forKey: requestID)
          continuation.resume(throwing: NativeFileTransferError.unavailable)
          return
        }
      } catch {
        pendingFileRequests.removeValue(forKey: requestID)
        continuation.resume(throwing: error)
      }
    }
  }

  private func allocateFileRequestID() -> UInt32 {
    defer {
      nextFileRequestID &+= 1
      if nextFileRequestID == 0 { nextFileRequestID = 1 }
    }
    return nextFileRequestID
  }

  private func resetFileSharing(error: any Error) {
    sharedFolderName = nil
    sharedFolderWritesAllowed = false
    sharedFolderEntries = []
    sharedFolderPath = ""
    isFileBrowserVisible = false
    fileTransferProgress = nil
    for continuation in pendingFileRequests.values { continuation.resume(throwing: error) }
    pendingFileRequests.removeAll()
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
    connection?.fileSharingDelegate = nil
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
      resetFileSharing(error: NativeFileTransferError.unavailable)
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
      let credentials = credentials(for: connection)
      let hasUsername = !(credentials?.username.isEmpty ?? true)
      let hasCrabfleetPassword =
        credentials?.prefersPasswordOnlyARD == true && !(credentials?.password.isEmpty ?? true)
      return hasUsername || hasCrabfleetPassword
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

extension VNCSessionController: VNCFileSharingDelegate {
  func connection(
    _ connection: VNCConnection,
    didReceiveFileSharing message: VNCFileSharingMessage
  ) {
    guard self.connection === connection else { return }
    switch message {
    case .capability(let displayName, let allowWrites):
      sharedFolderName = displayName
      sharedFolderWritesAllowed = allowWrites
      refreshSharedFolder(path: "")
    case .list(let id, _), .chunk(let id, _, _, _), .operation(let id, _):
      pendingFileRequests.removeValue(forKey: id)?.resume(returning: message)
    case .error(let id, let message):
      pendingFileRequests.removeValue(forKey: id)?.resume(
        throwing: NSError(
          domain: "org.openclaw.crabfleet.file-transfer", code: 1,
          userInfo: [NSLocalizedDescriptionKey: message]))
    }
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
