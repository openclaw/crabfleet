import Foundation

protocol DesktopHostRegistering: Sendable {
  func register(identity: TailnetIdentity, port: UInt16) async throws
}

struct CrabfleetDesktopRegistration: DesktopHostRegistering, Sendable {
  private struct RegistrationBody: Encodable {
    let name: String
    let address: String
    let port: UInt16
  }

  private let baseURL: URL
  private let sessionCookie: String
  private let session: URLSession

  init?(
    environment: [String: String] = ProcessInfo.processInfo.environment,
    session: URLSession = .shared
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
    self.session = session
  }

  func register(identity: TailnetIdentity, port: UInt16) async throws {
    let request = try registrationRequest(identity: identity, port: port)
    let (_, response) = try await session.data(for: request)
    guard let http = response as? HTTPURLResponse else {
      throw DesktopHostRegistrationError.invalidResponse
    }
    guard (200..<300).contains(http.statusCode) else {
      throw DesktopHostRegistrationError.httpStatus(http.statusCode)
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
}

enum DesktopHostRegistrationError: LocalizedError {
  case invalidResponse
  case httpStatus(Int)

  var errorDescription: String? {
    switch self {
    case .invalidResponse:
      "Crabfleet returned an invalid registration response."
    case .httpStatus(let status):
      "Crabfleet registration returned HTTP \(status)."
    }
  }
}
