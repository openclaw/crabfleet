import Foundation

enum LeaseStatus: String, Codable, CaseIterable {
  case provisioning
  case pendingAdapter = "pending_adapter"
  case ready
  case attached
  case detached
  case stopping
  case stopped
  case expired
  case failed

  var isActive: Bool {
    ![.stopping, .stopped, .expired, .failed].contains(self)
  }

  var label: String {
    switch self {
    case .pendingAdapter: "Pending"
    default: rawValue.capitalized
    }
  }
}

struct CrabboxLease: Identifiable, Hashable {
  let id: String
  let leaseID: String?
  let nativeVncSessionID: String?
  let owner: String
  let repository: String
  let branch: String
  let runtime: String
  let status: LeaseStatus
  let purpose: String
  let summary: String
  let lastEvent: String
  let updatedAt: Date
  let desktopAvailable: Bool
  let terminalAvailable: Bool

  var displayName: String {
    if let leaseID, !leaseID.isEmpty { return leaseID }
    return id
  }

  var repositoryName: String {
    repository.split(separator: "/").last.map(String.init) ?? repository
  }

  func matches(_ query: String) -> Bool {
    let normalized = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    guard !normalized.isEmpty else { return true }
    return [id, leaseID ?? "", owner, repository, branch, runtime, purpose, summary]
      .contains { $0.lowercased().contains(normalized) }
  }
}

struct FleetAPIEnvelope: Decodable {
  let fleet: FleetAPIState
}

struct FleetAPIState: Decodable {
  let generatedAt: Double
  let registryAvailable: Bool
  let totals: FleetAPITotals
  let sessions: [FleetAPISession]
  let desktopHosts: [FleetAPIDesktopHost]?
}

struct FleetAPIDesktopHost: Decodable {
  let id: String
  let owner: String
  let name: String
  let address: String
  let port: Int
  let createdAt: Double
  let updatedAt: Double

  func desktopHost() -> RegisteredDesktopHost {
    .init(
      id: id,
      owner: owner,
      name: name,
      address: address,
      port: port,
      createdAt: Date(timeIntervalSince1970: createdAt / 1_000),
      updatedAt: Date(timeIntervalSince1970: updatedAt / 1_000)
    )
  }
}

struct RegisteredDesktopHost: Identifiable, Hashable {
  let id: String
  let owner: String
  let name: String
  let address: String
  let port: Int
  let createdAt: Date
  let updatedAt: Date
}

struct FleetAPITotals: Decodable {
  let active: Int
  let sessions: Int
  let vnc: Int
}

struct FleetAPISession: Decodable {
  let id: String
  let repo: String
  let branch: String
  let runtime: String
  let owner: String
  let purpose: String
  let summary: String
  let status: LeaseStatus
  let attachable: Bool
  let vnc: Bool
  let leaseId: String?
  let nativeVncSessionId: String?
  let lastEvent: String
  let updatedAt: Double

  func lease() -> CrabboxLease {
    .init(
      id: id,
      leaseID: leaseId,
      nativeVncSessionID: nativeVncSessionId,
      owner: owner,
      repository: repo,
      branch: branch,
      runtime: runtime,
      status: status,
      purpose: purpose,
      summary: summary,
      lastEvent: lastEvent,
      updatedAt: Date(timeIntervalSince1970: updatedAt / 1_000),
      desktopAvailable: vnc || nativeVncSessionId != nil,
      terminalAvailable: attachable
    )
  }
}
