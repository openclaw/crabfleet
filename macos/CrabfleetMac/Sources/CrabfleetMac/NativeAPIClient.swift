import Foundation

struct NativeAPIUser: Codable, Equatable, Sendable {
  let subject: String
  let login: String?
  let email: String?
  let name: String?
  let role: String

  var displayName: String {
    let candidates = [name, login, email, subject]
    return candidates.compactMap { value in
      guard let value, !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
        return nil
      }
      return value
    }.first ?? "Crabfleet user"
  }
}

struct NativeAPIDeployment: Codable, Equatable, Sendable {
  let label: String?
  let canonicalUrl: String?
  let productUrl: String?
  let sshHost: String?
}

struct NativeAPISession: Equatable, Sendable {
  let user: NativeAPIUser
  let deployment: NativeAPIDeployment
}

struct NativeAPIFleet: Equatable, Sendable {
  let leases: [CrabboxLease]
  let desktopHosts: [RegisteredDesktopHost]
}

struct NativeDeviceAuthorization: Equatable, Sendable {
  let deviceCode: String
  let verificationURL: URL
  let expiresAt: Date
  let intervalSeconds: TimeInterval
}

struct NativeAccessToken: Equatable, Sendable {
  let value: String
  let expiresAt: Date
  let user: NativeAPIUser
}

enum NativeAuthorizationStart: Equatable, Sendable {
  case device(NativeDeviceAuthorization)
  case approved(NativeAccessToken)
}

enum NativeTokenExchange: Equatable, Sendable {
  case pending
  case approved(NativeAccessToken)
}

protocol NativeAPIClientProtocol: AnyObject {
  var origin: DeploymentOrigin { get }
  func beginAuthorization(clientName: String) async throws -> NativeAuthorizationStart
  func createDeviceAuthorization(clientName: String) async throws -> NativeDeviceAuthorization
  func exchangeDeviceCode(_ deviceCode: String) async throws -> NativeTokenExchange
  func session(accessToken: String) async throws -> NativeAPISession
  func fleet(accessToken: String) async throws -> NativeAPIFleet
  func refreshCredential(accessToken: String) async throws -> String?
  func revoke(accessToken: String) async throws
  @MainActor
  func close()
}

extension NativeAPIClientProtocol {
  func beginAuthorization(clientName: String) async throws -> NativeAuthorizationStart {
    .device(try await createDeviceAuthorization(clientName: clientName))
  }

  func refreshCredential(accessToken: String) async throws -> String? { nil }
}

protocol HTTPDataTransport {
  func data(for request: URLRequest) async throws -> (Data, HTTPURLResponse)
  func close()
}

struct BoundedResponseBody {
  let maximumBytes: Int
  private(set) var data = Data()

  init(maximumBytes: Int) {
    self.maximumBytes = max(0, maximumBytes)
  }

  mutating func append(_ chunk: Data) throws {
    guard chunk.count <= maximumBytes - data.count else {
      throw NativeAPIError.responseTooLarge
    }
    data.append(chunk)
  }
}

