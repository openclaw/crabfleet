import Foundation
import Security

protocol VNCKeychainStoring: Sendable {
  func load(for address: VNCAddress) throws -> String?
  func save(_ value: String, for address: VNCAddress) -> Bool
  func remove(for address: VNCAddress) -> Bool
}

enum StoredAccessCode: Equatable {
  case missing
  case available(String)
  case unavailable

  var value: String {
    if case .available(let value) = self { return value }
    return ""
  }

  var canSafelySubmitBlank: Bool {
    self != .unavailable
  }

  var wasRemembered: Bool {
    if case .available = self { return true }
    return false
  }
}

enum AccessCodePersistenceResult: Equatable {
  case updated
  case saveFailed
  case cleanupFailed
}

private struct VNCKeychainError: Error {
  let status: OSStatus
}

struct SystemVNCKeychainStore: VNCKeychainStoring {
  private static let service = "org.openclaw.crabfleet.vnc"

  func load(for address: VNCAddress) throws -> String? {
    var query = baseQuery(for: address)
    query[kSecReturnData as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitOne
    var item: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &item)
    if status == errSecItemNotFound { return nil }
    guard status == errSecSuccess,
      let data = item as? Data,
      let value = String(data: data, encoding: .utf8)
    else { throw VNCKeychainError(status: status) }
    return value
  }

  func save(_ value: String, for address: VNCAddress) -> Bool {
    guard let data = value.data(using: .utf8), !data.isEmpty else {
      return remove(for: address)
    }
    let query = baseQuery(for: address)
    let attributes = [kSecValueData as String: data]
    let updated = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
    if updated == errSecSuccess { return true }
    guard updated == errSecItemNotFound else { return false }

    var addition = query
    addition[kSecValueData as String] = data
    addition[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
    return SecItemAdd(addition as CFDictionary, nil) == errSecSuccess
  }

  func remove(for address: VNCAddress) -> Bool {
    let result = SecItemDelete(baseQuery(for: address) as CFDictionary)
    return result == errSecSuccess || result == errSecItemNotFound
  }

  private func baseQuery(for address: VNCAddress) -> [String: Any] {
    let username = address.username
    return [
      kSecClass as String: kSecClassGenericPassword,
      kSecUseDataProtectionKeychain as String: true,
      kSecAttrService as String: Self.service,
      kSecAttrAccount as String:
        "\(address.host.lowercased()):\(address.port)|user[\(username.utf8.count)]=\(username)",
    ]
  }
}

@MainActor
final class ConnectionLibrary: ObservableObject {
  @Published private(set) var profiles: [VNCConnectionProfile]

  private let defaults: UserDefaults
  private let storageKey: String
  private let keychain: any VNCKeychainStoring
  private let encoder = JSONEncoder()
  private let decoder = JSONDecoder()

  init(
    defaults: UserDefaults = .standard,
    storageKey: String = "CrabfleetMac.connectionProfiles",
    keychain: any VNCKeychainStoring = SystemVNCKeychainStore()
  ) {
    self.defaults = defaults
    self.storageKey = storageKey
    self.keychain = keychain

    if let data = defaults.data(forKey: storageKey),
      let decoded = try? decoder.decode([VNCConnectionProfile].self, from: data)
    {
      profiles = decoded
    } else {
      profiles = []
    }
  }

  func accessCode(for address: VNCAddress) -> StoredAccessCode {
    do {
      return try keychain.load(for: address).map(StoredAccessCode.available) ?? .missing
    } catch {
      return .unavailable
    }
  }

  @discardableResult
  func rememberAccessCode(
    _ value: String,
    for address: VNCAddress,
    enabled: Bool
  ) -> AccessCodePersistenceResult {
    guard enabled else {
      // A memory-only connection must remain usable when Keychain is unavailable.
      return keychain.remove(for: address) ? .updated : .cleanupFailed
    }
    return keychain.save(value, for: address) ? .updated : .saveFailed
  }

  @discardableResult
  func save(
    name: String,
    address: VNCAddress,
    favorite: Bool = false,
    prefersPasswordOnlyARD: Bool? = nil
  ) -> VNCConnectionProfile {
    if let index = profiles.firstIndex(where: {
      $0.host.caseInsensitiveCompare(address.host) == .orderedSame && $0.port == address.port
    }) {
      profiles[index].name = name
      profiles[index].username = address.username
      profiles[index].favorite = favorite || profiles[index].favorite
      if let prefersPasswordOnlyARD {
        profiles[index].prefersPasswordOnlyARD = prefersPasswordOnlyARD
      }
      persist()
      return profiles[index]
    }

    let profile = VNCConnectionProfile(
      name: name,
      host: address.host,
      port: address.port,
      username: address.username,
      favorite: favorite,
      prefersPasswordOnlyARD: prefersPasswordOnlyARD ?? false
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
