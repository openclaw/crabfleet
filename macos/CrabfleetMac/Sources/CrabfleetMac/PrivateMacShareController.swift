import AppKit
import CoreGraphics
import Foundation
import ServiceManagement

enum PrivateMacSharePermissionPolicy {
  static func canStart(
    identityAvailable: Bool,
    screenRecordingGranted: Bool
  ) -> Bool {
    identityAvailable && screenRecordingGranted
  }
}

@MainActor
final class PrivateMacShareController: ObservableObject {
  enum RegistryPhase: Equatable {
    case notConfigured
    case registering
    case registered
    case failed(String)

    var detail: String {
      switch self {
      case .notConfigured: "Not configured"
      case .registering: "Registering"
      case .registered: "Published"
      case .failed(let message): message
      }
    }

    var isReady: Bool { self == .registered }
  }

  enum Phase: Equatable {
    case idle
    case starting
    case sharing
    case authorizing
    case connected
    case stopping
    case failed

    var title: String {
      switch self {
      case .idle: "Off"
      case .starting: "Starting"
      case .sharing: "Ready"
      case .authorizing: "Authenticating peer"
      case .connected: "Connected"
      case .stopping: "Stopping"
      case .failed: "Failed"
      }
    }

    var isRunning: Bool {
      [.starting, .sharing, .authorizing, .connected].contains(self)
    }
  }

  static let port: UInt16 = 5_901
  nonisolated static let selectedDisplayDefaultsKey = "org.openclaw.crabfleet.share.display"
  nonisolated static let clipboardSyncDefaultsKey = "org.openclaw.crabfleet.share.clipboard"
  nonisolated static let autoShareDefaultsKey = "org.openclaw.crabfleet.share.auto-share"
  nonisolated static let viewOnlyDefaultsKey = "org.openclaw.crabfleet.share.view-only"

  @Published private(set) var identity: TailnetIdentity?
  @Published private(set) var phase: Phase = .idle
  @Published private(set) var screenRecordingGranted = CGPreflightScreenCaptureAccess()
  @Published private(set) var accessibilityGranted = MacRemoteInputController
    .isAccessibilityGranted
  @Published private(set) var connectedPeer: String?
  @Published private(set) var notice: String?
  @Published private(set) var isRefreshing = false
  @Published private(set) var registryPhase: RegistryPhase
  @Published private(set) var availableDisplays: [ShareableDisplayOption] = []
  @Published private(set) var launchAtLoginEnabled = false
  @Published private(set) var streamStats: TailnetStreamStats?

  @Published var selectedDisplayID: CGDirectDisplayID {
    didSet {
      defaults.set(Int(selectedDisplayID), forKey: Self.selectedDisplayDefaultsKey)
    }
  }

  @Published var clipboardSyncEnabled: Bool {
    didSet {
      defaults.set(clipboardSyncEnabled, forKey: Self.clipboardSyncDefaultsKey)
    }
  }

  @Published var viewOnlyEnabled: Bool {
    didSet {
      defaults.set(viewOnlyEnabled, forKey: Self.viewOnlyDefaultsKey)
      server?.setViewOnly(viewOnlyEnabled)
    }
  }

  private let runner: (any TailscaleCommandRunning)?
  private let desktopRegistration: (any DesktopHostRegistering)?
  private let runnerInitializationError: Error?
  private let defaults: UserDefaults
  private var capture: MacScreenCapture?
  private var server: TailnetRFBServer?
  private var clipboardBridge: HostClipboardBridge?
  private var serverGeneration: UUID?
  private var registrationTask: Task<Void, Never>?

  init(
    runner: (any TailscaleCommandRunning)? = nil,
    desktopRegistration: (any DesktopHostRegistering)? = CrabfleetDesktopRegistration(),
    defaults: UserDefaults = .standard
  ) {
    self.desktopRegistration = desktopRegistration
    self.defaults = defaults
    registryPhase = desktopRegistration == nil ? .notConfigured : .registering
    let savedDisplayID = defaults.object(forKey: Self.selectedDisplayDefaultsKey) as? Int
    selectedDisplayID = savedDisplayID.map(CGDirectDisplayID.init) ?? CGMainDisplayID()
    clipboardSyncEnabled =
      defaults.object(forKey: Self.clipboardSyncDefaultsKey) as? Bool ?? true
    viewOnlyEnabled = defaults.object(forKey: Self.viewOnlyDefaultsKey) as? Bool ?? false
    launchAtLoginEnabled = SMAppService.mainApp.status == .enabled
    if let runner {
      self.runner = runner
      runnerInitializationError = nil
    } else {
      do {
        self.runner = try SystemTailscaleCommandRunner()
        runnerInitializationError = nil
      } catch {
        self.runner = nil
        runnerInitializationError = error
      }
    }
  }