final class RejectingRedirectURLSessionTransport: NSObject, HTTPDataTransport,
  URLSessionDataDelegate, @unchecked Sendable
{
  private let maximumResponseBytes: Int
  private let taskRegistrationHook: (() -> Void)?
  private let stateLock = NSLock()
  private var receiveStates: [Int: ReceiveState] = [:]
  private var session: URLSession?
  private var isClosed = false

  init(
    maximumResponseBytes: Int = 5 * 1_024 * 1_024,
    taskRegistrationHook: (() -> Void)? = nil
  ) {
    self.maximumResponseBytes = max(0, maximumResponseBytes)
    self.taskRegistrationHook = taskRegistrationHook
    super.init()
  }

  private func sessionForRequestLocked() -> URLSession {
    if let session { return session }
    let configuration = URLSessionConfiguration.ephemeral
    configuration.httpCookieStorage = nil
    configuration.httpShouldSetCookies = false
    configuration.urlCache = nil
    configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
    let session = URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
    self.session = session
    return session
  }

  func data(for request: URLRequest) async throws -> (Data, HTTPURLResponse) {
    let cancellation = DataTaskCancellation()
    return try await withTaskCancellationHandler {
      try await withCheckedThrowingContinuation { continuation in
        let task: URLSessionDataTask
        let wasCancelled: Bool

        stateLock.lock()
        guard !isClosed else {
          stateLock.unlock()
          continuation.resume(throwing: CancellationError())
          return
        }
        let session = sessionForRequestLocked()
        task = session.dataTask(with: request)
        let state = ReceiveState(
          body: .init(maximumBytes: maximumResponseBytes),
          continuation: continuation
        )
        receiveStates[task.taskIdentifier] = state
        wasCancelled = cancellation.install(task)
        taskRegistrationHook?()
        stateLock.unlock()

        task.resume()
        if wasCancelled { task.cancel() }
      }
    } onCancel: {
      cancellation.cancel()
    }
  }

  func close() {
    stateLock.lock()
    guard !isClosed else {
      stateLock.unlock()
      return
    }
    isClosed = true
    let session = session
    self.session = nil
    stateLock.unlock()
    session?.invalidateAndCancel()
  }

  func urlSession(
    _ session: URLSession,
    task: URLSessionTask,
    willPerformHTTPRedirection response: HTTPURLResponse,
    newRequest request: URLRequest,
    completionHandler: @escaping (URLRequest?) -> Void
  ) {
    completionHandler(nil)
  }

  func urlSession(
    _ session: URLSession,
    dataTask: URLSessionDataTask,
    didReceive response: URLResponse,
    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void
  ) {
    guard let http = response as? HTTPURLResponse else {
      completionHandler(.cancel)
      finish(dataTask, result: .failure(NativeAPIError.invalidResponse))
      return
    }
    if http.expectedContentLength > Int64(maximumResponseBytes) {
      completionHandler(.cancel)
      finish(dataTask, result: .failure(NativeAPIError.responseTooLarge))
      return
    }

    stateLock.lock()
    receiveStates[dataTask.taskIdentifier]?.response = http
    stateLock.unlock()
    completionHandler(.allow)
  }

  func urlSession(
    _ session: URLSession,
    dataTask: URLSessionDataTask,
    didReceive data: Data
  ) {
    var failedState: ReceiveState?
    stateLock.lock()
    if let state = receiveStates[dataTask.taskIdentifier] {
      do {
        try state.body.append(data)
      } catch {
        failedState = receiveStates.removeValue(forKey: dataTask.taskIdentifier)
      }
    }
    stateLock.unlock()

    if let failedState {
      dataTask.cancel()
      failedState.continuation.resume(throwing: NativeAPIError.responseTooLarge)
    }
  }

  func urlSession(
    _ session: URLSession,
    task: URLSessionTask,
    didCompleteWithError error: Error?
  ) {
    guard let state = takeState(for: task.taskIdentifier) else { return }
    if let error {
      if (error as? URLError)?.code == .cancelled {
        state.continuation.resume(throwing: CancellationError())
      } else {
        state.continuation.resume(throwing: error)
      }
      return
    }
    guard let response = state.response else {
      state.continuation.resume(throwing: NativeAPIError.invalidResponse)
      return
    }
    state.continuation.resume(returning: (state.body.data, response))
  }

  private func finish(
    _ task: URLSessionTask,
    result: Result<(Data, HTTPURLResponse), Error>
  ) {
    guard let state = takeState(for: task.taskIdentifier) else { return }
    state.continuation.resume(with: result)
  }

  private func takeState(for taskIdentifier: Int) -> ReceiveState? {
    stateLock.lock()
    defer { stateLock.unlock() }
    return receiveStates.removeValue(forKey: taskIdentifier)
  }

  private final class ReceiveState {
    var body: BoundedResponseBody
    var response: HTTPURLResponse?
    let continuation: CheckedContinuation<(Data, HTTPURLResponse), Error>

    init(
      body: BoundedResponseBody,
      continuation: CheckedContinuation<(Data, HTTPURLResponse), Error>
    ) {
      self.body = body
      self.continuation = continuation
    }
  }

  private final class DataTaskCancellation: @unchecked Sendable {
    private let lock = NSLock()
    private var task: URLSessionDataTask?
    private var isCancelled = false

    func install(_ task: URLSessionDataTask) -> Bool {
      lock.lock()
      defer { lock.unlock() }
      self.task = task
      return isCancelled
    }

    func cancel() {
      lock.lock()
      isCancelled = true
      let task = task
      lock.unlock()
      task?.cancel()
    }
  }
}

final class NativeAPIClient: NativeAPIClientProtocol {
  let origin: DeploymentOrigin

  private let transport: HTTPDataTransport
  private let oauthAuthorizer: OAuthGatewayAuthorizing
  private let encoder = JSONEncoder()
  private let decoder = JSONDecoder()
  private let maximumResponseBytes = 5 * 1_024 * 1_024
  private let lifecycleLock = NSLock()
  private var isClosed = false

