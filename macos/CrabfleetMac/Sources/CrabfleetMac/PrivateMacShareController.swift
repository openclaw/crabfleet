import AppKit
import CoreGraphics
import CryptoKit
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
final class PrivateMacShareStopCoordinator {
  private var isPerforming = false
  private var waiters: [CheckedContinuation<Void, Never>] = []

  func perform(_ body: @escaping @MainActor () async -> Void) async {
    if isPerforming {
      await withCheckedContinuation { continuation in
        self.waiters.append(continuation)
      }
      return
    }

    isPerforming = true
    await body()
    isPerforming = false
    let waiters = waiters
    self.waiters.removeAll()
    for waiter in waiters {
      waiter.resume()
    }
  }
}

@MainActor
protocol DesktopHostRegistrationStateStoring: AnyObject {
  func containsState() -> Bool
  func load(scope: DesktopHostRegistrationRecoveryScope) throws -> Data?
  func save(_ data: Data?, scope: DesktopHostRegistrationRecoveryScope) throws
}

extension DesktopHostRegistrationStateStoring {
  func containsState() -> Bool { true }
}

enum DesktopHostRegistrationPersistenceError: LocalizedError {
  case missingScope
  case unreadableState
  case writeFailed

  var errorDescription: String? {
    switch self {
    case .missingScope:
      "The desktop publication recovery scope is unavailable."
    case .unreadableState:
      "The saved desktop publication recovery state is unreadable."
    case .writeFailed:
      "The desktop publication recovery state could not be saved."
    }
  }
}

@MainActor
final class UserDefaultsDesktopHostRegistrationStateStore:
  DesktopHostRegistrationStateStoring
{
  nonisolated static let defaultKey = "org.openclaw.crabfleet.share.desktop-publications"

  private let defaults: UserDefaults
  private let key: String

  init(defaults: UserDefaults = .standard, key: String = defaultKey) {
    self.defaults = defaults
    self.key = key
  }

  func containsState() -> Bool {
    let prefix = "\(key).v2."
    return defaults.dictionaryRepresentation().keys.contains { $0.hasPrefix(prefix) }
  }

  func load(scope: DesktopHostRegistrationRecoveryScope) throws -> Data? {
    defaults.data(forKey: scopedKey(scope))
  }

  func save(_ data: Data?, scope: DesktopHostRegistrationRecoveryScope) throws {
    let scopedKey = scopedKey(scope)
    if let data {
      defaults.set(data, forKey: scopedKey)
    } else {
      defaults.removeObject(forKey: scopedKey)
    }
    guard defaults.synchronize() else {
      throw DesktopHostRegistrationPersistenceError.writeFailed
    }
  }

  private func scopedKey(_ scope: DesktopHostRegistrationRecoveryScope) -> String {
    let scopeData = Data("\(scope.apiOrigin)\u{0}\(scope.ownerSubject)".utf8)
    let digest = SHA256.hash(data: scopeData).map { String(format: "%02x", $0) }.joined()
    return "\(key).v2.\(digest)"
  }
}

@MainActor
final class DesktopHostRegistrationLifecycle {
  private struct PersistedIdentity: Codable, Equatable {
    let tailnetName: String
    let loginName: String
    let dnsName: String
    let hostName: String
    let ipv4Address: String
    let userID: Int64

    init(_ identity: TailnetIdentity) {
      tailnetName = identity.tailnetName
      loginName = identity.loginName
      dnsName = identity.dnsName
      hostName = identity.hostName
      ipv4Address = identity.ipv4Address
      userID = identity.userID
    }

    var identity: TailnetIdentity {
      TailnetIdentity(
        tailnetName: tailnetName,
        loginName: loginName,
        dnsName: dnsName,
        hostName: hostName,
        ipv4Address: ipv4Address,
        userID: userID
      )
    }
  }

  private struct RegistrationTarget: Codable, Equatable {
    private let persistedIdentity: PersistedIdentity
    let hostID: String
    let port: UInt16
    let publicationID: String

