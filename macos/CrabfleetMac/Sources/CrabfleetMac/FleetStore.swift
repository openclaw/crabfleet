import AppKit
import Foundation

@MainActor
final class FleetStore: ObservableObject {
  private struct BoundCredential {
    let origin: DeploymentOrigin
    let token: String
  }

  enum ConnectionPhase: Equatable {
    case disconnected
    case restoring
    case requestingAuthorization
    case waitingForApproval
    case connected
    case disconnecting
    case failed
  }

  @Published private(set) var leases: [CrabboxLease] = []
  @Published private(set) var desktopHosts: [RegisteredDesktopHost] = []
  @Published private(set) var isRefreshing = false
  @Published private(set) var lastUpdated: Date?
  @Published private(set) var notice: String?
  @Published private(set) var connectionPhase: ConnectionPhase = .disconnected
  @Published private(set) var connectionError: String?
  @Published private(set) var verificationURL: URL?
  @Published private(set) var connectedOrigin: DeploymentOrigin?
  @Published private(set) var session: NativeAPISession?
  @Published private(set) var currentUser = NSUserName()
  @Published private(set) var suggestedDeploymentURL: String

  private let originStore: DeploymentOriginStoring
  private let tokenStore: APIAccessTokenStoring
  private let clientFactory: (DeploymentOrigin) -> NativeAPIClientProtocol
  private let openURL: (URL) -> Bool
  private let sleep: (Duration) async throws -> Void
  private let now: () -> Date

  private var client: NativeAPIClientProtocol?
  private var credential: BoundCredential?
  private var authorizationTask: Task<Void, Never>?
  private var connectionGeneration: UInt64 = 0
  private var refreshOperationID: UUID?

  init(
    environment: [String: String] = ProcessInfo.processInfo.environment,
    originStore: DeploymentOriginStoring = UserDefaultsDeploymentOriginStore(),
    tokenStore: APIAccessTokenStoring = KeychainAPIAccessTokenStore(),
    clientFactory: @escaping (DeploymentOrigin) -> NativeAPIClientProtocol = {
      NativeAPIClient(origin: $0)
    },
    openURL: @escaping (URL) -> Bool = { NSWorkspace.shared.open($0) },
    sleep: @escaping (Duration) async throws -> Void = { try await Task.sleep(for: $0) },
    now: @escaping () -> Date = Date.init
  ) {
    self.originStore = originStore
    self.tokenStore = tokenStore
    self.clientFactory = clientFactory
    self.openURL = openURL
    self.sleep = sleep
    self.now = now
    self.suggestedDeploymentURL =
      originStore.load() ?? environment["CRABFLEET_API_URL"] ?? ""
  }

  var isConnected: Bool {
    guard let connectedOrigin, let client, let credential else { return false }
    return connectionPhase == .connected
      && client.origin == connectedOrigin
      && credential.origin == connectedOrigin
  }

  var deploymentLabel: String {
    if let label = session?.deployment.label, !label.isEmpty { return label }
    return connectedOrigin?.url.host ?? "Crabfleet"
  }

  var accountLabel: String {
    session?.user.displayName ?? currentUser
  }

  var canRetrySavedSession: Bool {
    guard let connectedOrigin, let credential else { return false }
    return credential.origin == connectedOrigin
  }

