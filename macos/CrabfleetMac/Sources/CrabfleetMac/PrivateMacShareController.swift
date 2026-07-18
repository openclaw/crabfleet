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

struct DesktopHostPublication: Equatable, Sendable {
  let hostID: String
  let relayAccess: String?

  init(hostID: String, _ relayAccess: String?) {
    self.hostID = hostID
    self.relayAccess = relayAccess
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
    let quicPort: UInt16?
    let quicCertHash: String?
    let webtransport: Bool?
    let publicationID: String

    init(
      identity: TailnetIdentity,
      hostID: String,
      port: UInt16,
      quicPort: UInt16?,
      quicCertHash: String?,
      webtransport: Bool,
      publicationID: String
    ) {
      persistedIdentity = PersistedIdentity(identity)
      self.hostID = hostID
      self.port = port
      self.quicPort = quicPort
      self.quicCertHash = quicCertHash
      self.webtransport = webtransport
      self.publicationID = publicationID
    }

    var identity: TailnetIdentity { persistedIdentity.identity }

    func hasSamePublicationIdentity(
      identity: TailnetIdentity,
      hostID: String,
      port: UInt16
    ) -> Bool {
      self.hostID == hostID && self.identity == identity && self.port == port
    }
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
    var publishedRegistrations: [PersistedPublishedRegistration]
    var pendingRemovals: [PersistedPublishedRegistration]

    private enum CodingKeys: String, CodingKey {
      case uncertainRegistrations
      case publishedRegistration
      case publishedRegistrations
      case pendingRemovals
    }

    init(
      uncertainRegistrations: [RegistrationTarget],
      publishedRegistrations: [PersistedPublishedRegistration],
      pendingRemovals: [PersistedPublishedRegistration]
    ) {
      self.uncertainRegistrations = uncertainRegistrations
      self.publishedRegistrations = publishedRegistrations
      self.pendingRemovals = pendingRemovals
    }

    init(from decoder: any Decoder) throws {
      let container = try decoder.container(keyedBy: CodingKeys.self)
      uncertainRegistrations =
        try container.decodeIfPresent([RegistrationTarget].self, forKey: .uncertainRegistrations)
        ?? []
      publishedRegistrations =
        try container.decodeIfPresent(
          [PersistedPublishedRegistration].self,
          forKey: .publishedRegistrations)
        ?? container.decodeIfPresent(
          PersistedPublishedRegistration.self,
          forKey: .publishedRegistration).map { [$0] }
        ?? []
      pendingRemovals =
        try container.decodeIfPresent(
          [PersistedPublishedRegistration].self,
          forKey: .pendingRemovals) ?? []
    }

    func encode(to encoder: any Encoder) throws {
      var container = encoder.container(keyedBy: CodingKeys.self)
      try container.encode(uncertainRegistrations, forKey: .uncertainRegistrations)
      try container.encode(publishedRegistrations, forKey: .publishedRegistrations)
      try container.encode(pendingRemovals, forKey: .pendingRemovals)
    }
  }