    init(identity: TailnetIdentity, hostID: String, port: UInt16, publicationID: String) {
      persistedIdentity = PersistedIdentity(identity)
      self.hostID = hostID
      self.port = port
      self.publicationID = publicationID
    }

    var identity: TailnetIdentity { persistedIdentity.identity }
  }

  private struct PublishedRegistration: Equatable {
    let identity: TailnetIdentity
    let hostID: String
    let publicationID: String
    let ownershipToken: String?
    let usesLegacyCleanup: Bool
  }

  private struct PersistedPublishedRegistration: Codable {
    private let persistedIdentity: PersistedIdentity
    let hostID: String
    let publicationID: String
    let usesLegacyCleanup: Bool

    init(_ registration: PublishedRegistration) {
      persistedIdentity = PersistedIdentity(registration.identity)
      hostID = registration.hostID
      publicationID = registration.publicationID
      usesLegacyCleanup = registration.usesLegacyCleanup
    }

    var registration: PublishedRegistration {
      PublishedRegistration(
        identity: persistedIdentity.identity,
        hostID: hostID,
        publicationID: publicationID,
        ownershipToken: nil,
        usesLegacyCleanup: usesLegacyCleanup
      )
    }
  }

  private struct PersistedState: Codable {
    var uncertainRegistrations: [RegistrationTarget]
    var publishedRegistration: PersistedPublishedRegistration?
    var pendingRemovals: [PersistedPublishedRegistration]
  }

  private let coordinator: DesktopHostRegistrationCoordinator
  private let createPublicationID: () -> String
  private let stateStore: (any DesktopHostRegistrationStateStoring)?
  private let recoveryScopeProvider: (() async throws -> DesktopHostRegistrationRecoveryScope)?
  private var recoveryScope: DesktopHostRegistrationRecoveryScope?
  private var stateLoaded = false
  private var publishedRegistration: PublishedRegistration?
  private var uncertainRegistrations: [RegistrationTarget] = []
  private var pendingRemovals: [PublishedRegistration] = []
  private var stateLoadError: Error?
  private var lastPersistenceError: Error?

  init(
    registration: any DesktopHostRegistering,
    createPublicationID: @escaping () -> String = { UUID().uuidString },
    stateStore: (any DesktopHostRegistrationStateStoring)? = nil,
    recoveryScopeProvider: (() async throws -> DesktopHostRegistrationRecoveryScope)? = nil
  ) {
    coordinator = DesktopHostRegistrationCoordinator(registration: registration)
    self.createPublicationID = createPublicationID
    self.stateStore = stateStore
    self.recoveryScopeProvider = recoveryScopeProvider
  }

  var hasDurableRecoveryState: Bool {
    stateStore != nil && stateLoaded && stateLoadError == nil && lastPersistenceError == nil
      && (!uncertainRegistrations.isEmpty || publishedRegistration != nil
        || !pendingRemovals.isEmpty)
  }

  var canTerminateAfterCleanupFailure: Bool {
    let hasActiveState =
      !uncertainRegistrations.isEmpty || publishedRegistration != nil || !pendingRemovals.isEmpty
    return !hasActiveState || hasDurableRecoveryState
  }

