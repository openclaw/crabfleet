import Foundation

@MainActor
final class FleetStore: ObservableObject {
  @Published private(set) var leases: [CrabboxLease] = []
  @Published private(set) var isRefreshing = false
  @Published private(set) var lastUpdated: Date?
  @Published private(set) var notice: String?

  let currentUser: String
  private let environment: [String: String]

  init(environment: [String: String] = ProcessInfo.processInfo.environment) {
    self.environment = environment
    self.currentUser = environment["CRABFLEET_USER"] ?? NSUserName()
  }

  func refresh() async {
    guard !isRefreshing else { return }
    isRefreshing = true
    defer { isRefreshing = false }

    do {
      if let endpoint = environment["CRABFLEET_API_URL"], !endpoint.isEmpty {
        leases = try await fetchFleet(endpoint: endpoint)
        notice = nil
      } else {
        leases = CrabboxLease.fixtures(currentUser: currentUser)
        notice = "Preview data · set CRABFLEET_API_URL to load /api/fleet"
      }
      lastUpdated = .now
    } catch {
      if leases.isEmpty {
        leases = CrabboxLease.fixtures(currentUser: currentUser)
      }
      notice = "Fleet refresh failed · \(error.localizedDescription)"
    }
  }

  private func fetchFleet(endpoint: String) async throws -> [CrabboxLease] {
    guard var url = URL(string: endpoint) else { throw FleetClientError.invalidURL }
    if url.path.isEmpty || url.path == "/" {
      url.append(path: "api/fleet")
    }

    var request = URLRequest(url: url)
    request.timeoutInterval = 15
    request.setValue("application/json", forHTTPHeaderField: "Accept")
    if let cookie = environment["CRABFLEET_SESSION_COOKIE"], !cookie.isEmpty {
      request.setValue(cookie, forHTTPHeaderField: "Cookie")
    }

    let (data, response) = try await URLSession.shared.data(for: request)
    guard let http = response as? HTTPURLResponse else { throw FleetClientError.invalidResponse }
    guard (200..<300).contains(http.statusCode) else {
      throw FleetClientError.httpStatus(http.statusCode)
    }
    let envelope = try JSONDecoder().decode(FleetAPIEnvelope.self, from: data)
    return envelope.fleet.sessions.map { $0.lease() }
  }
}

enum FleetClientError: LocalizedError {
  case invalidURL
  case invalidResponse
  case httpStatus(Int)

  var errorDescription: String? {
    switch self {
    case .invalidURL: "Invalid Crabfleet API URL"
    case .invalidResponse: "Invalid Crabfleet API response"
    case .httpStatus(let status): "Crabfleet API returned HTTP \(status)"
    }
  }
}
