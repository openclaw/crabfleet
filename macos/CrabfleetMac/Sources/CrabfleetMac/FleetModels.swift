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

extension CrabboxLease {
  static func fixtures(currentUser: String) -> [CrabboxLease] {
    let now = Date()
    return [
      .init(
        id: "IS-248",
        leaseID: "blue-lobster",
        owner: currentUser,
        repository: "openclaw/crabfleet",
        branch: "codex/native-fleet",
        runtime: "crabbox",
        status: .attached,
        purpose: "Native fleet client",
        summary: "Building the Metal-backed macOS viewer",
        lastEvent: "Workspace active",
        updatedAt: now.addingTimeInterval(-42),
        desktopAvailable: true,
        terminalAvailable: true
      ),
      .init(
        id: "IS-241",
        leaseID: "copper-crab",
        owner: currentUser,
        repository: "openclaw/openclaw",
        branch: "fix/desktop-clipboard",
        runtime: "crabbox",
        status: .ready,
        purpose: "Clipboard regression",
        summary: "Desktop ready for human validation",
        lastEvent: "Hydration complete",
        updatedAt: now.addingTimeInterval(-8 * 60),
        desktopAvailable: true,
        terminalAvailable: true
      ),
      .init(
        id: "IS-239",
        leaseID: "silver-squid",
        owner: "alex",
        repository: "openclaw/crabbox",
        branch: "perf/webvnc",
        runtime: "crabbox",
        status: .detached,
        purpose: "Desktop transport bakeoff",
        summary: "Comparing direct and relayed rendering",
        lastEvent: "Operator detached",
        updatedAt: now.addingTimeInterval(-21 * 60),
        desktopAvailable: true,
        terminalAvailable: true
      ),
      .init(
        id: "IS-232",
        leaseID: "quiet-krill",
        owner: "mira",
        repository: "openclaw/agent-skills",
        branch: "main",
        runtime: "container",
        status: .provisioning,
        purpose: "Skill validation",
        summary: "Waiting for workspace capacity",
        lastEvent: "Provisioning",
        updatedAt: now.addingTimeInterval(-2 * 60),
        desktopAvailable: false,
        terminalAvailable: false
      ),
      .init(
        id: "IS-220",
        leaseID: "ember-crab",
        owner: currentUser,
        repository: "openclaw/crabfleet",
        branch: "main",
        runtime: "crabbox",
        status: .stopped,
        purpose: "Release verification",
        summary: "Completed cleanly",
        lastEvent: "Stopped",
        updatedAt: now.addingTimeInterval(-3 * 60 * 60),
        desktopAvailable: false,
        terminalAvailable: false
      ),
    ]
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
  let lastEvent: String
  let updatedAt: Double

  func lease() -> CrabboxLease {
    .init(
      id: id,
      leaseID: leaseId,
      owner: owner,
      repository: repo,
      branch: branch,
      runtime: runtime,
      status: status,
      purpose: purpose,
      summary: summary,
      lastEvent: lastEvent,
      updatedAt: Date(timeIntervalSince1970: updatedAt / 1_000),
      desktopAvailable: vnc,
      terminalAvailable: attachable
    )
  }
}