  func publish(identity: TailnetIdentity, port: UInt16) async throws {
    try await loadStateIfNeeded()
    let hostID = CrabfleetDesktopRegistration.hostID(identity: identity)
    let existingTarget = uncertainRegistrations.first {
      $0.hostID == hostID && $0.identity == identity && $0.port == port
    }
    let target =
      existingTarget
      ?? RegistrationTarget(
        identity: identity,
        hostID: hostID,
        port: port,
        publicationID: createPublicationID()
      )
    if existingTarget == nil {
      uncertainRegistrations.append(target)
      try persistState()
    }
    let ownershipToken: String?
    if existingTarget != nil {
      ownershipToken = try await coordinator.recover(
        identity: identity,
        publicationID: target.publicationID
      )
      guard ownershipToken != nil else {
        uncertainRegistrations.removeAll { $0 == target }
        try persistState()
        throw DesktopHostRegistrationSupersededError()
      }
    } else {
      do {
        ownershipToken = try await coordinator.register(
          identity: identity,
          port: port,
          publicationID: target.publicationID
        )
      } catch {
        if !(error is DesktopHostRegistrationResultUncertainError) {
          uncertainRegistrations.removeAll { $0 == target }
          try persistState()
        }
        throw error
      }
    }
    uncertainRegistrations.removeAll { $0 == target }
    if let publishedRegistration, publishedRegistration.hostID != hostID,
      !pendingRemovals.contains(publishedRegistration)
    {
      pendingRemovals.append(publishedRegistration)
    }
    pendingRemovals.removeAll { $0.hostID == hostID }
    publishedRegistration = PublishedRegistration(
      identity: identity,
      hostID: hostID,
      publicationID: target.publicationID,
      ownershipToken: ownershipToken,
      usesLegacyCleanup: ownershipToken == nil
    )
    try persistState()
  }

  func removePublishedIdentities() async throws {
    try await loadStateIfNeeded(requireRecoveryScope: false)
    var firstError: Error?
    let uncertainRegistrations = uncertainRegistrations
    for target in uncertainRegistrations {
      do {
        let ownershipToken = try await coordinator.recover(
          identity: target.identity,
          publicationID: target.publicationID
        )
        self.uncertainRegistrations.removeAll { $0 == target }
        guard let ownershipToken else {
          try persistState()
          continue
        }
        let recovered = PublishedRegistration(
          identity: target.identity,
          hostID: target.hostID,
          publicationID: target.publicationID,
          ownershipToken: ownershipToken,
          usesLegacyCleanup: false
        )
        if !pendingRemovals.contains(recovered) {
          pendingRemovals.append(recovered)
        }
        try persistState()
      } catch {
        firstError = firstError ?? error
      }
    }

    if let publishedRegistration {
      if !pendingRemovals.contains(publishedRegistration) {
        pendingRemovals.append(publishedRegistration)
      }
      self.publishedRegistration = nil
      do {
        try persistState()
      } catch {
        firstError = firstError ?? error
      }
    }

    let removals = pendingRemovals
    for removal in removals {
      var ownershipToken = removal.ownershipToken
      if ownershipToken == nil, !removal.usesLegacyCleanup {
        do {
          guard
            let recoveredToken = try await coordinator.recover(
              identity: removal.identity,
              publicationID: removal.publicationID
            )
          else {
            pendingRemovals.removeAll { $0 == removal }
            try persistState()
            continue
          }
          ownershipToken = recoveredToken
        } catch {
          firstError = firstError ?? error
          continue
        }
      }
      do {
        try await coordinator.unregister(
          identity: removal.identity,
          ownershipToken: ownershipToken
        )
        pendingRemovals.removeAll { $0 == removal }
        try persistState()
      } catch {
        firstError = firstError ?? error
        if removal.usesLegacyCleanup {
          // A tokenless legacy DELETE cannot identify its publication. Try it
          // only while stopping the process that published it; never retain it
          // for a delayed retry that could delete a replacement publisher.
          pendingRemovals.removeAll { $0 == removal }
          do {
            try persistState()
          } catch {
            firstError = firstError ?? error
          }
        }
      }
    }
    if let firstError { throw firstError }
  }

