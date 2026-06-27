import Foundation

enum DesktopSource: String, Codable, Hashable {
  case crabfleet
  case saved

  var label: String {
    switch self {
    case .crabfleet: "Crabfleet"
    case .saved: "Saved"
    }
  }
}

enum DesktopScope: String, CaseIterable, Identifiable {
  case all = "All Computers"
  case mine = "My Fleet"
  case fleet = "Entire Fleet"
  case saved = "Saved"

  var id: String { rawValue }

  var systemImage: String {
    switch self {
    case .all: "rectangle.grid.2x2"
    case .mine: "person.crop.rectangle.stack"
    case .fleet: "server.rack"
    case .saved: "star"
    }
  }
}

struct VNCAddress: Equatable, Hashable, Sendable {
  let host: String
  let port: Int
  let username: String

  static func parse(_ rawValue: String, defaultPort: Int = 5900) throws -> Self {
    let value = rawValue.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !value.isEmpty else { throw VNCAddressError.missingHost }

    let urlValue = value.contains("://") ? value : "vnc://\(value)"
    guard let components = URLComponents(string: urlValue) else {
      throw VNCAddressError.invalidAddress
    }
    guard components.scheme?.lowercased() == "vnc" else {
      throw VNCAddressError.unsupportedScheme
    }
    guard components.password == nil else {
      throw VNCAddressError.embeddedPassword
    }
    guard
      let parsedHost = components.host?.trimmingCharacters(in: .whitespacesAndNewlines),
      !parsedHost.isEmpty
    else {
      throw VNCAddressError.invalidAddress
    }

    let host =
      parsedHost.hasPrefix("[") && parsedHost.hasSuffix("]")
      ? String(parsedHost.dropFirst().dropLast())
      : parsedHost

    let port = components.port ?? defaultPort
    guard (1...65_535).contains(port) else { throw VNCAddressError.invalidPort }

    return .init(
      host: host,
      port: port,
      username: components.user?.removingPercentEncoding ?? ""
    )
  }

  var displayValue: String {
    if host.contains(":") {
      return "[\(host)]:\(port)"
    }
    return "\(host):\(port)"
  }
}

enum VNCAddressError: LocalizedError, Equatable {
  case missingHost
  case invalidAddress
  case invalidPort
  case unsupportedScheme
  case embeddedPassword

  var errorDescription: String? {
    switch self {
    case .missingHost: "Enter a host name or IP address."
    case .invalidAddress: "That VNC address is not valid."
    case .invalidPort: "The VNC port must be between 1 and 65535."
    case .unsupportedScheme: "Use a VNC address, such as vnc://host:5900."
    case .embeddedPassword: "Enter the password separately instead of putting it in the URL."
    }
  }
}

struct VNCConnectionProfile: Identifiable, Codable, Hashable {
  let id: String
  var name: String
  var host: String
  var port: Int
  var username: String
  var favorite: Bool
  var createdAt: Date
  var lastConnectedAt: Date?

  init(
    id: String = UUID().uuidString,
    name: String,
    host: String,
    port: Int,
    username: String = "",
    favorite: Bool = false,
    createdAt: Date = .now,
    lastConnectedAt: Date? = nil
  ) {
    self.id = id
    self.name = name
    self.host = host
    self.port = port
    self.username = username
    self.favorite = favorite
    self.createdAt = createdAt
    self.lastConnectedAt = lastConnectedAt
  }

  var address: VNCAddress {
    .init(host: host, port: port, username: username)
  }
}

struct DesktopTarget: Identifiable, Hashable {
  let id: String
  let title: String
  let subtitle: String
  let detail: String
  let source: DesktopSource
  let status: LeaseStatus?
  let owner: String?
  let repository: String?
  let branch: String?
  let updatedAt: Date
  let endpoint: VNCAddress?
  let desktopAvailable: Bool
  let profileID: String?
  let nativeVncSessionID: String?

  init(lease: CrabboxLease) {
    id = "fleet:\(lease.id)"
    title = lease.displayName
    subtitle = lease.repositoryName
    detail = lease.summary.isEmpty ? lease.lastEvent : lease.summary
    source = .crabfleet
    status = lease.status
    owner = lease.owner
    repository = lease.repository
    branch = lease.branch
    updatedAt = lease.updatedAt
    endpoint = nil
    desktopAvailable = lease.desktopAvailable
    profileID = nil
    nativeVncSessionID = lease.nativeVncSessionID
  }

  init(profile: VNCConnectionProfile) {
    id = "saved:\(profile.id)"
    title = profile.name
    subtitle = profile.address.displayValue
    detail = profile.favorite ? "Favorite connection" : "Saved VNC connection"
    source = .saved
    status = nil
    owner = nil
    repository = nil
    branch = nil
    updatedAt = profile.lastConnectedAt ?? profile.createdAt
    endpoint = profile.address
    desktopAvailable = true
    profileID = profile.id
    nativeVncSessionID = nil
  }

  init(host: RegisteredDesktopHost) {
    id = "host:\(host.id)"
    title = host.name
    subtitle = "\(host.address):\(host.port)"
    detail = "Registered private desktop"
    source = .crabfleet
    status = nil
    owner = host.owner
    repository = nil
    branch = nil
    updatedAt = host.updatedAt
    endpoint = .init(host: host.address, port: host.port, username: "")
    desktopAvailable = true
    profileID = nil
    nativeVncSessionID = nil
  }

  func matches(_ query: String) -> Bool {
    let normalized = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    guard !normalized.isEmpty else { return true }
    return [title, subtitle, detail, owner ?? "", repository ?? "", branch ?? ""]
      .contains { $0.lowercased().contains(normalized) }
  }
}

struct VNCConnectionRequest: Equatable {
  let host: String
  let port: Int
  let username: String
  let password: String
  let clipboardEnabled: Bool

  var address: VNCAddress {
    .init(host: host, port: port, username: username)
  }
}