  init(
    origin: DeploymentOrigin,
    transport: HTTPDataTransport = RejectingRedirectURLSessionTransport(),
    oauthAuthorizer: OAuthGatewayAuthorizing = OAuthGatewayAuthorizer()
  ) {
    self.origin = origin
    self.transport = transport
    self.oauthAuthorizer = oauthAuthorizer
  }

  deinit {
    close()
  }

  nonisolated func close() {
    lifecycleLock.lock()
    guard !isClosed else {
      lifecycleLock.unlock()
      return
    }
    isClosed = true
    lifecycleLock.unlock()
    transport.close()
  }

  func beginAuthorization(clientName: String) async throws -> NativeAuthorizationStart {
    do {
      return .device(try await createDeviceAuthorization(clientName: clientName))
    } catch NativeAPIError.redirectRejected {
      let token = try await oauthAuthorizer.authorize(origin: origin, transport: transport)
      return .approved(
        .init(
          value: NativeStoredCredential.oauth(token),
          expiresAt: token.expiresAt,
          user: .init(
            subject: "oauth:pending",
            login: nil,
            email: nil,
            name: nil,
            role: "viewer"
          )
        ))
    }
  }

  func createDeviceAuthorization(clientName: String) async throws -> NativeDeviceAuthorization {
    let response = try await request(
      path: "/api/native/v1/auth/device",
      method: "POST",
      body: DeviceRequest(clientName: clientName)
    )
    guard response.statusCode == 201 || response.statusCode == 200 else {
      throw error(for: response)
    }
    let payload = try decode(DeviceResponse.self, from: response.data)
    guard
      !payload.deviceCode.isEmpty,
      payload.deviceCode.utf8.count <= 512,
      let verificationURL = URL(string: payload.verificationUri),
      validVerificationURL(verificationURL)
    else {
      throw NativeAPIError.invalidResponse
    }
    let expiresAt = date(from: payload.expiresAt)
    guard expiresAt > Date() else { throw NativeAPIError.authorizationExpired }
    guard payload.intervalSeconds >= 5, payload.intervalSeconds <= 60 else {
      throw NativeAPIError.invalidResponse
    }
    return .init(
      deviceCode: payload.deviceCode,
      verificationURL: verificationURL,
      expiresAt: expiresAt,
      intervalSeconds: payload.intervalSeconds
    )
  }

  func exchangeDeviceCode(_ deviceCode: String) async throws -> NativeTokenExchange {
    let response = try await request(
      path: "/api/native/v1/auth/token",
      method: "POST",
      body: TokenRequest(deviceCode: deviceCode)
    )
    if response.statusCode == 202 {
      return .pending
    }
    if response.statusCode == 429,
      (try? decoder.decode(ErrorResponse.self, from: response.data).error) == "slow_down"
    {
      return .pending
    }
    guard response.statusCode == 200 else { throw error(for: response) }
    let payload = try decode(TokenResponse.self, from: response.data)
    guard payload.tokenType.caseInsensitiveCompare("Bearer") == .orderedSame,
      !payload.accessToken.isEmpty,
      payload.accessToken.utf8.count <= 2_048
    else {
      throw NativeAPIError.invalidResponse
    }
    let expiresAt = date(from: payload.expiresAt)
    guard expiresAt > Date() else { throw NativeAPIError.authorizationExpired }
    return .approved(
      .init(value: payload.accessToken, expiresAt: expiresAt, user: payload.user)
    )
  }

  func session(accessToken: String) async throws -> NativeAPISession {
    let credential = NativeStoredCredential(accessToken)
    let response = try await request(
      path: credential.kind == .oauth
        ? "/mcp/crabfleet/native/v1/session"
        : "/api/native/v1/session",
      method: "GET",
      accessToken: credential.value
    )
    guard response.statusCode == 200 else { throw error(for: response) }
    if credential.kind == .oauth {
      let payload = try decode(OAuthSessionResponse.self, from: response.data)
      return .init(
        user: payload.user,
        deployment: .init(
          label: origin.url.host,
          canonicalUrl: origin.displayValue,
          productUrl: nil,
          sshHost: nil
        )
      )
    }
    let payload = try decode(SessionResponse.self, from: response.data)
    return .init(user: payload.user, deployment: payload.deployment)
  }