  private let coordinator: DesktopHostRegistrationCoordinator
  private let createPublicationID: () -> String
  private let stateStore: (any DesktopHostRegistrationStateStoring)?
  private let recoveryScopeProvider: (() async throws -> DesktopHostRegistrationRecoveryScope)?
  private var recoveryScope: DesktopHostRegistrationRecoveryScope?
  private var stateLoaded = false
  private var publishedRegistrations: [PublishedRegistration] = []
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
      && (!uncertainRegistrations.isEmpty || !publishedRegistrations.isEmpty
        || !pendingRemovals.isEmpty)
  }

  var canTerminateAfterCleanupFailure: Bool {
    let hasActiveState =
      !uncertainRegistrations.isEmpty || !publishedRegistrations.isEmpty
      || !pendingRemovals.isEmpty
    return !hasActiveState || hasDurableRecoveryState
  }

  @discardableResult
  func publish(
    identity: TailnetIdentity,
    port: UInt16,
    quicPort: UInt16? = nil,
    quicCertHash: String? = nil,
    webtransport: Bool = false
  ) async throws -> DesktopHostPublication {
    try await loadStateIfNeeded()
    let hostID = CrabfleetDesktopRegistration.hostID(identity: identity)
    let existingTarget = uncertainRegistrations.first {
      $0.hasSamePublicationIdentity(identity: identity, hostID: hostID, port: port)
    }
    let target =
      existingTarget
      ?? RegistrationTarget(
        identity: identity,
        hostID: hostID,
        port: port,
        quicPort: quicPort,
        quicCertHash: quicCertHash,
        webtransport: webtransport,
        publicationID: createPublicationID()
      )
    if existingTarget != nil {
      try await refreshPublicationIfCurrent(
        identity: identity,
        port: port,
        quicPort: quicPort,
        quicCertHash: quicCertHash,
        webtransport: webtransport,
        publicationID: target.publicationID)
    }
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
          quicPort: quicPort,
          quicCertHash: quicCertHash,
          webtransport: webtransport,
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
    publishedRegistrations.removeAll { $0.hostID == hostID }
    pendingRemovals.removeAll { $0.hostID == hostID }
    publishedRegistrations.append(
      PublishedRegistration(
        identity: identity,
        hostID: hostID,
        publicationID: target.publicationID,
        ownershipToken: ownershipToken,
        usesLegacyCleanup: ownershipToken == nil
      ))
    try persistState()
    return DesktopHostPublication(hostID: hostID, ownershipToken)
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

    if !publishedRegistrations.isEmpty {
      for publishedRegistration in publishedRegistrations {
        if !pendingRemovals.contains(publishedRegistration) {
          pendingRemovals.append(publishedRegistration)
        }
      }
      publishedRegistrations.removeAll()
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
          state.publishedRegistrations.contains { $0.usesLegacyCleanup }
          || state.pendingRemovals.contains { $0.usesLegacyCleanup }
        uncertainRegistrations = state.uncertainRegistrations
        publishedRegistrations = state.publishedRegistrations.map(\.registration)
          .filter { !$0.usesLegacyCleanup }
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
      publishedRegistrations: publishedRegistrations
        .filter { !$0.usesLegacyCleanup }
        .map(PersistedPublishedRegistration.init),
      pendingRemovals: pendingRemovals
        .filter { !$0.usesLegacyCleanup }
        .map(PersistedPublishedRegistration.init)
    )
    let hasState =
      !state.uncertainRegistrations.isEmpty || !state.publishedRegistrations.isEmpty
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

  private func refreshPublicationIfCurrent(
    identity: TailnetIdentity,
    port: UInt16,
    quicPort: UInt16?,
    quicCertHash: String?,
    webtransport: Bool,
    publicationID: String
  ) async throws {
    guard
      try await coordinator.recover(identity: identity, publicationID: publicationID) != nil
    else { return }
    _ = try await coordinator.register(
      identity: identity,
      port: port,
      quicPort: quicPort,
      quicCertHash: quicCertHash,
      webtransport: webtransport,
      publicationID: publicationID)
  }
}

struct PrivateMacDisplayPlan: Equatable, Sendable {
  let display: ShareableDisplayOption
  let index: Int
  let port: UInt16

  static func make(
    displays: [ShareableDisplayOption],
    selectedIDs: Set<CGDirectDisplayID>,
    basePort: UInt16 = 5_901,
    limit: Int = 4
  ) -> [Self] {
    displays.filter { selectedIDs.contains($0.id) }.prefix(limit).enumerated().map {
      index, display in
      Self(display: display, index: index, port: basePort + UInt16(index))
    }
  }

  func registrationIdentity(base: TailnetIdentity) -> TailnetIdentity {
    let baseName = base.hostName.isEmpty ? base.dnsName : base.hostName
    let suffix = "-d\(index + 1)"
    let baseHostID = CrabfleetDesktopRegistration.hostID(identity: base)
    let dnsName = index == 0 ? base.dnsName : "\(baseHostID.prefix(80 - suffix.count))\(suffix)"
    return TailnetIdentity(
      tailnetName: base.tailnetName,
      loginName: base.loginName,
      dnsName: dnsName,
      hostName: "\(baseName) — \(display.label)",
      ipv4Address: base.ipv4Address,
      userID: base.userID)
  }
}

@MainActor
final class PrivateMacShareController: ObservableObject {
  struct ViewerSession: Identifiable, Equatable {
    let id: String
    let display: String
    let peer: String
    let transport: String
    let qualityMode: ShareQualityMode
  }
  private struct DisplayStack {
    let plan: PrivateMacDisplayPlan
    let capture: MacScreenCapture
    let descriptor: CapturedDisplayDescriptor
    let input: any RemoteInputForwarding
    let sessionGate: RFBHostSessionGate
    let server: TailnetRFBServer
  }

  private enum DisplayTransport: Hashable {
    case tailnet
    case relay
  }

  private struct DisplaySessionKey: Hashable {
    let displayID: CGDirectDisplayID
    let transport: DisplayTransport
  }

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
  static let quicPort: UInt16 = 5_911
  nonisolated static let selectedDisplayDefaultsKey = "org.openclaw.crabfleet.share.display"
  nonisolated static let clipboardSyncDefaultsKey = "org.openclaw.crabfleet.share.clipboard"
  nonisolated static let autoShareDefaultsKey = "org.openclaw.crabfleet.share.auto-share"
  nonisolated static let viewOnlyDefaultsKey = "org.openclaw.crabfleet.share.view-only"
  nonisolated static let streamAudioDefaultsKey = "org.openclaw.crabfleet.share.audio"
  nonisolated static let qualityModeDefaultsKey = "org.openclaw.crabfleet.share.quality-mode"
  nonisolated static let browserAccessDefaultsKey = "org.openclaw.crabfleet.share.browser-access"
  nonisolated static let sharedFolderBookmarkDefaultsKey =
    "org.openclaw.crabfleet.share.folder-bookmark"
  nonisolated static let sharedFolderWritesDefaultsKey =
    "org.openclaw.crabfleet.share.folder-writes"

