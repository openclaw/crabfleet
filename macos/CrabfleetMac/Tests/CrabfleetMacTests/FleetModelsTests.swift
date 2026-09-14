import AppKit
import Foundation
import Testing

@testable import CrabfleetMac

struct FleetModelsTests {
  @Test
  func sizesRemoteDesktopToEvenViewportPixelsWithinPerformanceCap() {
    #expect(
      VNCViewportSize.fitting(CGSize(width: 1_361, height: 701))
        == .init(width: 1_360, height: 700)
    )
    #expect(
      VNCViewportSize.fitting(CGSize(width: 5_120, height: 3_200))
        == .init(width: 3_686, height: 2_304)
    )
    #expect(
      VNCViewportSize.fitting(CGSize(width: 1_200, height: 700), backingScale: 2)
        == .init(width: 2_400, height: 1_400)
    )
    #expect(VNCViewportSize.fitting(CGSize(width: 319, height: 240)) == nil)
  }

  @Test @MainActor
  func reconcilesRemovedDesktopWithoutReplacingSurvivingSessions() {
    let pool = VNCSessionPool()
    let removed = pool.session(for: "host:removed")
    let saved = pool.session(for: "saved:local")
    let registered = pool.session(for: "host:registered")
    pool.focus(targetID: "host:removed")

    pool.reconcile(validTargetIDs: ["saved:local", "host:registered"])

    #expect(pool.focusedSessionID == nil)
    #expect(pool.session(for: "saved:local") === saved)
    #expect(pool.session(for: "host:registered") === registered)
    #expect(pool.session(for: "host:removed") !== removed)
    pool.disconnectAll()
  }

  @Test
  func parsesGenericVNCAddresses() throws {
    let direct = try VNCAddress.parse("workstation.example:5907")
    #expect(direct.host == "workstation.example")
    #expect(direct.port == 5907)
    #expect(direct.username.isEmpty)

    let url = try VNCAddress.parse("vnc://operator@localhost:15909")
    #expect(url.host == "localhost")
    #expect(url.port == 15909)
    #expect(url.username == "operator")

    let ipv6 = try VNCAddress.parse("[::1]:5901")
    #expect(ipv6.host == "::1")
    #expect(ipv6.displayValue == "[::1]:5901")
  }

  @Test
  func rejectsInvalidVNCPort() {
    #expect(throws: VNCAddressError.invalidPort) {
      try VNCAddress.parse("localhost:70000")
    }
  }

  @Test
  func rejectsUnsupportedURLsAndEmbeddedPasswords() {
    #expect(throws: VNCAddressError.unsupportedScheme) {
      try VNCAddress.parse("ssh://localhost:5900")
    }
    #expect(throws: VNCAddressError.embeddedPassword) {
      try VNCAddress.parse("vnc://dev:secret@localhost:5900")
    }
  }

  @Test @MainActor
  func persistsConnectionProfilesWithoutCredentials() throws {
    let suiteName = "CrabfleetMacTests.\(UUID().uuidString)"
    let defaults = try #require(UserDefaults(suiteName: suiteName))
    defer { defaults.removePersistentDomain(forName: suiteName) }

    let library = ConnectionLibrary(defaults: defaults, storageKey: "profiles")
    let profile = library.save(
      name: "Build box",
      address: .init(host: "127.0.0.1", port: 5901, username: "dev"),
      prefersPasswordOnlyARD: true
    )

    let reloaded = ConnectionLibrary(defaults: defaults, storageKey: "profiles")
    let saved = try #require(reloaded.profiles.first)
    #expect(saved.id == profile.id)
    #expect(saved.name == "Build box")
    #expect(saved.host == "127.0.0.1")
    #expect(saved.username == "dev")
    #expect(saved.prefersPasswordOnlyARD == true)
  }

  @Test @MainActor
  func profileUpdateWithoutAuthPreferencePreservesARDRequest() throws {
    let suiteName = "CrabfleetMacTests.\(UUID().uuidString)"
    let defaults = try #require(UserDefaults(suiteName: suiteName))
    defer { defaults.removePersistentDomain(forName: suiteName) }
    let address = VNCAddress(host: "100.64.0.8", port: 5901, username: "")
    let library = ConnectionLibrary(defaults: defaults, storageKey: "profiles")

    _ = library.save(
      name: "Crabfleet Share",
      address: address,
      prefersPasswordOnlyARD: true)
    let updated = library.save(
      name: address.displayValue,
      address: address,
      favorite: true)

    #expect(updated.prefersPasswordOnlyARD == true)
    #expect(library.profiles.first?.prefersPasswordOnlyARD == true)
    let request = VNCConnectionRequest(
      host: updated.host,
      port: updated.port,
      username: updated.username,
      password: "test-auth-token",
      clipboardEnabled: false,
      rememberAccessCode: true,
      prefersPasswordOnlyARD: updated.prefersPasswordOnlyARD ?? false)
    #expect(request.prefersPasswordOnlyARD)
  }

  @Test @MainActor
  func remembersDirectViewerAccessCodeOutsideProfileStorage() throws {
    let suiteName = "CrabfleetMacTests.\(UUID().uuidString)"
    let defaults = try #require(UserDefaults(suiteName: suiteName))
    defer { defaults.removePersistentDomain(forName: suiteName) }
    let keychain = RecordingVNCKeychainStore()
    let address = VNCAddress(host: "100.64.0.8", port: 5901, username: "")
    let library = ConnectionLibrary(
      defaults: defaults,
      storageKey: "profiles",
      keychain: keychain)

    #expect(library.accessCode(for: address) == .missing)
    #expect(
      library.rememberAccessCode("test-auth-token", for: address, enabled: true) == .updated)
    #expect(library.accessCode(for: address) == .available("test-auth-token"))
    #expect(defaults.data(forKey: "profiles") == nil)
    #expect(
      library.rememberAccessCode("test-auth-token", for: address, enabled: false) == .updated)
    #expect(library.accessCode(for: address) == .missing)
  }

  @Test @MainActor
  func separatesRememberedAccessCodesByUsername() throws {
    let defaults = try #require(UserDefaults(suiteName: "CrabfleetMacTests.\(UUID().uuidString)"))
    let keychain = RecordingVNCKeychainStore()
    let library = ConnectionLibrary(
      defaults: defaults,
      storageKey: "profiles",
      keychain: keychain)
    let first = VNCAddress(host: "viewer.test", port: 5900, username: "alice")
    let second = VNCAddress(host: "viewer.test", port: 5900, username: "bob")

    #expect(
      library.rememberAccessCode("test-auth-token-1", for: first, enabled: true) == .updated)
    #expect(
      library.rememberAccessCode("test-auth-token-2", for: second, enabled: true) == .updated)
    #expect(library.accessCode(for: first) == .available("test-auth-token-1"))
    #expect(library.accessCode(for: second) == .available("test-auth-token-2"))

    let differentlyCased = VNCAddress(host: "viewer.test", port: 5900, username: "Alice")
    #expect(library.accessCode(for: differentlyCased) == .missing)
  }

  @Test @MainActor
  func distinguishesKeychainReadFailureFromMissingCredential() throws {
    let defaults = try #require(UserDefaults(suiteName: "CrabfleetMacTests.\(UUID().uuidString)"))
    let library = ConnectionLibrary(
      defaults: defaults,
      storageKey: "profiles",
      keychain: FailingVNCKeychainStore())

    #expect(
      library.accessCode(for: .init(host: "viewer.test", port: 5900, username: ""))
        == .unavailable)
  }

  @Test @MainActor
  func memoryOnlyAccessCodeDoesNotDependOnKeychainCleanup() throws {
    let defaults = try #require(UserDefaults(suiteName: "CrabfleetMacTests.\(UUID().uuidString)"))
    let library = ConnectionLibrary(
      defaults: defaults,
      storageKey: "profiles",
      keychain: FailingVNCKeychainStore())
    let address = VNCAddress(host: "viewer.test", port: 5900, username: "")

    #expect(
      library.rememberAccessCode("test-auth-token", for: address, enabled: false)
        == .cleanupFailed)
    #expect(
      library.rememberAccessCode("test-auth-token", for: address, enabled: true) == .saveFailed)
  }

  @Test
  func remembersOnlyPreviouslyStoredAccessCodesByDefault() {
    #expect(!StoredAccessCode.missing.wasRemembered)
    #expect(!StoredAccessCode.unavailable.wasRemembered)
    #expect(StoredAccessCode.available("test-auth-token").wasRemembered)
  }

  @Test
  func decodesFleetResponseTimestamps() throws {
    let data = Data(
      """
      {
        "fleet": {
          "generatedAt": 1770000000000,
          "registryAvailable": true,
          "totals": { "active": 1, "sessions": 1, "vnc": 0 },
          "desktopHosts": [{
            "id": "studio",
            "owner": "operator",
            "name": "Mac Studio",
            "address": "100.68.201.40",
            "port": 5901,
            "quicPort": 5911,
            "quicCertHash": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
            "webtransport": false,
            "createdAt": 1769999900000,
            "updatedAt": 1770000000000
          }],
          "sessions": [{
            "id": "IS-1",
            "repo": "openclaw/crabfleet",
            "branch": "main",
            "runtime": "crabbox",
            "owner": "operator",
            "purpose": "test",
            "summary": "test session",
            "status": "ready",
            "attachable": true,
            "vnc": false,
            "leaseId": "blue-lobster",
            "nativeVncSessionId": "IS-257",
            "lastEvent": "ready",
            "updatedAt": 1770000000000
          }]
        }
      }
      """.utf8
    )

    let response = try JSONDecoder().decode(FleetAPIEnvelope.self, from: data)
    let host = try #require(response.fleet.desktopHosts?.first?.desktopHost())
    #expect(host.id == "studio")
    #expect(host.name == "Mac Studio")
    #expect(host.address == "100.68.201.40")
    #expect(host.port == 5901)
    #expect(host.updatedAt.timeIntervalSince1970 == 1_770_000_000)
    #expect(host.quicPort == 5911)
    #expect(host.quicCertHash == "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")
    #expect(!host.webtransport)

    let target = DesktopTarget(host: host)
    #expect(target.endpoint?.host == "100.68.201.40")
    #expect(target.endpoint?.port == 5901)
    #expect(target.quic?.port == 5911)
    #expect(target.quic?.certHash == "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")
    #expect(target.desktopAvailable)
  }

  @Test
  func acceptsLegacyDesktopRegistrationWithoutQUICFields() throws {
    let host = try JSONDecoder().decode(
      FleetAPIDesktopHost.self,
      from: Data(
        #"{"id":"legacy","owner":"operator","name":"Legacy Mac","address":"100.64.0.2","port":5901,"createdAt":1769999900000,"updatedAt":1770000000000}"#.utf8))
      .desktopHost()

    #expect(host.quicPort == nil)
    #expect(host.quicCertHash == nil)
    #expect(!host.webtransport)
    #expect(DesktopTarget(host: host).quic == nil)
  }

  @Test @MainActor
  func connectsToConfiguredLiveVNCServer() async throws {
    guard
      let portValue = ProcessInfo.processInfo.environment["CRABFLEET_VNC_SMOKE_PORT"],
      let port = UInt16(portValue)
    else {
      return
    }

    let session = VNCSessionController()
    session.connect(
      host: "127.0.0.1",
      port: port,
      username: "",
      password: "",
      clipboardEnabled: false
    )
    defer { session.disconnect() }

    let receivedFrame = await waitUntil(timeout: .seconds(8)) {
      session.phase == .connected
        && session.framebuffer != nil
        && session.framebufferUpdateCount > 0
    }
    #expect(receivedFrame)
    #expect(session.framebuffer?.size.width == 720)
    #expect(session.framebuffer?.size.height == 450)
  }

  @Test @MainActor
  func keepsConfiguredLiveVNCServersWarmTogether() async throws {
    guard
      let value = ProcessInfo.processInfo.environment["CRABFLEET_VNC_SMOKE_PORTS"]
    else {
      return
    }
    let ports = value.split(separator: ",").compactMap { UInt16($0) }
    guard ports.count >= 2 else { return }

    let pasteboard = NSPasteboard(name: .init("CrabfleetMacTests.\(UUID().uuidString)"))
    let clipboard = ClipboardCoordinator(pasteboard: pasteboard, pollingInterval: 0.01)
    let pool = VNCSessionPool(
      clipboardCoordinator: clipboard,
      maximumLiveSessions: ports.count
    )
    let targetIDs = ports.indices.map { "live-\($0)" }

    for (targetID, port) in zip(targetIDs, ports) {
      pool.connect(
        targetID: targetID,
        request: .init(
          host: "127.0.0.1",
          port: Int(port),
          username: "",
          password: "",
          clipboardEnabled: true
        )
      )
    }
    defer { pool.disconnectAll() }

    let receivedAllFrames = await waitUntil(timeout: .seconds(8)) {
      targetIDs.allSatisfy {
        let session = pool.session(for: $0)
        return session.phase == .connected && session.framebufferUpdateCount > 0
      }
    }
    #expect(receivedAllFrames)

    pool.focus(targetID: targetIDs[0])
    let focusedStart = pool.session(for: targetIDs[0]).framebufferUpdateCount
    let backgroundStart = pool.session(for: targetIDs[1]).framebufferUpdateCount
    try await Task.sleep(for: .milliseconds(600))
    let focusedFrames = pool.session(for: targetIDs[0]).framebufferUpdateCount - focusedStart
    let backgroundFrames = pool.session(for: targetIDs[1]).framebufferUpdateCount - backgroundStart
    #expect(focusedFrames > backgroundFrames)
    #expect(backgroundFrames <= 5)

    pool.focus(targetID: targetIDs[1])
    #expect(targetIDs.allSatisfy { pool.session(for: $0).phase == .connected })
    #expect(pool.focusedSessionID == targetIDs[1])
  }

  @MainActor
  private func waitUntil(
    timeout: Duration,
    condition: @escaping @MainActor () -> Bool
  ) async -> Bool {
    let clock = ContinuousClock()
    let deadline = clock.now.advanced(by: timeout)
    while clock.now < deadline {
      if condition() { return true }
      try? await Task.sleep(for: .milliseconds(20))
    }
    return condition()
  }
}

private final class RecordingVNCKeychainStore: VNCKeychainStoring, @unchecked Sendable {
  private let lock = NSLock()
  private var values: [String: String] = [:]

  func load(for address: VNCAddress) throws -> String? {
    withLock { values[key(for: address)] }
  }

  func save(_ value: String, for address: VNCAddress) -> Bool {
    withLock { values[key(for: address)] = value }
    return true
  }

  func remove(for address: VNCAddress) -> Bool {
    withLock { _ = values.removeValue(forKey: key(for: address)) }
    return true
  }

  private func key(for address: VNCAddress) -> String {
    "\(address.host.lowercased()):\(address.port)|\(address.username)"
  }

  private func withLock<T>(_ body: () -> T) -> T {
    lock.lock()
    defer { lock.unlock() }
    return body()
  }
}

private struct FailingVNCKeychainStore: VNCKeychainStoring {
  struct ReadFailure: Error {}

  func load(for address: VNCAddress) throws -> String? {
    throw ReadFailure()
  }

  func save(_ value: String, for address: VNCAddress) -> Bool { false }
  func remove(for address: VNCAddress) -> Bool { false }
}