  func restore() async {
    let previousOperation = authorizationTask
    let previousClient = client
    previousOperation?.cancel()
    authorizationTask = nil
    client = nil
    if let previousClient {
      retireClient(previousClient, after: previousOperation)
    }
    let generation = beginConnectionTransition()
    clearInMemoryConnectionState(clearOrigin: true)
    connectionError = nil
    notice = nil

    guard let storedValue = originStore.load(), !storedValue.isEmpty else {
      connectionPhase = .disconnected
      return
    }

    do {
      let origin = try DeploymentOrigin(storedValue)
      suggestedDeploymentURL = origin.displayValue
      connectedOrigin = origin
      guard let token = try tokenStore.load(for: origin), !token.isEmpty else {
        connectionPhase = .disconnected
        return
      }
      connectionPhase = .restoring
      let api = clientFactory(origin)
      client = api
      credential = .init(origin: origin, token: token)
      let validatedSession = try await authenticatedRead(
        api: api,
        token: token,
        origin: origin,
        generation: generation,
        operation: api.session(accessToken:)
      )
      guard isCurrent(generation) else { return }
      applySession(validatedSession.value)
      connectionPhase = .connected
      await refresh(expectedGeneration: generation)
    } catch {
      await handleConnectionFailure(error, expectedGeneration: generation)
    }
  }

  func connect(to rawValue: String) {
    connectionError = nil
    notice = nil

    let origin: DeploymentOrigin
    do {
      origin = try DeploymentOrigin(rawValue)
    } catch {
      connectionPhase = .failed
      connectionError = error.localizedDescription
      return
    }

    if let previousOrigin = connectedOrigin {
      do {
        try tokenStore.delete(for: previousOrigin)
      } catch {
        reportLocalCredentialCleanupFailure(error, action: "connect to another deployment")
        return
      }
    }

    let previousOperation = authorizationTask
    let previousClient = client
    let previousToken = credential?.origin == connectedOrigin ? credential?.token : nil
    previousOperation?.cancel()
    authorizationTask = nil
    client = nil
    credential = nil
    if let previousClient {
      retireClient(previousClient, revoking: previousToken, after: previousOperation)
    }
    let generation = beginConnectionTransition()
    suggestedDeploymentURL = origin.displayValue
    originStore.save(origin.displayValue)
    connectedOrigin = origin
    let api = clientFactory(origin)
    client = api
    session = nil
    leases = []
    desktopHosts = []
    lastUpdated = nil

    authorizationTask = Task { [weak self, api] in
      guard let self else {
        api.close()
        return
      }
      await authorize(origin: origin, api: api, generation: generation)
      closeFailedClientIfCurrent(api: api, expectedGeneration: generation)
    }
  }

  func retrySavedSession() {
    guard let origin = connectedOrigin, let credential, credential.origin == origin else {
      connect(to: suggestedDeploymentURL)
      return
    }
    let token = credential.token
    let previousOperation = authorizationTask
    previousOperation?.cancel()
    if let previousOperation, let previousClient = client {
      authorizationTask = nil
      client = nil
      retireClient(previousClient, after: previousOperation)
    }
    let generation = beginConnectionTransition()
    let api = client ?? clientFactory(origin)
    client = api
    authorizationTask = Task { [weak self, api] in
      guard let self else {
        api.close()
        return
      }
      connectionError = nil
      connectionPhase = .restoring
      do {
        let validatedSession = try await authenticatedRead(
          api: api,
          token: token,
          origin: origin,
          generation: generation,
          operation: api.session(accessToken:)
        )
        try Task.checkCancellation()
        guard isCurrent(generation) else { return }
        applySession(validatedSession.value)
        connectionPhase = .connected
        authorizationTask = nil
        await refresh(expectedGeneration: generation)
      } catch {
        guard isCurrent(generation) else { return }
        authorizationTask = nil
        await handleConnectionFailure(error, expectedGeneration: generation)
      }
    }
  }

  func cancelAuthorization() {
    let operation = authorizationTask
    let api = client
    operation?.cancel()
    _ = beginConnectionTransition()
    authorizationTask = nil
    client = nil
    verificationURL = nil
    connectionError = nil
    connectionPhase = .disconnected
    if let api {
      retireClient(api, after: operation)
    }
  }

  func openVerificationPage() {
    guard let verificationURL else { return }
    if !openURL(verificationURL) {
      connectionError = "The authorization page could not be opened."
    }
  }

