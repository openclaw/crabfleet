import Foundation

protocol DesktopHostRegistering: Sendable {
  func register(identity: TailnetIdentity, port: UInt16) async throws -> String
  func unregister(identity: TailnetIdentity, ownershipToken: String) async throws
}

actor DesktopHostRegistrationCoordinator {
  private let registration: any DesktopHostRegistering
  private var pendingOperation: Task<Void, Never>?

  init(registration: any DesktopHostRegistering) {
    self.registration = registration
  }

  func register(identity: TailnetIdentity, port: UInt16) async throws -> String {
    let registration = self.registration
    let operation = enqueue {
      try await registration.register(identity: identity, port: port)
    }
    return try await operation.value
  }

  func unregister(identity: TailnetIdentity, ownershipToken: String) async throws {
    let registration = self.registration
    let operation = enqueue {
      try await registration.unregister(identity: identity, ownershipToken: ownershipToken)
    }
    try await operation.value
  }

  private func enqueue<Value: Sendable>(
    _ operation: @escaping @Sendable () async throws -> Value
  ) -> Task<Value, Error> {
    let previous = pendingOperation
    let task = Task {
      await previous?.value
      return try await operation()
    }
    pendingOperation = Task {
      _ = try? await task.value
    }
    return task
  }
}

struct CrabfleetDesktopRegistration: DesktopHostRegistering, @unchecked Sendable {
  private struct RegistrationResponse: Decodable {
    let ownershipToken: String
  }

  private struct RegistrationBody: Encodable {
    let name: String
    let address: String
    let port: UInt16
  }

  private let baseURL: URL
  private let sessionCookie: String
  private let transport: any HTTPDataTransport

  init?(
    environment: [String: String] = ProcessInfo.processInfo.environment,
    transport: any HTTPDataTransport = RejectingRedirectURLSessionTransport()
  ) {
    guard
      let rawURL = environment["CRABFLEET_API_URL"],
      let configuredURL = URL(string: rawURL),
      Self.isSecureAPIURL(configuredURL),
      let cookie = environment["CRABFLEET_SESSION_COOKIE"],
      !cookie.isEmpty,
      cookie.utf8.count <= 4_096,
      !cookie.unicodeScalars.contains(where: CharacterSet.controlCharacters.contains)
    else { return nil }

    var normalizedURL = configuredURL
    if normalizedURL.path == "/api/fleet" {
      normalizedURL.deleteLastPathComponent()
      normalizedURL.deleteLastPathComponent()
    }
    guard normalizedURL.path.isEmpty || normalizedURL.path == "/" else { return nil }
    self.baseURL = normalizedURL
    self.sessionCookie = cookie
    self.transport = transport
  }

  func register(identity: TailnetIdentity, port: UInt16) async throws -> String {
    let request = try registrationRequest(identity: identity, port: port)
    let (data, http) = try await transport.data(for: request)
    try validate(response: http, for: request, acceptingNotFound: false)
    guard
      let response = try? JSONDecoder().decode(RegistrationResponse.self, from: data),
      Self.isValidOwnershipToken(response.ownershipToken)
    else {
      throw DesktopHostRegistrationError.invalidResponse
    }
    return response.ownershipToken
  }

  func unregister(identity: TailnetIdentity, ownershipToken: String) async throws {
    let request = try removalRequest(identity: identity, ownershipToken: ownershipToken)
    let (_, http) = try await transport.data(for: request)
    try validate(response: http, for: request, acceptingNotFound: true)
  }

  private func validate(
    response: HTTPURLResponse,
    for request: URLRequest,
    acceptingNotFound: Bool
  ) throws {
    guard response.url == request.url else {
      throw DesktopHostRegistrationError.redirectRejected
    }
    guard (200..<300).contains(response.statusCode)
      || (acceptingNotFound && response.statusCode == 404)
    else {
      throw DesktopHostRegistrationError.httpStatus(response.statusCode)
    }
  }

  func registrationRequest(identity: TailnetIdentity, port: UInt16) throws -> URLRequest {
    let hostID = Self.hostID(identity: identity)
    let url =
      baseURL
      .appending(path: "api")
      .appending(path: "desktop-hosts")
      .appending(path: hostID)
    var request = URLRequest(url: url)
    request.httpMethod = "PUT"
    request.timeoutInterval = 15
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.setValue("application/json", forHTTPHeaderField: "Accept")
    request.setValue(sessionCookie, forHTTPHeaderField: "Cookie")
    request.httpBody = try JSONEncoder().encode(
      RegistrationBody(
        name: identity.hostName.isEmpty ? identity.dnsName : identity.hostName,
        address: identity.ipv4Address,
        port: port
      ))
    return request
  }

  func removalRequest(identity: TailnetIdentity, ownershipToken: String) throws -> URLRequest {
    guard Self.isValidOwnershipToken(ownershipToken) else {
      throw DesktopHostRegistrationError.invalidResponse
    }
    let url =
      baseURL
      .appending(path: "api")
      .appending(path: "desktop-hosts")
      .appending(path: Self.hostID(identity: identity))
    var request = URLRequest(url: url)
    request.httpMethod = "DELETE"
    request.timeoutInterval = 15
    request.setValue("application/json", forHTTPHeaderField: "Accept")
    request.setValue(sessionCookie, forHTTPHeaderField: "Cookie")
    request.setValue(ownershipToken, forHTTPHeaderField: "X-Crabfleet-Ownership-Token")
    return request
  }

  static func hostID(identity: TailnetIdentity) -> String {
    let dnsLabel = identity.dnsName.split(separator: ".").first.map(String.init) ?? ""
    let normalized = dnsLabel.lowercased().filter {
      $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "." || $0 == "_" || $0 == "-")
    }
    let trimmed = normalized.trimmingCharacters(in: CharacterSet(charactersIn: "._-"))
    if !trimmed.isEmpty { return String(trimmed.prefix(80)) }
    return "mac-\(identity.ipv4Address.replacingOccurrences(of: ".", with: "-"))"
  }

  static func isSecureAPIURL(_ url: URL) -> Bool {
    guard
      url.user == nil,
      url.password == nil,
      url.query == nil,
      url.fragment == nil,
      let scheme = url.scheme?.lowercased(),
      let host = url.host?.lowercased()
    else { return false }
    if scheme == "https" { return true }
    return scheme == "http" && (host == "127.0.0.1" || host == "::1")
  }

  private static func isValidOwnershipToken(_ value: String) -> Bool {
    !value.isEmpty && value.utf8.count <= 200
      && !value.unicodeScalars.contains {
        CharacterSet.whitespacesAndNewlines.contains($0)
          || CharacterSet.controlCharacters.contains($0)
      }
  }
}

enum DesktopHostRegistrationError: LocalizedError, Equatable {
  case invalidResponse
  case redirectRejected
  case httpStatus(Int)

  var errorDescription: String? {
    switch self {
    case .invalidResponse:
      "Crabfleet returned an invalid registration response."
    case .redirectRejected:
      "Crabfleet redirected the desktop registration request."
    case .httpStatus(let status):
      "Crabfleet registration returned HTTP \(status)."
    }
  }
}