  func fleet(accessToken: String) async throws -> NativeAPIFleet {
    let credential = NativeStoredCredential(accessToken)
    let response = try await request(
      path: credential.kind == .oauth
        ? "/mcp/crabfleet/native/v1/fleet"
        : "/api/native/v1/fleet",
      method: "GET",
      accessToken: credential.value
    )
    guard response.statusCode == 200 else { throw error(for: response) }
    let payload = try decode(FleetAPIEnvelope.self, from: response.data)
    return .init(
      leases: payload.fleet.sessions.map { $0.lease() },
      desktopHosts: (payload.fleet.desktopHosts ?? []).map { $0.desktopHost() }
    )
  }

  func refreshCredential(accessToken: String) async throws -> String? {
    let credential = NativeStoredCredential(accessToken)
    guard credential.kind == .oauth, let token = credential.oauthToken,
      token.refreshToken != nil, token.tokenEndpoint != nil,
      token.resources.allSatisfy(origin.contains)
    else {
      return nil
    }
    do {
      let refreshed = try await oauthAuthorizer.refresh(token: token, transport: transport)
      return NativeStoredCredential.oauth(refreshed)
    } catch OAuthGatewayError.tokenEndpoint(_, let error) where error == "invalid_grant" {
      throw NativeAPIError.unauthorized
    }
  }

  func revoke(accessToken: String) async throws {
    let credential = NativeStoredCredential(accessToken)
    if credential.kind == .oauth {
      guard let oauthToken = credential.oauthToken,
        !oauthToken.clientID.isEmpty,
        let endpoint = credential.oauthRevocationEndpoint
      else {
        return
      }
      var firstError: Error?
      do {
        try await oauthAuthorizer.revoke(
          token: credential.value,
          tokenTypeHint: "access_token",
          clientID: oauthToken.clientID,
          endpoint: endpoint,
          transport: transport
        )
      } catch {
        firstError = error
      }
      if let refreshToken = oauthToken.refreshToken {
        do {
          try await oauthAuthorizer.revoke(
            token: refreshToken,
            tokenTypeHint: "refresh_token",
            clientID: oauthToken.clientID,
            endpoint: endpoint,
            transport: transport
          )
        } catch {
          if firstError == nil { firstError = error }
        }
      }
      if let firstError { throw firstError }
      return
    }
    let response = try await request(
      path: "/api/native/v1/auth/token",
      method: "DELETE",
      accessToken: credential.value
    )
    if response.statusCode == 401 { return }
    guard (200..<300).contains(response.statusCode) else { throw error(for: response) }
  }

  private func request<Body: Encodable>(
    path: String,
    method: String,
    accessToken: String? = nil,
    body: Body
  ) async throws -> APIResponse {
    try await request(
      path: path,
      method: method,
      accessToken: accessToken,
      bodyData: encoder.encode(body)
    )
  }

  private func request(
    path: String,
    method: String,
    accessToken: String? = nil
  ) async throws -> APIResponse {
    try await request(path: path, method: method, accessToken: accessToken, bodyData: nil)
  }

  private func request(
    path: String,
    method: String,
    accessToken: String?,
    bodyData: Data?
  ) async throws -> APIResponse {
    let url = try origin.endpoint(path)
    var request = URLRequest(url: url)
    request.httpMethod = method
    request.timeoutInterval = 20
    request.setValue("application/json", forHTTPHeaderField: "Accept")
    if let bodyData {
      request.httpBody = bodyData
      request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    }
    if let accessToken {
      guard !accessToken.isEmpty else { throw NativeAPIError.unauthorized }
      request.setValue("Bearer \(accessToken)", forHTTPHeaderField: "Authorization")
    }

    let (data, response) = try await transport.data(for: request)
    guard let responseURL = response.url, origin.contains(responseURL) else {
      throw NativeAPIError.redirectRejected
    }
    guard data.count <= maximumResponseBytes else { throw NativeAPIError.responseTooLarge }
    if (300..<400).contains(response.statusCode) { throw NativeAPIError.redirectRejected }
    return .init(statusCode: response.statusCode, data: data)
  }

  private func decode<Value: Decodable>(_ type: Value.Type, from data: Data) throws -> Value {
    do {
      return try decoder.decode(type, from: data)
    } catch {
      throw NativeAPIError.invalidResponse
    }
  }

  private func error(for response: APIResponse) -> NativeAPIError {
    if response.statusCode == 401 { return .unauthorized }
    let message = (try? decoder.decode(ErrorResponse.self, from: response.data).error)
    return .httpStatus(response.statusCode, message)
  }