  func disconnect() {
    let api = client
    let origin = connectedOrigin
    let token = credential?.origin == origin ? credential?.token : nil
    let operation = authorizationTask

    if let origin {
      do {
        try tokenStore.delete(for: origin)
      } catch {
        reportLocalCredentialCleanupFailure(error, action: "disconnect")
        return
      }
    }

    operation?.cancel()
    _ = beginConnectionTransition()
    authorizationTask = nil
    client = nil
    clearConnection()
    connectionError = nil
    connectionPhase = .disconnected
    if let api {
      retireClient(api, revoking: token, after: operation)
    }
  }

  func refresh() async {
    await refresh(expectedGeneration: connectionGeneration)
  }

  func nativeVNCGrant(sessionID: String) async throws -> NativeVNCGrant {
    let generation = connectionGeneration
    guard let client, let connectedOrigin, let credential,
      credential.origin == connectedOrigin,
      client.origin == connectedOrigin,
      connectionPhase == .connected
    else {
      throw NativeAPIError.unauthorized
    }
    do {
      return try await authenticatedRead(
        api: client,
        token: credential.token,
        origin: connectedOrigin,
        generation: generation,
        operation: { token in
          try await client.nativeVNCGrant(sessionID: sessionID, accessToken: token)
        }
      ).value
    } catch NativeAPIError.unauthorized {
      await expireCredential(
        message: NativeAPIError.unauthorized.localizedDescription,
        expectedGeneration: generation
      )
      throw NativeAPIError.unauthorized
    }
  }

  private func refresh(expectedGeneration: UInt64) async {
    guard isCurrent(expectedGeneration), !isRefreshing, let client, let connectedOrigin,
      let credential, credential.origin == connectedOrigin, client.origin == connectedOrigin,
      connectionPhase == .connected
    else {
      return
    }
    let accessToken = credential.token
    let operationID = UUID()
    refreshOperationID = operationID
    isRefreshing = true
    defer {
      if refreshOperationID == operationID {
        refreshOperationID = nil
        isRefreshing = false
      }
    }

    do {
      let refreshedFleet = try await authenticatedRead(
        api: client,
        token: accessToken,
        origin: connectedOrigin,
        generation: expectedGeneration,
        operation: client.fleet(accessToken:)
      )
      guard isCurrent(expectedGeneration), refreshOperationID == operationID else { return }
      leases = refreshedFleet.value.leases
      desktopHosts = refreshedFleet.value.desktopHosts
      notice = nil
      lastUpdated = now()
    } catch NativeAPIError.unauthorized {
      guard isCurrent(expectedGeneration), refreshOperationID == operationID else { return }
      await expireCredential(
        message: NativeAPIError.unauthorized.localizedDescription,
        expectedGeneration: expectedGeneration
      )
    } catch {
      guard isCurrent(expectedGeneration), refreshOperationID == operationID else { return }
      notice = "Fleet refresh failed · \(error.localizedDescription)"
    }
  }