  @Published private(set) var identity: TailnetIdentity?
  @Published private(set) var tailnetRegistrationHealth: TailnetRegistrationHealth = .ok
  @Published private(set) var phase: Phase = .idle
  @Published private(set) var screenRecordingGranted: Bool
  @Published private(set) var accessibilityGranted: Bool
  @Published private(set) var connectedPeer: String?
  @Published private(set) var notice: String?
  @Published private(set) var isRefreshing = false
  @Published private(set) var registryPhase: RegistryPhase
  @Published private(set) var availableDisplays: [ShareableDisplayOption] = []
  @Published private(set) var launchAtLoginEnabled = false
  @Published private(set) var streamStats: TailnetStreamStats?
  @Published private(set) var audioActive = false
  @Published private(set) var connectedViewerCount = 0
  @Published private(set) var viewerSessions: [ViewerSession] = []
  @Published private(set) var accessCode = ""
  @Published private(set) var sharedFolderName: String?

  @Published var allowRemoteFolderWrites: Bool {
    didSet {
      defaults.set(allowRemoteFolderWrites, forKey: Self.sharedFolderWritesDefaultsKey)
    }
  }

  @Published var selectedDisplayIDs: Set<CGDirectDisplayID> {
    didSet {
      defaults.set(selectedDisplayIDs.sorted().map(Int.init), forKey: Self.selectedDisplayDefaultsKey)
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
      for stack in displayStacks { stack.server.setViewOnly(viewOnlyEnabled) }
      for publisher in relayPublishers.values { publisher.setViewOnly(viewOnlyEnabled) }
    }
  }

  @Published var browserAccessEnabled: Bool {
    didSet {
      defaults.set(browserAccessEnabled, forKey: Self.browserAccessDefaultsKey)
      updateBrowserRelay()
    }
  }

  @Published var streamAudioEnabled: Bool {
    didSet {
      defaults.set(streamAudioEnabled, forKey: Self.streamAudioDefaultsKey)
      for stack in displayStacks {
        stack.server.setAudioEnabled(streamAudioEnabled && stack.plan.index == 0)
      }
      for (displayID, publisher) in relayPublishers {
        let isPrimary = displayStacks.first { $0.plan.display.id == displayID }?.plan.index == 0
        publisher.setAudioEnabled(streamAudioEnabled && isPrimary)
      }
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
      let generation = qualityModeChangeGeneration &+ 1
      qualityModeChangeGeneration = generation
      guard !displayStacks.isEmpty else {
        confirmedQualityMode = requestedMode
        defaults.set(requestedMode.rawValue, forKey: Self.qualityModeDefaultsKey)
        return
      }
      let previousMode = confirmedQualityMode
      qualityModeChangePending = true
      let servers = displayStacks.map(\.server)
      let publishers = Array(relayPublishers.values)
      Task { [weak self] in
        guard let self else { return }
        let accepted = await self.applyQualityMode(
          requestedMode,
          previousMode: previousMode,
          servers: servers,
          publishers: publishers)
        self.completeQualityModeChange(
          requestedMode,
          generation: generation,
          accepted: accepted)
      }
    }
  }

  private let runner: (any TailscaleCommandRunning)?
  private let desktopRegistration: (any DesktopHostRegistering)?
  private let desktopRegistrationLifecycle: DesktopHostRegistrationLifecycle?
  private let relayHostURL: ((String) -> URL?)?
  private let runnerInitializationError: Error?
  private let defaults: UserDefaults
  private let screenRecordingPermissionCheck: () -> Bool
  private let accessibilityPermissionCheck: () -> Bool
  private var permissionMonitoringTask: Task<Void, Never>?
  private var displayStacks: [DisplayStack] = []
  private var isRevertingQualityMode = false
  private var qualityModeChangePending = false
  private var qualityModeChangeGeneration: UInt64 = 0
  private var confirmedQualityMode: ShareQualityMode = .auto
  private var relayPublishers: [CGDirectDisplayID: RelayHostPublisher] = [:]
  private var relayPublications: [CGDirectDisplayID: DesktopHostPublication] = [:]
  private var clipboardBridge: HostClipboardBridge?
  private var activeSharedFolder: SecurityScopedSharedFolder?
  private var activeIdentity: TailnetIdentity?
  private var activeQUICCertHash: String?
  private var activePlans: [PrivateMacDisplayPlan] = []
  private var listeningDisplayIDs: Set<CGDirectDisplayID> = []
  private var viewerCounts: [DisplaySessionKey: Int] = [:]
  private var displayViewerSessions: [DisplaySessionKey: [TailnetViewerSession]] = [:]
  private var displayPeers: [DisplaySessionKey: String] = [:]
  private var displayStats: [DisplaySessionKey: TailnetStreamStats] = [:]
  private var audioSessionKeys: Set<DisplaySessionKey> = []
  private var directSessionSnapshots: [CGDirectDisplayID: [TailnetSessionDiagnostic]] = [:]
  private var lifecycleGeneration: UInt64 = 0
  private var serverGeneration: UInt64?
  private var registrationTask: Task<Void, Never>?
  private var registryOperationGeneration: UInt64 = 0
  private var publishingServerGeneration: UInt64?
  private var refreshWaiters: [CheckedContinuation<Void, Never>] = []
  private let stopCoordinator = PrivateMacShareStopCoordinator()
  private let accessState = ShareAccessState()
  private let authThrottle = RFBAuthThrottle()

