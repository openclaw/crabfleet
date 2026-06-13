import Foundation

@MainActor
final class ConnectionLibrary: ObservableObject {
  @Published private(set) var profiles: [VNCConnectionProfile]

  private let defaults: UserDefaults
  private let storageKey: String
  private let encoder = JSONEncoder()
  private let decoder = JSONDecoder()

  init(
    defaults: UserDefaults = .standard,
    storageKey: String = "CrabfleetMac.connectionProfiles"
  ) {
    self.defaults = defaults
    self.storageKey = storageKey

    if let data = defaults.data(forKey: storageKey),
      let decoded = try? decoder.decode([VNCConnectionProfile].self, from: data)
    {
      profiles = decoded
    } else {
      profiles = []
    }
  }

  @discardableResult
  func save(
    name: String,
    address: VNCAddress,
    favorite: Bool = false
  ) -> VNCConnectionProfile {
    if let index = profiles.firstIndex(where: {
      $0.host.caseInsensitiveCompare(address.host) == .orderedSame && $0.port == address.port
    }) {
      profiles[index].name = name
      profiles[index].username = address.username
      profiles[index].favorite = favorite || profiles[index].favorite
      persist()
      return profiles[index]
    }

    let profile = VNCConnectionProfile(
      name: name,
      host: address.host,
      port: address.port,
      username: address.username,
      favorite: favorite
    )
    profiles.append(profile)
    sortProfiles()
    persist()
    return profile
  }

  func markConnected(profileID: String) {
    guard let index = profiles.firstIndex(where: { $0.id == profileID }) else { return }
    profiles[index].lastConnectedAt = .now
    sortProfiles()
    persist()
  }

  func setFavorite(_ favorite: Bool, profileID: String) {
    guard let index = profiles.firstIndex(where: { $0.id == profileID }) else { return }
    profiles[index].favorite = favorite
    sortProfiles()
    persist()
  }

  func remove(profileID: String) {
    profiles.removeAll { $0.id == profileID }
    persist()
  }

  private func sortProfiles() {
    profiles.sort {
      if $0.favorite != $1.favorite { return $0.favorite && !$1.favorite }
      return ($0.lastConnectedAt ?? $0.createdAt) > ($1.lastConnectedAt ?? $1.createdAt)
    }
  }

  private func persist() {
    guard let data = try? encoder.encode(profiles) else { return }
    defaults.set(data, forKey: storageKey)
  }
}