  var connectionAddress: String? {
    identity?.vncAddress(port: Int(Self.port))
  }

  var canStart: Bool {
    phase == .idle
      && PrivateMacSharePermissionPolicy.canStart(
        identityAvailable: identity != nil,
        screenRecordingGranted: screenRecordingGranted
      )
  }

  func refresh() async {
    guard !isRefreshing, phase != .starting, phase != .stopping else { return }
    isRefreshing = true
    notice = nil
    await loadIdentity()
    refreshPermissions()
    await refreshDisplays()
    launchAtLoginEnabled = SMAppService.mainApp.status == .enabled
    isRefreshing = false
  }

  /// Registers or removes the login item and remembers to auto-start the
  /// share on launch, so this Mac stays reachable without manual setup.
  func setLaunchAtLogin(_ enabled: Bool) {
    do {
      if enabled {
        try SMAppService.mainApp.register()
      } else {
        try SMAppService.mainApp.unregister()
      }
      defaults.set(enabled, forKey: Self.autoShareDefaultsKey)
      launchAtLoginEnabled = SMAppService.mainApp.status == .enabled
    } catch {
      launchAtLoginEnabled = SMAppService.mainApp.status == .enabled
      notice =
        "Could not update the login item: \(error.localizedDescription) "
        + "(requires the bundled app, not a bare executable)"
    }
  }

  nonisolated static func isAutoShareRequested(defaults: UserDefaults = .standard) -> Bool {
    guard defaults.bool(forKey: autoShareDefaultsKey) else { return false }
    guard SMAppService.mainApp.status == .enabled else {
      // The login item was disabled outside the app (for example in System
      // Settings); drop the stale request so a manual launch does not start
      // sharing unexpectedly.
      defaults.set(false, forKey: autoShareDefaultsKey)
      return false
    }
    return true
  }

  func requestScreenRecordingPermission() async {
    guard !screenRecordingGranted else { return }
    _ = CGRequestScreenCaptureAccess()
    refreshPermissions()
    if !screenRecordingGranted {
      notice = PrivateMacShareError.screenRecordingDenied.localizedDescription
    }
  }

  func requestAccessibilityPermission() {
    guard !accessibilityGranted else { return }
    _ = MacRemoteInputController.requestAccessibility()
    refreshPermissions()
    if !accessibilityGranted {
      notice = PrivateMacShareError.accessibilityDenied.localizedDescription
    }
  }

  func start() async {
    guard phase == .idle else { return }
    phase = .starting
    notice = nil
    connectedPeer = nil
    streamStats = nil
    registryPhase = desktopRegistration == nil ? .notConfigured : .registering
    await loadIdentity()
    refreshPermissions()

    guard let identity else {
      phase = .failed
      notice = notice ?? PrivateMacShareError.invalidTailnetIdentity.localizedDescription
      return
    }
    guard screenRecordingGranted else {
      phase = .idle
      notice = PrivateMacShareError.screenRecordingDenied.localizedDescription
      return
    }
    guard let runner else {
      phase = .failed
      notice =
        (runnerInitializationError ?? PrivateMacShareError.tailscaleNotInstalled)
        .localizedDescription
      return
    }

    let capture = MacScreenCapture()
    do {
      let descriptor = try await capture.start(displayID: selectedDisplayID)
      let input = MacRemoteInputController(descriptor: descriptor)
      let bridge = clipboardSyncEnabled ? HostClipboardBridge() : nil
      let generation = UUID()
      serverGeneration = generation
      let server = TailnetRFBServer(
        identity: identity,
        runner: runner,
        capture: capture,
        descriptor: descriptor,
        input: input,
        clipboard: bridge,
        port: Self.port,
        eventHandler: { [weak self] event in
          Task { @MainActor in self?.handle(event, generation: generation) }
        }
      )
      server.setViewOnly(viewOnlyEnabled)
      try server.start()
      self.capture = capture
      self.server = server
      self.clipboardBridge = bridge
    } catch {
      serverGeneration = nil
      await capture.stop()
      phase = .failed
      notice = error.localizedDescription
    }
  }