  init(
    runner: (any TailscaleCommandRunning)? = nil,
    desktopRegistration: (any DesktopHostRegistering)? = CrabfleetDesktopRegistration(),
    registrationLifecycle: DesktopHostRegistrationLifecycle? = nil,
    defaults: UserDefaults = .standard,
    screenRecordingPermissionCheck: @escaping () -> Bool = {
      CGPreflightScreenCaptureAccess()
    },
    accessibilityPermissionCheck: @escaping () -> Bool = {
      MacRemoteInputController.isAccessibilityGranted
    }
  ) {
    self.screenRecordingPermissionCheck = screenRecordingPermissionCheck
    self.accessibilityPermissionCheck = accessibilityPermissionCheck
    screenRecordingGranted = screenRecordingPermissionCheck()
    accessibilityGranted = accessibilityPermissionCheck()
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
    relayHostURL = (desktopRegistration as? any DesktopHostRelayEndpointProviding).map {
      provider in { hostID in provider.relayHostURL(hostID: hostID) }
    }
    self.defaults = defaults
    registryPhase = desktopRegistration == nil ? .notConfigured : .notPublished
    let savedDisplayIDs = defaults.array(forKey: Self.selectedDisplayDefaultsKey) as? [Int]
    selectedDisplayIDs = Set(
      savedDisplayIDs?.map(CGDirectDisplayID.init) ?? [CGMainDisplayID()])
    clipboardSyncEnabled =
      defaults.object(forKey: Self.clipboardSyncDefaultsKey) as? Bool ?? true
    viewOnlyEnabled = defaults.object(forKey: Self.viewOnlyDefaultsKey) as? Bool ?? false
    streamAudioEnabled = defaults.object(forKey: Self.streamAudioDefaultsKey) as? Bool ?? true
    let savedQualityMode = defaults.string(forKey: Self.qualityModeDefaultsKey)
      .flatMap(ShareQualityMode.init(rawValue:)) ?? .auto
    qualityMode = savedQualityMode
    confirmedQualityMode = savedQualityMode
    browserAccessEnabled =
      defaults.object(forKey: Self.browserAccessDefaultsKey) as? Bool ?? true
    allowRemoteFolderWrites =
      defaults.object(forKey: Self.sharedFolderWritesDefaultsKey) as? Bool ?? true
    let savedFolderBookmark = defaults.data(forKey: Self.sharedFolderBookmarkDefaultsKey)
    let savedFolderName = Self.folderName(from: savedFolderBookmark)
    sharedFolderName = savedFolderName
    if savedFolderBookmark != nil, savedFolderName == nil {
      defaults.removeObject(forKey: Self.sharedFolderBookmarkDefaultsKey)
    }
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
    connectionAddresses.first
  }

  var tailnetWarning: String? {
    guard
      case .duplicateHostname(let advertised, let hostName, let matchingPeerPresent) =
        tailnetRegistrationHealth
    else { return nil }
    guard let advertised = advertised ?? identity?.ipv4Address else { return nil }
    let peerDetail = matchingPeerPresent
      ? " Another registered node also uses the hostname \(hostName)."
      : ""
    return
      "This Mac appears registered more than once in your tailnet (advertising \(advertised))."
      + peerDetail
      + " If viewers can’t connect, remove the duplicate node in the Tailscale admin console or re-authenticate this Mac."
  }

  var connectionAddresses: [String] {
    guard let identity else { return [] }
    return activePlans.map { identity.vncAddress(port: Int($0.port)) }
  }

  func regenerateAccessCode() {
    guard phase.isRunning else { return }
    do {
      let generated = try ShareAccessCodeGenerator.generate()
      accessState.replace(with: generated)
      accessCode = generated
      authThrottle.reset()
      notice = nil
    } catch {
      notice = error.localizedDescription
    }
  }

