import Foundation
import Security

struct DeploymentOrigin: Codable, Equatable, Hashable, Sendable {
  let url: URL

  init(_ rawValue: String) throws {
    let value = rawValue.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !value.isEmpty, var components = URLComponents(string: value) else {
      throw DeploymentOriginError.invalidURL
    }
    guard components.user == nil, components.password == nil else {
      throw DeploymentOriginError.credentialsNotAllowed
    }
    guard components.query == nil, components.fragment == nil else {
      throw DeploymentOriginError.queryOrFragmentNotAllowed
    }
    guard let scheme = components.scheme?.lowercased(), let host = components.host, !host.isEmpty else {
      throw DeploymentOriginError.invalidURL
    }
    guard scheme == "https" || (scheme == "http" && Self.isLiteralLoopback(host)) else {
      throw DeploymentOriginError.insecureURL
    }

    components.scheme = scheme
    components.path = ""
    components.query = nil
    components.fragment = nil
    guard let normalized = components.url else { throw DeploymentOriginError.invalidURL }
    url = normalized
  }

  var displayValue: String { url.absoluteString }

  func endpoint(_ path: String) throws -> URL {
    guard path.hasPrefix("/"), let result = URL(string: path, relativeTo: url)?.absoluteURL,
      Self.sameOrigin(url, result)
    else {
      throw DeploymentOriginError.invalidURL
    }
    return result
  }

  func contains(_ candidate: URL) -> Bool {
    Self.sameOrigin(url, candidate)
  }

  private static func isLiteralLoopback(_ host: String) -> Bool {
    let value = host.lowercased()
    return value == "localhost" || value == "127.0.0.1" || value == "::1"
  }

  private static func sameOrigin(_ left: URL, _ right: URL) -> Bool {
    left.scheme?.lowercased() == right.scheme?.lowercased()
      && left.host?.lowercased() == right.host?.lowercased()
      && effectivePort(left) == effectivePort(right)
  }

  private static func effectivePort(_ url: URL) -> Int? {
    if let port = url.port { return port }
    switch url.scheme?.lowercased() {
    case "https": return 443
    case "http": return 80
    default: return nil
    }
  }
}

enum DeploymentOriginError: LocalizedError, Equatable {
  case invalidURL
  case insecureURL
  case credentialsNotAllowed
  case queryOrFragmentNotAllowed

  var errorDescription: String? {
    switch self {
    case .invalidURL: "Enter a valid Crabfleet deployment URL."
    case .insecureURL: "Crabfleet deployments must use HTTPS. HTTP is allowed only on localhost."
    case .credentialsNotAllowed: "Deployment URLs cannot contain a username or password."
    case .queryOrFragmentNotAllowed: "Deployment URLs cannot contain a query or fragment."
    }
  }
}

protocol DeploymentOriginStoring {
  func load() -> String?
  func save(_ value: String)
}

final class UserDefaultsDeploymentOriginStore: DeploymentOriginStoring {
  private let defaults: UserDefaults
  private let key: String

  init(
    defaults: UserDefaults = .standard,
    key: String = "CrabfleetMac.deploymentOrigin"
  ) {
    self.defaults = defaults
    self.key = key
  }

  func load() -> String? { defaults.string(forKey: key) }
  func save(_ value: String) { defaults.set(value, forKey: key) }
}

protocol APIAccessTokenStoring {
  func load(for origin: DeploymentOrigin) throws -> String?
  func save(_ token: String, for origin: DeploymentOrigin) throws
  func delete(for origin: DeploymentOrigin) throws
}

struct KeychainAPIAccessTokenStore: APIAccessTokenStoring {
  private let service = "org.openclaw.crabfleet.mac.api-token"

  func load(for origin: DeploymentOrigin) throws -> String? {
    var query = baseQuery(for: origin)
    query[kSecMatchLimit as String] = kSecMatchLimitOne
    query[kSecReturnData as String] = true
    var result: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    if status == errSecItemNotFound { return nil }
    guard status == errSecSuccess, let data = result as? Data,
      let token = String(data: data, encoding: .utf8), !token.isEmpty
    else {
      throw KeychainTokenError(status: status)
    }
    return token
  }

  func save(_ token: String, for origin: DeploymentOrigin) throws {
    guard let data = token.data(using: .utf8), !data.isEmpty else {
      throw KeychainTokenError(status: errSecParam)
    }
    let query = baseQuery(for: origin)
    let updateStatus = SecItemUpdate(
      query as CFDictionary,
      [kSecValueData as String: data] as CFDictionary
    )
    if updateStatus == errSecSuccess { return }
    guard updateStatus == errSecItemNotFound else {
      throw KeychainTokenError(status: updateStatus)
    }
    var item = query
    item[kSecValueData as String] = data
    item[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
    let addStatus = SecItemAdd(item as CFDictionary, nil)
    guard addStatus == errSecSuccess else { throw KeychainTokenError(status: addStatus) }
  }

  func delete(for origin: DeploymentOrigin) throws {
    let status = SecItemDelete(baseQuery(for: origin) as CFDictionary)
    guard status == errSecSuccess || status == errSecItemNotFound else {
      throw KeychainTokenError(status: status)
    }
  }

  private func baseQuery(for origin: DeploymentOrigin) -> [String: Any] {
    [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: origin.displayValue,
      kSecAttrSynchronizable as String: false,
    ]
  }
}

struct KeychainTokenError: LocalizedError {
  let status: OSStatus

  var errorDescription: String? {
    let message = SecCopyErrorMessageString(status, nil) as String? ?? "status \(status)"
    return "The Crabfleet credential could not be stored in Keychain (\(message))."
  }
}