  private func date(from value: Double) -> Date {
    Date(timeIntervalSince1970: value > 10_000_000_000 ? value / 1_000 : value)
  }

  private func validVerificationURL(_ url: URL) -> Bool {
    origin.contains(url)
      && url.user == nil
      && url.password == nil
      && url.query == nil
      && url.fragment == nil
      && url.path.hasPrefix("/native/link/")
  }
}

enum NativeAPIError: LocalizedError, Equatable {
  case invalidResponse
  case redirectRejected
  case unauthorized
  case authorizationExpired
  case responseTooLarge
  case httpStatus(Int, String?)

  var errorDescription: String? {
    switch self {
    case .invalidResponse: "The deployment returned an invalid native API response."
    case .redirectRejected: "The deployment redirected an API request. No credentials were sent onward."
    case .unauthorized: "The Crabfleet session has expired. Sign in again."
    case .authorizationExpired: "Browser authorization expired. Try connecting again."
    case .responseTooLarge: "The deployment response exceeded the 5 MiB safety limit."
    case .httpStatus(let status, let message):
      message?.isEmpty == false
        ? "Crabfleet returned HTTP \(status): \(message!)"
        : "Crabfleet returned HTTP \(status)."
    }
  }
}

private struct APIResponse {
  let statusCode: Int
  let data: Data
}

private struct DeviceRequest: Encodable {
  let clientName: String
}

private struct TokenRequest: Encodable {
  let deviceCode: String
}

private struct DeviceResponse: Decodable {
  let deviceCode: String
  let verificationUri: String
  let expiresAt: Double
  let intervalSeconds: Double
}

private struct TokenResponse: Decodable {
  let accessToken: String
  let tokenType: String
  let expiresAt: Double
  let user: NativeAPIUser
}

private struct SessionResponse: Decodable {
  let user: NativeAPIUser
  let deployment: NativeAPIDeployment
}

private struct OAuthSessionResponse: Decodable {
  let user: NativeAPIUser
}

private struct NativeStoredCredential {
  enum Kind {
    case device
    case oauth
  }

  private static let legacyOAuthPrefix = "crabfleet-oauth-v1:"
  private static let legacyMetadataOAuthPrefix = "crabfleet-oauth-v2:"
  private static let oauthPrefix = "crabfleet-oauth-v3:"

  let kind: Kind
  let value: String
  let oauthToken: OAuthGatewayAccessToken?

  var oauthRevocationEndpoint: URL? { oauthToken?.revocationEndpoint }

  init(_ storedValue: String) {
    if storedValue.hasPrefix(Self.oauthPrefix) {
      kind = .oauth
      if let payload = Self.decodePayload(String(storedValue.dropFirst(Self.oauthPrefix.count))) {
        value = payload.accessToken
        oauthToken = .init(
          value: payload.accessToken,
          expiresAt: Date(timeIntervalSince1970: payload.expiresAt),
          clientID: payload.clientID,
          tokenEndpoint: URL(string: payload.tokenEndpoint),
          revocationEndpoint: payload.revocationEndpoint.flatMap(URL.init(string:)),
          refreshToken: payload.refreshToken,
          scope: payload.scope,
          resources: payload.resources.compactMap(URL.init(string:)),
          expectedAudiences: payload.expectedAudiences
        )
      } else {
        value = ""
        oauthToken = nil
      }
    } else if storedValue.hasPrefix(Self.legacyMetadataOAuthPrefix) {
      kind = .oauth
      if let payload = Self.decodeLegacyMetadataPayload(
        String(storedValue.dropFirst(Self.legacyMetadataOAuthPrefix.count))
      ) {
        value = payload.accessToken
        oauthToken = .init(
          value: payload.accessToken,
          expiresAt: .distantPast,
          clientID: payload.clientID,
          revocationEndpoint: payload.revocationEndpoint.flatMap(URL.init(string:))
        )
      } else {
        value = ""
        oauthToken = nil
      }
    } else if storedValue.hasPrefix(Self.legacyOAuthPrefix) {
      kind = .oauth
      value = String(storedValue.dropFirst(Self.legacyOAuthPrefix.count))
      oauthToken = .init(value: value, expiresAt: .distantPast)
    } else {
      kind = .device
      value = storedValue
      oauthToken = nil
    }
  }