  func chooseSharedFolder() {
    guard !phase.isRunning else { return }
    let panel = NSOpenPanel()
    panel.title = "Choose a folder to share"
    panel.prompt = "Share Folder"
    panel.canChooseDirectories = true
    panel.canChooseFiles = false
    panel.allowsMultipleSelection = false
    panel.canCreateDirectories = true
    guard panel.runModal() == .OK, let url = panel.url else { return }
    do {
      let bookmark = try url.bookmarkData(
        options: [.withSecurityScope], includingResourceValuesForKeys: nil, relativeTo: nil)
      defaults.set(bookmark, forKey: Self.sharedFolderBookmarkDefaultsKey)
      sharedFolderName = url.lastPathComponent
      notice = nil
    } catch {
      notice = "Could not remember the shared folder: \(error.localizedDescription)"
    }
  }

  func stopSharingFolder() {
    guard !phase.isRunning else { return }
    defaults.removeObject(forKey: Self.sharedFolderBookmarkDefaultsKey)
    sharedFolderName = nil
  }

  private nonisolated static func folderName(from bookmark: Data?) -> String? {
    guard let bookmark else { return nil }
    var stale = false
    guard
      let url = try? URL(
        resolvingBookmarkData: bookmark,
        options: [.withSecurityScope, .withoutUI],
        relativeTo: nil,
        bookmarkDataIsStale: &stale),
      !stale
    else { return nil }
    return url.lastPathComponent
  }

