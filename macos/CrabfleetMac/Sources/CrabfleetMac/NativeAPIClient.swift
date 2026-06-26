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

enum NativeTokenExchange: Equatable, Sendable {
  case pending
  case approved(NativeAccessToken)
}

protocol NativeAPIClientProtocol: AnyObject {
  var origin: DeploymentOrigin { get }
  func createDeviceAuthorization(clientName: String) async throws -> NativeDeviceAuthorization
  func exchangeDeviceCode(_ deviceCode: String) async throws -> NativeTokenExchange
  func session(accessToken: String) async throws -> NativeAPISession
  func fleet(accessToken: String) async throws -> NativeAPIFleet
  func revoke(accessToken: String) async throws
  @MainActor
  func close()
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
  private let encoder = JSONEncoder()
  private let decoder = JSONDecoder()
  private let maximumResponseBytes = 5 * 1_024 * 1_024
  private let lifecycleLock = NSLock()
  private var isClosed = false

  init(
    origin: DeploymentOrigin,
    transport: HTTPDataTransport = RejectingRedirectURLSessionTransport()
  ) {
    self.origin = origin
    self.transport = transport
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
    let response = try await request(
      path: "/api/native/v1/session",
      method: "GET",
      accessToken: accessToken
    )
    guard response.statusCode == 200 else { throw error(for: response) }
    let payload = try decode(SessionResponse.self, from: response.data)
    return .init(user: payload.user, deployment: payload.deployment)
  }

  func fleet(accessToken: String) async throws -> NativeAPIFleet {
    let response = try await request(
      path: "/api/native/v1/fleet",
      method: "GET",
      accessToken: accessToken
    )
    guard response.statusCode == 200 else { throw error(for: response) }
    let payload = try decode(FleetAPIEnvelope.self, from: response.data)
    return .init(
      leases: payload.fleet.sessions.map { $0.lease() },
      desktopHosts: (payload.fleet.desktopHosts ?? []).map { $0.desktopHost() }
    )
  }

  func revoke(accessToken: String) async throws {
    let response = try await request(
      path: "/api/native/v1/auth/token",
      method: "DELETE",
      accessToken: accessToken
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

private struct ErrorResponse: Decodable {
  let error: String
}