  static func oauth(_ token: OAuthGatewayAccessToken) -> String {
    guard !token.clientID.isEmpty, let tokenEndpoint = token.tokenEndpoint else {
      if !token.clientID.isEmpty {
        let payload = LegacyMetadataOAuthPayload(
          accessToken: token.value,
          clientID: token.clientID,
          revocationEndpoint: token.revocationEndpoint?.absoluteString
        )
        if let data = try? JSONEncoder().encode(payload) {
          return legacyMetadataOAuthPrefix + data.base64EncodedString()
        }
      }
      return legacyOAuthPrefix + token.value
    }
    let payload = OAuthPayload(
      accessToken: token.value,
      expiresAt: token.expiresAt.timeIntervalSince1970,
      clientID: token.clientID,
      tokenEndpoint: tokenEndpoint.absoluteString,
      revocationEndpoint: token.revocationEndpoint?.absoluteString,
      refreshToken: token.refreshToken,
      scope: token.scope,
      resources: token.resources.map(\.absoluteString),
      expectedAudiences: token.expectedAudiences
    )
    guard let data = try? JSONEncoder().encode(payload) else {
      return legacyOAuthPrefix + token.value
    }
    return oauthPrefix + data.base64EncodedString()
  }

  private static func decodePayload(_ value: String) -> OAuthPayload? {
    guard let data = Data(base64Encoded: value),
      let payload = try? JSONDecoder().decode(OAuthPayload.self, from: data),
      !payload.accessToken.isEmpty,
      !payload.clientID.isEmpty,
      payload.accessToken.utf8.count <= 16 * 1_024,
      payload.clientID.utf8.count <= 512,
      payload.expiresAt.isFinite,
      payload.expiresAt > 0,
      payload.refreshToken.map({ !$0.isEmpty && $0.utf8.count <= 16 * 1_024 }) != false,
      validScope(payload.scope),
      secureURL(payload.tokenEndpoint) != nil,
      payload.resources.count <= 2,
      payload.resources.allSatisfy({ protectedResourceURL($0) != nil }),
      payload.expectedAudiences.count <= 4,
      payload.expectedAudiences.allSatisfy({ !$0.isEmpty && $0.utf8.count <= 1_024 })
    else {
      return nil
    }
    if let endpoint = payload.revocationEndpoint, secureURL(endpoint) == nil {
      return nil
    }
    return payload
  }

  private static func decodeLegacyMetadataPayload(_ value: String) -> LegacyMetadataOAuthPayload? {
    guard let data = Data(base64Encoded: value),
      let payload = try? JSONDecoder().decode(LegacyMetadataOAuthPayload.self, from: data),
      !payload.accessToken.isEmpty,
      !payload.clientID.isEmpty,
      payload.accessToken.utf8.count <= 16 * 1_024,
      payload.clientID.utf8.count <= 512
    else { return nil }
    if let endpoint = payload.revocationEndpoint, secureURL(endpoint) == nil {
      return nil
    }
    return payload
  }

  private static func secureURL(_ value: String) -> URL? {
    guard let url = URL(string: value),
      url.scheme?.lowercased() == "https",
      url.host?.isEmpty == false,
      url.user == nil,
      url.password == nil,
      url.fragment == nil
    else { return nil }
    return url
  }

  private static func protectedResourceURL(_ value: String) -> URL? {
    guard let url = URL(string: value),
      let scheme = url.scheme?.lowercased(),
      let host = url.host?.lowercased(),
      !host.isEmpty,
      scheme == "https" || (scheme == "http" && ["localhost", "127.0.0.1", "::1"].contains(host)),
      url.user == nil,
      url.password == nil,
      url.query == nil,
      url.fragment == nil
    else { return nil }
    return url
  }

  private static func validScope(_ value: String) -> Bool {
    let tokens = value.split(separator: " ", omittingEmptySubsequences: false)
    return value.utf8.count <= 1_024 && (value.isEmpty || tokens.count <= 9)
      && tokens.allSatisfy { token in
        !token.isEmpty && token.utf8.count <= 512 && token.utf8.allSatisfy { byte in
          byte == 0x21 || (0x23...0x5B).contains(byte) || (0x5D...0x7E).contains(byte)
        }
      }
  }

  private struct OAuthPayload: Codable {
    let accessToken: String
    let expiresAt: TimeInterval
    let clientID: String
    let tokenEndpoint: String
    let revocationEndpoint: String?
    let refreshToken: String?
    let scope: String
    let resources: [String]
    let expectedAudiences: [String]
  }

  private struct LegacyMetadataOAuthPayload: Codable {
    let accessToken: String
    let clientID: String
    let revocationEndpoint: String?
  }
}

private struct ErrorResponse: Decodable {
  let error: String
}