  func setDisplay(_ displayID: CGDirectDisplayID, selected: Bool) {
    guard !phase.isRunning else { return }
    if selected {
      guard selectedDisplayIDs.count < 4 else { return }
      selectedDisplayIDs.insert(displayID)
    } else {
      guard selectedDisplayIDs.count > 1 else { return }
      selectedDisplayIDs.remove(displayID)
    }
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

  private func applyQualityMode(
    _ requestedMode: ShareQualityMode,
    previousMode: ShareQualityMode,
    servers: [TailnetRFBServer],
    publishers: [RelayHostPublisher]
  ) async -> Bool {
    for server in servers {
      guard await setQualityMode(requestedMode, on: server) else {
        await restoreQualityMode(previousMode, servers: servers, publishers: publishers)
        return false
      }
    }
    for publisher in publishers {
      guard await setQualityMode(requestedMode, on: publisher) else {
        await restoreQualityMode(previousMode, servers: servers, publishers: publishers)
        return false
      }
    }
    return true
  }

  private func restoreQualityMode(
    _ mode: ShareQualityMode,
    servers: [TailnetRFBServer],
    publishers: [RelayHostPublisher]
  ) async {
    for server in servers { _ = await setQualityMode(mode, on: server) }
    for publisher in publishers { _ = await setQualityMode(mode, on: publisher) }
  }

  private func setQualityMode(_ mode: ShareQualityMode, on server: TailnetRFBServer) async -> Bool {
    await withCheckedContinuation { continuation in
      let accepted = server.setQualityMode(mode) { accepted in
        continuation.resume(returning: accepted)
      }
      if !accepted { continuation.resume(returning: false) }
    }
  }

  private func setQualityMode(
    _ mode: ShareQualityMode,
    on publisher: RelayHostPublisher
  ) async -> Bool {
    await withCheckedContinuation { continuation in
      let accepted = publisher.setQualityMode(mode) { accepted in
        continuation.resume(returning: accepted)
      }
      if !accepted { continuation.resume(returning: false) }
    }
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
      let resolution = try await fetchIdentity()
      identity = resolution.identity
      tailnetRegistrationHealth = resolution.registrationHealth
    } catch {
      identity = nil
      tailnetRegistrationHealth = .ok
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

  func startPermissionMonitoring() {
    guard permissionMonitoringTask == nil else { return }
    refreshPermissions()
    permissionMonitoringTask = Task { [weak self] in
      while !Task.isCancelled {
        do {
          try await Task.sleep(for: .seconds(1))
        } catch {
          return
        }
        guard let self, !Task.isCancelled else { return }
        self.refreshPermissions()
      }
    }
  }

  func stopPermissionMonitoring() {
    permissionMonitoringTask?.cancel()
    permissionMonitoringTask = nil
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
      let resolution = try await fetchIdentity()
      guard canContinueStarting(generation) else { return }
      identity = resolution.identity
      tailnetRegistrationHealth = resolution.registrationHealth
    } catch {
      guard canContinueStarting(generation) else { return }
      identity = nil
      tailnetRegistrationHealth = .ok
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

    if availableDisplays.isEmpty { await refreshDisplays() }
    let plans = PrivateMacDisplayPlan.make(
      displays: availableDisplays,
      selectedIDs: selectedDisplayIDs,
      basePort: Self.port)
    guard !plans.isEmpty else {
      phase = .failed
      notice = PrivateMacShareError.captureUnavailable.localizedDescription
      return
    }

    do {
      let generated = try ShareAccessCodeGenerator.generate()
      accessState.replace(with: generated)
      accessCode = generated
      authThrottle.reset()
    } catch {
      phase = .failed
      notice = error.localizedDescription
      return
    }

    let bridge = clipboardSyncEnabled ? HostClipboardBridge() : nil
    do {
      activeSharedFolder = try defaults.data(forKey: Self.sharedFolderBookmarkDefaultsKey).map {
        try SecurityScopedSharedFolder(bookmark: $0, allowWrites: allowRemoteFolderWrites)
      }
    } catch {
      phase = .failed
      notice = error.localizedDescription
      return
    }
    serverGeneration = generation
    activePlans = plans
    clipboardBridge = bridge
    listeningDisplayIDs.removeAll()
    displayStacks.removeAll()
    do {
      // Cold safe-prime validation is intentionally off the main actor. Keep
      // it ahead of listener admission so it cannot consume a handshake deadline.
      try await RFBARDPrewarmer.shared.prepare()
      guard canContinueStarting(generation) else { throw CancellationError() }
      let quicIdentity = try? QUICIdentityStore.loadOrCreate()
      for plan in plans {
        let capture = MacScreenCapture()
        do {
          let descriptor = try await capture.start(displayID: plan.display.id)
          guard canContinueStarting(generation) else {
            await capture.stop()
            throw CancellationError()
          }
          let input = MacRemoteInputController(descriptor: descriptor)
          let sessionGate = RFBHostSessionGate()
          let server = TailnetRFBServer(
            identity: identity,
            runner: runner,
            capture: capture,
            descriptor: descriptor,
            input: input,
            clipboard: bridge,
            sharedFolder: activeSharedFolder?.configuration,
            port: plan.port,
            quicPort: quicIdentity.map { _ in Self.quicPort + UInt16(plan.index) },
            quicIdentity: quicIdentity,
            credentialProvider: { [accessState] in accessState.current },
            authThrottle: authThrottle,
            sessionGate: sessionGate,
            eventHandler: { [weak self] event in
              Task { @MainActor in
                self?.handle(
                  event,
                  displayID: plan.display.id,
                  transport: .tailnet,
                  generation: generation)
              }
            }
          )
          server.setViewOnly(viewOnlyEnabled)
          server.setAudioEnabled(streamAudioEnabled && plan.index == 0)
          server.setQualityMode(qualityMode)
          try server.start()
          displayStacks.append(
            DisplayStack(
              plan: plan,
              capture: capture,
              descriptor: descriptor,
              input: input,
              sessionGate: sessionGate,
              server: server))
        } catch {
          await capture.stop()
          throw error
        }
      }
      activeIdentity = identity
      activeQUICCertHash = quicIdentity?.certHash
    } catch {
      serverGeneration = nil
      for stack in displayStacks { stack.server.stop() }
      let captures = displayStacks.map(\.capture)
      displayStacks.removeAll()
      for capture in captures { await capture.stop() }
      clipboardBridge?.detachAll()
      clipboardBridge = nil
      activeSharedFolder = nil
      activePlans.removeAll()
      activeQUICCertHash = nil
      guard canContinueStarting(generation) else { return }
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
    for publisher in relayPublishers.values { publisher.stop() }
    relayPublishers.removeAll()
    relayPublications.removeAll()
    for stack in displayStacks { stack.server.stop() }
    let captures = displayStacks.map(\.capture)
    displayStacks.removeAll()
    clipboardBridge?.detachAll()
    clipboardBridge = nil
    activeSharedFolder = nil
    for capture in captures { await capture.stop() }
    activeIdentity = nil
    activeQUICCertHash = nil
    activePlans.removeAll()
    listeningDisplayIDs.removeAll()
    viewerCounts.removeAll()
    displayViewerSessions.removeAll()
    viewerSessions.removeAll()
    displayPeers.removeAll()
    displayStats.removeAll()
    audioSessionKeys.removeAll()
    directSessionSnapshots.removeAll()
    connectedViewerCount = 0
    accessState.clear()
    accessCode = ""
    authThrottle.reset()
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

  private func fetchIdentity() async throws -> (
    identity: TailnetIdentity,
    registrationHealth: TailnetRegistrationHealth
  ) {
    guard let runner else {
      throw runnerInitializationError ?? PrivateMacShareError.tailscaleNotInstalled
    }
    let result = try await runner.run(arguments: ["status", "--json"])
    let document = try TailscaleStatusDocument.decode(
      from: Data(result.standardOutput.utf8)
    )
    return (
      try TailnetIdentityPolicy.identity(from: document),
      TailnetRegistrationHealthPolicy.health(from: document)
    )
  }

  func refreshPermissions() {
    let screenRecordingGranted = screenRecordingPermissionCheck()
    if self.screenRecordingGranted != screenRecordingGranted {
      self.screenRecordingGranted = screenRecordingGranted
    }

    let accessibilityGranted = accessibilityPermissionCheck()
    if self.accessibilityGranted != accessibilityGranted {
      self.accessibilityGranted = accessibilityGranted
    }
  }

  private func refreshDisplays() async {
    guard screenRecordingGranted else {
      availableDisplays = []
      return
    }
    let displays = await MacScreenCapture.availableDisplays()
    availableDisplays = displays
    guard !displays.isEmpty else { return }
    let availableIDs = Set(displays.map(\.id))
    var validSelection = selectedDisplayIDs.intersection(availableIDs)
    if validSelection.isEmpty {
      validSelection.insert(
        displays.first(where: { $0.id == CGMainDisplayID() })?.id ?? displays[0].id)
    }
    selectedDisplayIDs = Set(
      displays.lazy.filter { validSelection.contains($0.id) }.prefix(4).map(\.id))
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

  private func handle(
    _ event: TailnetRFBServerEvent,
    displayID: CGDirectDisplayID,
    transport: DisplayTransport,
    generation: UInt64
  ) {
    guard serverGeneration == generation else { return }
    let key = DisplaySessionKey(displayID: displayID, transport: transport)
    switch event {
    case .listening:
      guard transport == .tailnet else { return }
      listeningDisplayIDs.insert(displayID)
      guard listeningDisplayIDs.count == activePlans.count else { return }
      phase = .sharing
      notice = accessibilityGranted
        ? nil
        : "View-only sharing is ready. Allow Accessibility to enable remote control."
      registerDesktopHost(generation: generation)
    case .authorizing(let peer):
      if connectedViewerCount == 0 {
        phase = .authorizing
        connectedPeer = peer
      }
    case .connected(let peer, let count):
      viewerCounts[key] = transport == .relay ? 1 : count
      displayPeers[key] = peer
      connectedViewerCount = viewerCounts.values.reduce(0, +)
      phase = .connected
      connectedPeer = connectedViewerCount == 1 ? peer : nil
      notice = nil
    case .streaming(let stats):
      displayStats[key] = stats
      updateAggregateStats()
    case .audioActive(let isActive):
      if isActive { audioSessionKeys.insert(key) } else { audioSessionKeys.remove(key) }
      audioActive = !audioSessionKeys.isEmpty
    case .viewerSessionsChanged(let sessions):
      if sessions.isEmpty {
        displayViewerSessions.removeValue(forKey: key)
      } else {
        displayViewerSessions[key] = sessions
      }
      updateViewerSessions()
    case .qualityModeChanged:
      break
    case .sessionSnapshot(let sessions):
      guard transport == .tailnet else { return }
      directSessionSnapshots[displayID] = sessions
      updateViewerSessions()
    case .disconnected(let count, let remainingPeer):
      let normalizedCount = transport == .relay ? 0 : count
      if normalizedCount == 0 {
        viewerCounts.removeValue(forKey: key)
        displayPeers.removeValue(forKey: key)
        displayStats.removeValue(forKey: key)
        audioSessionKeys.remove(key)
        displayViewerSessions.removeValue(forKey: key)
      } else {
        viewerCounts[key] = normalizedCount
        if let remainingPeer { displayPeers[key] = remainingPeer }
      }
      connectedViewerCount = viewerCounts.values.reduce(0, +)
      phase = connectedViewerCount == 0 ? .sharing : .connected
      connectedPeer = connectedViewerCount == 1 ? displayPeers.values.first : nil
      updateAggregateStats()
      audioActive = !audioSessionKeys.isEmpty
      updateViewerSessions()
    case .listenerFailed(let message):
      guard transport == .tailnet else { return }
      let pendingRegistration = registrationTask
      phase = .failed
      connectedPeer = nil
      streamStats = nil
      audioActive = false
      displayViewerSessions.removeAll()
      viewerSessions.removeAll()
      notice = PrivateMacShareError.listenerFailed(message).localizedDescription
      serverGeneration = nil
      for publisher in relayPublishers.values { publisher.stop() }
      relayPublishers.removeAll()
      relayPublications.removeAll()
      for stack in displayStacks { stack.server.stop() }
      let captures = displayStacks.map(\.capture)
      displayStacks.removeAll()
      directSessionSnapshots.removeAll()
      clipboardBridge?.detachAll()
      clipboardBridge = nil
      Task { for capture in captures { await capture.stop() } }
      removeDesktopHost(after: pendingRegistration)
    case .sessionFailed(let message):
      phase = connectedViewerCount == 0 ? .sharing : .connected
      notice = message
    }
  }

  private func updateViewerSessions() {
    var updatedSessions: [ViewerSession] = []
    for (key, sessions) in displayViewerSessions {
      let display = activePlans.first { $0.display.id == key.displayID }?.display.label
        ?? "Display"
      for session in sessions {
        let transportID: String
        let transport: String
        switch key.transport {
        case .relay:
          transportID = "relay"
          transport = "Browser"
        case .tailnet:
          transportID = "tailnet"
          let diagnostic = directSessionSnapshots[key.displayID]?.first { $0.id == session.id }
          transport = diagnostic?.transport.label ?? "Tailnet"
        }
        let viewerID = String(key.displayID) + "-" + transportID + "-" + session.id.uuidString
        updatedSessions.append(
          ViewerSession(
            id: viewerID,
            display: display,
            peer: session.peer,
            transport: transport,
            qualityMode: session.qualityMode))
      }
    }
    viewerSessions = updatedSessions.sorted { $0.id < $1.id }
  }

  private func updateAggregateStats() {
    guard let busiest = displayStats.values.max(by: {
      $0.megabitsPerSecond < $1.megabitsPerSecond
    }) else {
      streamStats = nil
      return
    }
    streamStats = TailnetStreamStats(
      codec: busiest.codec,
      hardwareAccelerated: busiest.hardwareAccelerated,
      codecDetail: busiest.codecDetail,
      targetBitrate: displayStats.values.reduce(0) { $0 + $1.targetBitrate },
      dirtyAreaPercent: busiest.dirtyAreaPercent,
      framesPerSecond: displayStats.values.reduce(0) { $0 + $1.framesPerSecond },
      megabitsPerSecond: displayStats.values.reduce(0) { $0 + $1.megabitsPerSecond })
  }

  private func registerDesktopHost(generation: UInt64) {
    guard publishingServerGeneration != generation else { return }
    guard let desktopRegistrationLifecycle, let identity = activeIdentity else {
      registryPhase = desktopRegistration == nil ? .notConfigured : .notPublished
      return
    }
    let pendingOperation = registrationTask
    let operationGeneration = beginRegistryOperation()
    let plans = activePlans
    let quicCertHash = activeQUICCertHash
    let quicDisplayIDs = Set(
      displayStacks.lazy.filter(\.server.quicAvailable).map { $0.plan.display.id })
    publishingServerGeneration = generation
    registryPhase = .registering
    registrationTask = Task { [weak self] in
      do {
        await pendingOperation?.value
        var publications: [CGDirectDisplayID: DesktopHostPublication] = [:]
        for plan in plans {
          let advertisesQUIC = quicDisplayIDs.contains(plan.display.id) && quicCertHash != nil
          publications[plan.display.id] = try await desktopRegistrationLifecycle.publish(
            identity: plan.registrationIdentity(base: identity),
            port: plan.port,
            quicPort: advertisesQUIC ? Self.quicPort + UInt16(plan.index) : nil,
            quicCertHash: advertisesQUIC ? quicCertHash : nil,
            webtransport: false)
        }
        guard
          self?.isCurrentRegistryOperation(operationGeneration) == true,
          self?.serverGeneration == generation
        else { return }
        self?.registryPhase = .registered
        self?.relayPublications = publications
        self?.startRelayPublishersIfPossible(generation: generation)
      } catch {
        guard
          self?.isCurrentRegistryOperation(operationGeneration) == true,
          self?.serverGeneration == generation
        else { return }
        self?.registryPhase = .failed(error.localizedDescription)
        if let self {
          for publisher in relayPublishers.values { publisher.stop() }
          relayPublishers.removeAll()
          relayPublications.removeAll()
        }
      }
      if self?.publishingServerGeneration == generation {
        self?.publishingServerGeneration = nil
      }
      self?.finishRegistryOperation(operationGeneration)
    }
  }

  private func removeDesktopHost(after pendingRegistration: Task<Void, Never>?) {
    for publisher in relayPublishers.values { publisher.stop() }
    relayPublishers.removeAll()
    relayPublications.removeAll()
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

  private func updateBrowserRelay() {
    guard browserAccessEnabled else {
      for publisher in relayPublishers.values { publisher.stop() }
      relayPublishers.removeAll()
      return
    }
    guard let generation = serverGeneration else { return }
    startRelayPublishersIfPossible(generation: generation)
  }

  private func startRelayPublishersIfPossible(generation: UInt64) {
    guard
      browserAccessEnabled,
      serverGeneration == generation,
      registryPhase == .registered,
      let relayHostURL
    else { return }

    for stack in displayStacks where relayPublishers[stack.plan.display.id] == nil {
      let displayID = stack.plan.display.id
      guard
        let publication = relayPublications[displayID],
        let relayAccess = publication.relayAccess,
        let endpoint = relayHostURL(publication.hostID)
      else { continue }

      let publisher = RelayHostPublisher(
        endpoint: endpoint,
        relayAccess: relayAccess,
        capture: stack.capture,
        descriptor: stack.descriptor,
        input: stack.input,
        clipboard: clipboardBridge,
        sharedFolder: activeSharedFolder?.configuration,
        sessionGate: stack.sessionGate,
        eventHandler: { [weak self] event in
          Task { @MainActor in
            self?.handle(
              event,
              displayID: displayID,
              transport: .relay,
              generation: generation)
          }
        }
      )
      publisher.setViewOnly(viewOnlyEnabled)
      publisher.setAudioEnabled(streamAudioEnabled && stack.plan.index == 0)
      publisher.setQualityMode(qualityMode)
      relayPublishers[displayID] = publisher
      publisher.start()
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