  func stop() async {
    guard phase.isRunning || phase == .failed else { return }
    phase = .stopping
    connectedPeer = nil
    streamStats = nil
    registrationTask?.cancel()
    registrationTask = nil
    serverGeneration = nil
    server?.stop()
    server = nil
    clipboardBridge?.detach()
    clipboardBridge = nil
    let capture = capture
    self.capture = nil
    await capture?.stop()
    phase = .idle
  }

  func openPrivacySettings(_ pane: PrivacyPane) {
    let value: String
    switch pane {
    case .screenRecording:
      value = "Privacy_ScreenCapture"
    case .accessibility:
      value = "Privacy_Accessibility"
    }
    guard
      let url = URL(
        string: "x-apple.systempreferences:com.apple.preference.security?\(value)"
      )
    else { return }
    NSWorkspace.shared.open(url)
  }

  enum PrivacyPane {
    case screenRecording
    case accessibility
  }

  private func loadIdentity() async {
    guard let runner else {
      identity = nil
      notice =
        (runnerInitializationError ?? PrivateMacShareError.tailscaleNotInstalled)
        .localizedDescription
      return
    }
    do {
      let result = try await runner.run(arguments: ["status", "--json"])
      let document = try JSONDecoder().decode(
        TailscaleStatusDocument.self,
        from: Data(result.standardOutput.utf8)
      )
      identity = try TailnetIdentityPolicy.identity(from: document)
    } catch {
      identity = nil
      notice = error.localizedDescription
    }
  }

  private func refreshPermissions() {
    screenRecordingGranted = CGPreflightScreenCaptureAccess()
    accessibilityGranted = MacRemoteInputController.isAccessibilityGranted
  }

  private func refreshDisplays() async {
    guard screenRecordingGranted else {
      availableDisplays = []
      return
    }
    let displays = await MacScreenCapture.availableDisplays()
    availableDisplays = displays
    if !displays.isEmpty, !displays.contains(where: { $0.id == selectedDisplayID }) {
      selectedDisplayID =
        displays.first(where: { $0.id == CGMainDisplayID() })?.id ?? displays[0].id
    }
  }

  private func handle(_ event: TailnetRFBServerEvent, generation: UUID) {
    guard serverGeneration == generation else { return }
    switch event {
    case .listening:
      phase = .sharing
      notice = accessibilityGranted
        ? nil
        : "View-only sharing is ready. Allow Accessibility to enable remote control."
      registerDesktopHost(generation: generation)
    case .authorizing(let peer):
      phase = .authorizing
      connectedPeer = peer
    case .connected(let peer):
      phase = .connected
      connectedPeer = peer
      streamStats = nil
      notice = nil
    case .streaming(let stats):
      streamStats = stats
    case .disconnected:
      phase = .sharing
      connectedPeer = nil
      streamStats = nil
    case .listenerFailed(let message):
      registrationTask?.cancel()
      registrationTask = nil
      phase = .failed
      connectedPeer = nil
      streamStats = nil
      notice = PrivateMacShareError.listenerFailed(message).localizedDescription
      serverGeneration = nil
      server?.stop()
      server = nil
      clipboardBridge?.detach()
      clipboardBridge = nil
      let failedCapture = capture
      capture = nil
      Task { await failedCapture?.stop() }
    case .sessionFailed(let message):
      phase = .sharing
      connectedPeer = nil
      streamStats = nil
      notice = message
    }
  }

  private func registerDesktopHost(generation: UUID) {
    registrationTask?.cancel()
    guard let desktopRegistration, let identity else {
      registryPhase = .notConfigured
      return
    }
    registryPhase = .registering
    registrationTask = Task { [weak self] in
      do {
        try await desktopRegistration.register(identity: identity, port: Self.port)
        guard !Task.isCancelled, self?.serverGeneration == generation else { return }
        self?.registryPhase = .registered
      } catch is CancellationError {
        return
      } catch {
        guard self?.serverGeneration == generation else { return }
        self?.registryPhase = .failed(error.localizedDescription)
      }
    }
  }
}