  private func authorize(
    origin: DeploymentOrigin,
    api: NativeAPIClientProtocol,
    generation: UInt64
  ) async {
    guard isCurrent(generation), client === api else { return }
    connectionPhase = .requestingAuthorization
    do {
      let start = try await api.beginAuthorization(
        clientName: "Crabfleet for macOS"
      )
      if Task.isCancelled {
        if case .approved(let approved) = start {
          await revokeInFreshTask(approved.value, using: api)
        }
        throw CancellationError()
      }
      guard isCurrent(generation) else {
        if case .approved(let approved) = start {
          await revokeInFreshTask(approved.value, using: api)
        }
        return
      }
      if case .approved(let approved) = start {
        var provisionalCredential = approved.value
        do {
          let validatedSession = try await validateOAuthApprovedSession(
            api: api,
            token: approved.value,
            expiresAt: approved.expiresAt,
            origin: origin,
            generation: generation
          )
          provisionalCredential = validatedSession.credential
          if Task.isCancelled {
            throw CancellationError()
          }
          guard isCurrent(generation) else {
            await revokeInFreshTask(provisionalCredential, using: api)
            return
          }
          try tokenStore.save(provisionalCredential, for: origin)
          credential = .init(origin: origin, token: provisionalCredential)
          applySession(validatedSession.value)
          verificationURL = nil
          connectionPhase = .connected
          authorizationTask = nil
          await refresh(expectedGeneration: generation)
          return
        } catch {
          await revokeInFreshTask(provisionalCredential, using: api)
          throw error
        }
      }
      guard case .device(let authorization) = start else {
        throw NativeAPIError.invalidResponse
      }
      verificationURL = authorization.verificationURL
      connectionPhase = .waitingForApproval
      guard openURL(authorization.verificationURL) else {
        throw FleetConnectionError.cannotOpenBrowser
      }

      try await sleep(.seconds(max(authorization.intervalSeconds, 5)))
      while now() < authorization.expiresAt {
        try Task.checkCancellation()
        let exchange: NativeTokenExchange
        do {
          exchange = try await api.exchangeDeviceCode(authorization.deviceCode)
        } catch {
          guard transientAuthRequestError(error) else { throw error }
          connectionError = "The deployment is temporarily unavailable. Retrying this authorization…"
          try await sleep(.seconds(max(authorization.intervalSeconds, 5)))
          continue
        }
        switch exchange {
        case .pending:
          connectionError = nil
          let interval = max(authorization.intervalSeconds, 5)
          try await sleep(.seconds(interval))
        case .approved(let approved):
          connectionError = nil
          let validatedSession: NativeAPISession
          do {
            try Task.checkCancellation()
            validatedSession = try await validateApprovedSession(
              api: api,
              token: approved.value,
              authorization: authorization,
              generation: generation
            )
            try Task.checkCancellation()
            guard isCurrent(generation) else {
              await revokeInFreshTask(approved.value, using: api)
              return
            }
            try tokenStore.save(approved.value, for: origin)
          } catch {
            await revokeInFreshTask(approved.value, using: api)
            throw error
          }
          credential = .init(origin: origin, token: approved.value)
          applySession(validatedSession)
          verificationURL = nil
          connectionPhase = .connected
          authorizationTask = nil
          await refresh(expectedGeneration: generation)
          return
        }
      }
      throw NativeAPIError.authorizationExpired
    } catch is CancellationError {
      guard isCurrent(generation) else { return }
      authorizationTask = nil
      if connectionPhase != .disconnecting {
        connectionPhase = .disconnected
      }
    } catch {
      guard isCurrent(generation) else { return }
      authorizationTask = nil
      await handleConnectionFailure(error, expectedGeneration: generation)
    }
  }

  private func applySession(_ session: NativeAPISession) {
    self.session = session
    currentUser = session.user.login ?? session.user.email ?? session.user.subject
  }

  private func authenticatedRead<Value>(
    api: NativeAPIClientProtocol,
    token: String,
    origin: DeploymentOrigin,
    generation: UInt64,
    persistRotatedCredential: Bool = true,
    preserveRotatedCredentialOnTransientFailure: Bool = false,
    operation: (String) async throws -> Value
  ) async throws -> (value: Value, credential: String) {
    try Task.checkCancellation()
    guard isCurrent(generation), client === api, connectedOrigin == origin else {
      throw CancellationError()
    }
    do {
      let value = try await operation(token)
      try Task.checkCancellation()
      guard isCurrent(generation), client === api, connectedOrigin == origin else {
        throw CancellationError()
      }
      return (value, token)
    } catch NativeAPIError.unauthorized {
      try Task.checkCancellation()
      guard isCurrent(generation), client === api, connectedOrigin == origin else {
        throw CancellationError()
      }
      guard let refreshed = try await api.refreshCredential(accessToken: token) else {
        throw NativeAPIError.unauthorized
      }
      var adopted = false
      do {
        try Task.checkCancellation()
        guard isCurrent(generation), client === api, connectedOrigin == origin else {
          throw CancellationError()
        }
        if persistRotatedCredential {
          try tokenStore.save(refreshed, for: origin)
          credential = .init(origin: origin, token: refreshed)
          adopted = true
        }
        let value = try await operation(refreshed)
        try Task.checkCancellation()
        guard isCurrent(generation), client === api, connectedOrigin == origin else {
          throw CancellationError()
        }
        return (value, refreshed)
      } catch {
        if !adopted,
          preserveRotatedCredentialOnTransientFailure,
          transientAuthRequestError(error)
        {
          throw RotatedCredentialReadError(credential: refreshed, underlying: error)
        }
        if !adopted || (error as? NativeAPIError) == .unauthorized {
          await revokeInFreshTask(refreshed, using: api)
        }
        throw error
      }
    }
  }