  private func loadStateIfNeeded(requireRecoveryScope: Bool = true) async throws {
    guard let stateStore else { return }
    if stateLoaded {
      if let stateLoadError { throw stateLoadError }
      if requireRecoveryScope, recoveryScope == nil {
        try await loadRecoveryScope()
      }
      return
    }
    if !requireRecoveryScope, !stateStore.containsState() {
      stateLoaded = true
      return
    }
    try await loadRecoveryScope()
    guard let recoveryScope else {
      throw DesktopHostRegistrationPersistenceError.missingScope
    }
    var filteredLegacyState = false
    do {
      if let data = try stateStore.load(scope: recoveryScope) {
        let state = try JSONDecoder().decode(PersistedState.self, from: data)
        filteredLegacyState =
          state.publishedRegistration?.usesLegacyCleanup == true
          || state.pendingRemovals.contains { $0.usesLegacyCleanup }
        uncertainRegistrations = state.uncertainRegistrations
        publishedRegistration = state.publishedRegistration
          .map(\.registration)
          .flatMap { $0.usesLegacyCleanup ? nil : $0 }
        pendingRemovals = state.pendingRemovals.map(\.registration)
          .filter { !$0.usesLegacyCleanup }
      }
      stateLoaded = true
    } catch {
      stateLoadError = DesktopHostRegistrationPersistenceError.unreadableState
      stateLoaded = true
      throw DesktopHostRegistrationPersistenceError.unreadableState
    }
    if filteredLegacyState {
      try persistState()
    }
  }

  private func loadRecoveryScope() async throws {
    guard let recoveryScopeProvider else {
      throw DesktopHostRegistrationPersistenceError.missingScope
    }
    recoveryScope = try await recoveryScopeProvider()
  }

  private func persistState() throws {
    guard let stateStore else { return }
    guard stateLoaded, let recoveryScope else {
      throw DesktopHostRegistrationPersistenceError.missingScope
    }
    let state = PersistedState(
      uncertainRegistrations: uncertainRegistrations,
      publishedRegistration: publishedRegistration
        .flatMap { $0.usesLegacyCleanup ? nil : PersistedPublishedRegistration($0) },
      pendingRemovals: pendingRemovals
        .filter { !$0.usesLegacyCleanup }
        .map(PersistedPublishedRegistration.init)
    )
    let hasState =
      !state.uncertainRegistrations.isEmpty || state.publishedRegistration != nil
      || !state.pendingRemovals.isEmpty
    do {
      let data = hasState ? try JSONEncoder().encode(state) : nil
      try stateStore.save(data, scope: recoveryScope)
      lastPersistenceError = nil
    } catch {
      lastPersistenceError = error
      throw error
    }
  }
}

@MainActor
final class PrivateMacShareController: ObservableObject {
  enum RegistryPhase: Equatable {
    case notConfigured
    case notPublished
    case registering
    case registered
    case failed(String)

