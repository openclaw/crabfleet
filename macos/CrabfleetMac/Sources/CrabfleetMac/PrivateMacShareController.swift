import AppKit
import CoreGraphics
import Foundation

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

  @Published private(set) var identity: TailnetIdentity?
  @Published private(set) var phase: Phase = .idle
  @Published private(set) var screenRecordingGranted = CGPreflightScreenCaptureAccess()
  @Published private(set) var accessibilityGranted = MacRemoteInputController
    .isAccessibilityGranted
  @Published private(set) var connectedPeer: String?
  @Published private(set) var notice: String?
  @Published private(set) var isRefreshing = false
  @Published private(set) var registryPhase: RegistryPhase

  private let runner: (any TailscaleCommandRunning)?
  private let desktopRegistration: (any DesktopHostRegistering)?
  private let runnerInitializationError: Error?
  private var capture: MacScreenCapture?
  private var server: TailnetRFBServer?
  private var serverGeneration: UUID?
  private var registrationTask: Task<Void, Never>?

  init(
    runner: (any TailscaleCommandRunning)? = nil,
    desktopRegistration: (any DesktopHostRegistering)? = CrabfleetDesktopRegistration()
  ) {
    self.desktopRegistration = desktopRegistration
    registryPhase = desktopRegistration == nil ? .notConfigured : .registering
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
    isRefreshing = false
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
      let descriptor = try await capture.start()
      let input = MacRemoteInputController(descriptor: descriptor)
      let generation = UUID()
      serverGeneration = generation
      let server = TailnetRFBServer(
        identity: identity,
        runner: runner,
        capture: capture,
        descriptor: descriptor,
        input: input,
        port: Self.port,
        eventHandler: { [weak self] event in
          Task { @MainActor in self?.handle(event, generation: generation) }
        }
      )
      try server.start()
      self.capture = capture
      self.server = server
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
    registrationTask?.cancel()
    registrationTask = nil
    serverGeneration = nil
    server?.stop()
    server = nil
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
      notice = nil
    case .disconnected:
      phase = .sharing
      connectedPeer = nil
    case .listenerFailed(let message):
      registrationTask?.cancel()
      registrationTask = nil
      phase = .failed
      connectedPeer = nil
      notice = PrivateMacShareError.listenerFailed(message).localizedDescription
      serverGeneration = nil
      server?.stop()
      server = nil
      let failedCapture = capture
      capture = nil
      Task { await failedCapture?.stop() }
    case .sessionFailed(let message):
      phase = .sharing
      connectedPeer = nil
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