  private func validateOAuthApprovedSession(
    api: NativeAPIClientProtocol,
    token: String,
    expiresAt: Date,
    origin: DeploymentOrigin,
    generation: UInt64
  ) async throws -> (value: NativeAPISession, credential: String) {
    let deadline = min(expiresAt, now().addingTimeInterval(60))
    var currentCredential = token
    var hasProvisionalRotation = false
    while now() < deadline {
      let validationError: Error
      do {
        return try await authenticatedRead(
          api: api,
          token: currentCredential,
          origin: origin,
          generation: generation,
          persistRotatedCredential: false,
          preserveRotatedCredentialOnTransientFailure: true,
          operation: api.session(accessToken:)
        )
      } catch let rotated as RotatedCredentialReadError {
        if hasProvisionalRotation {
          await revokeInFreshTask(currentCredential, using: api)
        }
        currentCredential = rotated.credential
        hasProvisionalRotation = true
        validationError = rotated.underlying
      } catch is CancellationError {
        if hasProvisionalRotation {
          await revokeInFreshTask(currentCredential, using: api)
        }
        throw CancellationError()
      } catch {
        validationError = error
      }
      guard transientAuthRequestError(validationError) else {
        if hasProvisionalRotation {
          await revokeInFreshTask(currentCredential, using: api)
        }
        throw validationError
      }
      let remaining = deadline.timeIntervalSince(now())
      guard remaining > 0 else { break }
      connectionError = "Authorization succeeded. Waiting for the deployment session API…"
      do {
        try await sleep(.seconds(min(5, remaining)))
      } catch {
        if hasProvisionalRotation {
          await revokeInFreshTask(currentCredential, using: api)
        }
        throw error
      }
    }
    if hasProvisionalRotation {
      await revokeInFreshTask(currentCredential, using: api)
    }
    throw NativeAPIError.authorizationExpired
  }

  private func handleConnectionFailure(_ error: Error, expectedGeneration: UInt64) async {
    guard isCurrent(expectedGeneration) else { return }
    verificationURL = nil
    if case NativeAPIError.unauthorized = error {
      await expireCredential(
        message: error.localizedDescription,
        expectedGeneration: expectedGeneration
      )
      return
    }
    connectionError = error.localizedDescription
    connectionPhase = .failed
  }

  private func expireCredential(message: String, expectedGeneration: UInt64) async {
    guard isCurrent(expectedGeneration) else { return }
    let expiredClient = client
    if let connectedOrigin {
      try? tokenStore.delete(for: connectedOrigin)
    }
    guard isCurrent(expectedGeneration) else { return }
    _ = beginConnectionTransition()
    credential = nil
    client = nil
    session = nil
    leases = []
    desktopHosts = []
    lastUpdated = nil
    connectionError = message
    connectionPhase = .failed
    expiredClient?.close()
  }

  @discardableResult
  private func beginConnectionTransition() -> UInt64 {
    connectionGeneration &+= 1
    refreshOperationID = nil
    isRefreshing = false
    return connectionGeneration
  }

