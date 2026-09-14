import Foundation

struct FleetAPIEnvelope: Decodable {
  let fleet: FleetAPIState
}

struct FleetAPIState: Decodable {
  let desktopHosts: [FleetAPIDesktopHost]?
}

struct FleetAPIDesktopHost: Decodable {
  let relayOnly: Bool?
  let id: String
  let owner: String
  let name: String
  let address: String
  let port: Int
  let quicPort: Int?
  let quicCertHash: String?
  let webtransport: Bool?
  let createdAt: Double
  let updatedAt: Double

  func desktopHost() -> RegisteredDesktopHost {
    .init(
      id: id,
      owner: owner,
      name: name,
      address: address,
      port: port,
      quicPort: quicPort,
      quicCertHash: quicCertHash,
      webtransport: webtransport ?? false,
      createdAt: Date(timeIntervalSince1970: createdAt / 1_000),
      updatedAt: Date(timeIntervalSince1970: updatedAt / 1_000),
      relayOnly: relayOnly ?? false
    )
  }
}

struct RegisteredDesktopHost: Identifiable, Hashable {
  let id: String
  let owner: String
  let name: String
  let address: String
  let port: Int
  let quicPort: Int?
  let quicCertHash: String?
  let webtransport: Bool
  let createdAt: Date
  let updatedAt: Date
  var relayOnly: Bool = false
}