    var detail: String {
      switch self {
      case .notConfigured: "Not configured"
      case .notPublished: "Not published"
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
  nonisolated static let streamAudioDefaultsKey = "org.openclaw.crabfleet.share.audio"
  nonisolated static let qualityModeDefaultsKey = "org.openclaw.crabfleet.share.quality-mode"

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
  @Published private(set) var audioActive = false

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

  @Published var streamAudioEnabled: Bool {
    didSet {
      defaults.set(streamAudioEnabled, forKey: Self.streamAudioDefaultsKey)
      server?.setAudioEnabled(streamAudioEnabled)
    }
  }

  @Published var qualityMode: ShareQualityMode {
    didSet {
      guard !isRevertingQualityMode else { return }
      guard !qualityModeChangePending else {
        revertQualityMode(to: oldValue)
        return
      }
      let requestedMode = qualityMode
      let previousGeneration = qualityModeChangeGeneration
      let generation = previousGeneration &+ 1
      qualityModeChangeGeneration = generation
      guard let server else {
        confirmedQualityMode = requestedMode
        defaults.set(requestedMode.rawValue, forKey: Self.qualityModeDefaultsKey)
        return
      }
      let previousMode = confirmedQualityMode
      qualityModeChangePending = true
      let accepted = server.setQualityMode(requestedMode) { [weak self] accepted in
        Task { @MainActor in
          self?.completeQualityModeChange(
            requestedMode,
            generation: generation,
            accepted: accepted)
        }
      }
      if !accepted {
        qualityModeChangePending = false
        qualityModeChangeGeneration = previousGeneration
        revertQualityMode(to: previousMode)
      }
    }
  }

  private let runner: (any TailscaleCommandRunning)?
  private let desktopRegistration: (any DesktopHostRegistering)?
  private let desktopRegistrationLifecycle: DesktopHostRegistrationLifecycle?
  private let runnerInitializationError: Error?
  private let defaults: UserDefaults
  private var capture: MacScreenCapture?
  private var server: TailnetRFBServer?
  private var isRevertingQualityMode = false
  private var qualityModeChangePending = false
  private var qualityModeChangeGeneration: UInt64 = 0
  private var confirmedQualityMode: ShareQualityMode = .auto
  private var clipboardBridge: HostClipboardBridge?
  private var activeIdentity: TailnetIdentity?
  private var lifecycleGeneration: UInt64 = 0
  private var serverGeneration: UInt64?
  private var registrationTask: Task<Void, Never>?
  private var registryOperationGeneration: UInt64 = 0
  private var publishingServerGeneration: UInt64?
  private var refreshWaiters: [CheckedContinuation<Void, Never>] = []
  private let stopCoordinator = PrivateMacShareStopCoordinator()

  init(
    runner: (any TailscaleCommandRunning)? = nil,
    desktopRegistration: (any DesktopHostRegistering)? = CrabfleetDesktopRegistration(),
    registrationLifecycle: DesktopHostRegistrationLifecycle? = nil,
    defaults: UserDefaults = .standard
  ) {
    self.desktopRegistration = desktopRegistration
    let registrationStateStore = UserDefaultsDesktopHostRegistrationStateStore(defaults: defaults)
    let recoveryScopeProvider = (desktopRegistration as? any DesktopHostRegistrationRecoveryScoping)
      .map { registration in
        { try await registration.recoveryScope() }
      }
    desktopRegistrationLifecycle =
      registrationLifecycle
      ?? desktopRegistration.map {
        DesktopHostRegistrationLifecycle(
          registration: $0,
          stateStore: registrationStateStore,
          recoveryScopeProvider: recoveryScopeProvider
        )
      }
    self.defaults = defaults
    registryPhase = desktopRegistration == nil ? .notConfigured : .notPublished
    let savedDisplayID = defaults.object(forKey: Self.selectedDisplayDefaultsKey) as? Int
    selectedDisplayID = savedDisplayID.map(CGDirectDisplayID.init) ?? CGMainDisplayID()
    clipboardSyncEnabled =
      defaults.object(forKey: Self.clipboardSyncDefaultsKey) as? Bool ?? true
    viewOnlyEnabled = defaults.object(forKey: Self.viewOnlyDefaultsKey) as? Bool ?? false
    streamAudioEnabled = defaults.object(forKey: Self.streamAudioDefaultsKey) as? Bool ?? true
    let savedQualityMode = defaults.string(forKey: Self.qualityModeDefaultsKey)
      .flatMap(ShareQualityMode.init(rawValue:)) ?? .auto
    qualityMode = savedQualityMode
    confirmedQualityMode = savedQualityMode
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

  private func completeQualityModeChange(
    _ requestedMode: ShareQualityMode,
    generation: UInt64,
    accepted: Bool
  ) {
    guard qualityModeChangeGeneration == generation, qualityMode == requestedMode else { return }
    qualityModeChangePending = false
    if accepted {
      confirmedQualityMode = requestedMode
      defaults.set(requestedMode.rawValue, forKey: Self.qualityModeDefaultsKey)
      return
    }
    defaults.set(confirmedQualityMode.rawValue, forKey: Self.qualityModeDefaultsKey)
    revertQualityMode(to: confirmedQualityMode)
  }

  private func revertQualityMode(to previousMode: ShareQualityMode) {
    isRevertingQualityMode = true
    qualityMode = previousMode
    isRevertingQualityMode = false
  }

  var canStart: Bool {
    phase == .idle && !isRefreshing
      && PrivateMacSharePermissionPolicy.canStart(
        identityAvailable: identity != nil,
        screenRecordingGranted: screenRecordingGranted
      )
  }

  func refresh() async {
    if isRefreshing {
      await waitForRefreshCompletion()
      return
    }
    guard phase != .starting, phase != .stopping else { return }
    isRefreshing = true
    defer { finishRefresh() }
    notice = nil
    do {
      identity = try await fetchIdentity()
    } catch {
      identity = nil
      notice = error.localizedDescription
    }
    refreshPermissions()
    await refreshDisplays()
    launchAtLoginEnabled = SMAppService.mainApp.status == .enabled
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
    let generation = beginLifecycleTransition()
    phase = .starting
    notice = nil
    connectedPeer = nil
    streamStats = nil
    audioActive = false
    registryPhase = desktopRegistration == nil ? .notConfigured : .registering
    await waitForRefreshCompletion()
    guard canContinueStarting(generation) else { return }
    do {
      let loadedIdentity = try await fetchIdentity()
      guard canContinueStarting(generation) else { return }
      identity = loadedIdentity
    } catch {
      guard canContinueStarting(generation) else { return }
      identity = nil
      phase = .failed
      notice = error.localizedDescription
      return
    }
    refreshPermissions()

    guard let identity else {
      phase = .failed
      notice = notice ?? PrivateMacShareError.invalidTailnetIdentity.localizedDescription
      return
    }
    guard screenRecordingGranted else {
      phase = .idle
      registryPhase = desktopRegistration == nil ? .notConfigured : .notPublished
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
      guard canContinueStarting(generation) else {
        await capture.stop()
        return
      }
      let input = MacRemoteInputController(descriptor: descriptor)
      let bridge = clipboardSyncEnabled ? HostClipboardBridge() : nil
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
      server.setAudioEnabled(streamAudioEnabled)
      server.setQualityMode(qualityMode)
      try server.start()
      self.capture = capture
      self.server = server
      self.clipboardBridge = bridge
      activeIdentity = identity
    } catch {
      guard canContinueStarting(generation) else {
        await capture.stop()
        return
      }
      serverGeneration = nil
      await capture.stop()
      phase = .failed
      notice = error.localizedDescription
    }
  }

  func stop() async {
    await stopCoordinator.perform { [weak self] in
      await self?.performStop()
    }
  }

  private func performStop() async {
    guard phase.isRunning || phase == .failed else { return }
    let generation = beginLifecycleTransition()
    phase = .stopping
    connectedPeer = nil
    streamStats = nil
    audioActive = false
    let registrationTask = self.registrationTask
    self.registrationTask = nil
    serverGeneration = nil
    server?.stop()
    server = nil
    clipboardBridge?.detach()
    clipboardBridge = nil
    let capture = capture
    self.capture = nil
    await capture?.stop()
    activeIdentity = nil
    removeDesktopHost(after: registrationTask)
    guard isCurrent(generation) else { return }
    phase = .idle
  }

  func stopAndWaitForCleanup() async -> Bool {
    await stop()
    let cleanupTask = registrationTask
    await cleanupTask?.value
    guard let desktopRegistrationLifecycle else { return true }
    do {
      try await desktopRegistrationLifecycle.removePublishedIdentities()
      registryPhase = .notPublished
      return true
    } catch {
      registryPhase = .failed(error.localizedDescription)
      notice = error.localizedDescription
      return desktopRegistrationLifecycle.canTerminateAfterCleanupFailure
    }
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

  private func fetchIdentity() async throws -> TailnetIdentity {
    guard let runner else {
      throw runnerInitializationError ?? PrivateMacShareError.tailscaleNotInstalled
    }
    let result = try await runner.run(arguments: ["status", "--json"])
    let document = try JSONDecoder().decode(
      TailscaleStatusDocument.self,
      from: Data(result.standardOutput.utf8)
    )
    return try TailnetIdentityPolicy.identity(from: document)
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

  private func waitForRefreshCompletion() async {
    guard isRefreshing else { return }
    await withCheckedContinuation { continuation in
      refreshWaiters.append(continuation)
    }
  }

  private func finishRefresh() {
    isRefreshing = false
    let waiters = refreshWaiters
    refreshWaiters.removeAll()
    for waiter in waiters {
      waiter.resume()
    }
  }

  private func handle(_ event: TailnetRFBServerEvent, generation: UInt64) {
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
    case .audioActive(let isActive):
      audioActive = isActive
    case .disconnected:
      phase = .sharing
      connectedPeer = nil
      streamStats = nil
      audioActive = false
    case .listenerFailed(let message):
      let pendingRegistration = registrationTask
      phase = .failed
      connectedPeer = nil
      streamStats = nil
      audioActive = false
      notice = PrivateMacShareError.listenerFailed(message).localizedDescription
      serverGeneration = nil
      server?.stop()
      server = nil
      clipboardBridge?.detach()
      clipboardBridge = nil
      let failedCapture = capture
      capture = nil
      Task { await failedCapture?.stop() }
      removeDesktopHost(after: pendingRegistration)
    case .sessionFailed(let message):
      phase = .sharing
      connectedPeer = nil
      streamStats = nil
      audioActive = false
      notice = message
    }
  }

  private func registerDesktopHost(generation: UInt64) {
    guard publishingServerGeneration != generation else { return }
    guard let desktopRegistrationLifecycle, let identity = activeIdentity else {
      registryPhase = desktopRegistration == nil ? .notConfigured : .notPublished
      return
    }
    let pendingOperation = registrationTask
    let operationGeneration = beginRegistryOperation()
    publishingServerGeneration = generation
    registryPhase = .registering
    registrationTask = Task { [weak self] in
      do {
        await pendingOperation?.value
        try await desktopRegistrationLifecycle.publish(identity: identity, port: Self.port)
        guard
          self?.isCurrentRegistryOperation(operationGeneration) == true,
          self?.serverGeneration == generation
        else { return }
        self?.registryPhase = .registered
      } catch {
        guard
          self?.isCurrentRegistryOperation(operationGeneration) == true,
          self?.serverGeneration == generation
        else { return }
        self?.registryPhase = .failed(error.localizedDescription)
      }
      if self?.publishingServerGeneration == generation {
        self?.publishingServerGeneration = nil
      }
      self?.finishRegistryOperation(operationGeneration)
    }
  }

  private func removeDesktopHost(after pendingRegistration: Task<Void, Never>?) {
    guard let desktopRegistrationLifecycle else {
      registrationTask = nil
      registryPhase = desktopRegistration == nil ? .notConfigured : .notPublished
      return
    }
    publishingServerGeneration = nil
    let operationGeneration = beginRegistryOperation()
    registrationTask = Task { [weak self] in
      await pendingRegistration?.value
      do {
        try await desktopRegistrationLifecycle.removePublishedIdentities()
        guard self?.isCurrentRegistryOperation(operationGeneration) == true else { return }
        self?.registryPhase = .notPublished
      } catch {
        guard self?.isCurrentRegistryOperation(operationGeneration) == true else { return }
        self?.registryPhase = .failed(error.localizedDescription)
        self?.notice = error.localizedDescription
      }
      self?.finishRegistryOperation(operationGeneration)
    }
  }

  @discardableResult
  private func beginLifecycleTransition() -> UInt64 {
    lifecycleGeneration &+= 1
    return lifecycleGeneration
  }

  private func isCurrent(_ generation: UInt64) -> Bool {
    lifecycleGeneration == generation
  }

  private func canContinueStarting(_ generation: UInt64) -> Bool {
    guard isCurrent(generation), phase == .starting else { return false }
    guard !Task.isCancelled else {
      phase = .idle
      registryPhase = desktopRegistration == nil ? .notConfigured : .notPublished
      return false
    }
    return true
  }

  @discardableResult
  private func beginRegistryOperation() -> UInt64 {
    registryOperationGeneration &+= 1
    return registryOperationGeneration
  }

  private func isCurrentRegistryOperation(_ generation: UInt64) -> Bool {
    registryOperationGeneration == generation
  }

  private func finishRegistryOperation(_ generation: UInt64) {
    guard isCurrentRegistryOperation(generation) else { return }
    registrationTask = nil
  }
}