  private func isCurrent(_ generation: UInt64) -> Bool {
    connectionGeneration == generation
  }

  private func validateApprovedSession(
    api: NativeAPIClientProtocol,
    token: String,
    authorization: NativeDeviceAuthorization,
    generation: UInt64
  ) async throws -> NativeAPISession {
    while now() < authorization.expiresAt {
      try Task.checkCancellation()
      guard isCurrent(generation) else { throw CancellationError() }
      do {
        let validatedSession = try await api.session(accessToken: token)
        try Task.checkCancellation()
        guard isCurrent(generation) else { throw CancellationError() }
        guard now() < authorization.expiresAt else {
          throw NativeAPIError.authorizationExpired
        }
        connectionError = nil
        return validatedSession
      } catch is CancellationError {
        throw CancellationError()
      } catch {
        guard transientAuthRequestError(error) else { throw error }
        let remaining = authorization.expiresAt.timeIntervalSince(now())
        guard remaining > 0 else { throw NativeAPIError.authorizationExpired }
        connectionError = "Authorization succeeded. Waiting for the deployment session API…"
        let interval = min(max(authorization.intervalSeconds, 5), remaining)
        try await sleep(.seconds(interval))
      }
    }
    throw NativeAPIError.authorizationExpired
  }

  private func transientAuthRequestError(_ error: Error) -> Bool {
    if case NativeAPIError.httpStatus(let status, _) = error {
      return status == 503
    }
    guard let urlError = error as? URLError else { return false }
    switch urlError.code {
    case .timedOut,
      .cannotFindHost,
      .cannotConnectToHost,
      .networkConnectionLost,
      .dnsLookupFailed,
      .notConnectedToInternet,
      .resourceUnavailable,
      .internationalRoamingOff,
      .callIsActive,
      .dataNotAllowed:
      return true
    default:
      return false
    }
  }

  private func revokeInFreshTask(_ token: String, using api: NativeAPIClientProtocol) async {
    let task = Task<Void, Never> {
      do {
        try await api.revoke(accessToken: token)
      } catch {
        // Revocation is best-effort; local credential removal remains authoritative.
      }
    }
    await task.value
  }

  private func retireClient(
    _ api: NativeAPIClientProtocol,
    revoking token: String? = nil,
    after operation: Task<Void, Never>? = nil
  ) {
    Task {
      if let operation {
        // A canceled authorization may still need to revoke a just-approved token.
        await operation.value
      }
      if let token {
        try? await api.revoke(accessToken: token)
      }
      api.close()
    }
  }

  private func closeFailedClientIfCurrent(
    api: NativeAPIClientProtocol?,
    expectedGeneration: UInt64
  ) {
    guard let api, isCurrent(expectedGeneration), connectionPhase != .connected, client === api
    else { return }
    client = nil
    api.close()
  }

  private func reportLocalCredentialCleanupFailure(_ error: Error, action: String) {
    let message =
      "Keychain cleanup failed, so Crabfleet did not \(action). The existing connection was kept; retry after Keychain is available. \(error.localizedDescription)"
    connectionError = message
    notice = message
  }

  private func clearConnection() {
    credential = nil
    session = nil
    leases = []
    desktopHosts = []
    lastUpdated = nil
    notice = nil
    verificationURL = nil
    currentUser = NSUserName()
  }

  private func clearInMemoryConnectionState(clearOrigin: Bool) {
    credential = nil
    session = nil
    leases = []
    desktopHosts = []
    lastUpdated = nil
    verificationURL = nil
    currentUser = NSUserName()
    if clearOrigin {
      connectedOrigin = nil
    }
  }
}

enum FleetConnectionError: LocalizedError {
  case cannotOpenBrowser

  var errorDescription: String? {
    "The authorization page could not be opened."
  }
}

private struct RotatedCredentialReadError: Error {
  let credential: String
  let underlying: Error
}
