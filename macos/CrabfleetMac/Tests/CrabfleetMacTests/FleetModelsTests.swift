import AppKit
import Foundation
import Testing

@testable import CrabfleetMac

struct FleetModelsTests {
  @Test
  func startsAndStopsBoundedCrabboxNativeHandoff() async throws {
    let directory = FileManager.default.temporaryDirectory
      .appendingPathComponent("CrabfleetMacTests.\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    let executable = directory.appendingPathComponent("crabbox")
    let pidFile = directory.appendingPathComponent("helper.pid")
    try Data(
      """
      #!/bin/sh
      trap '' TERM
      printf '%s' "$$" > '\(pidFile.path)'
      printf '%s\\n' '{"schema":"crabbox/vnc-handoff/v1","host":"127.0.0.1","port":15901,"username":"dev","password":"secret"}'
      while :; do sleep 1; done
      """.utf8
    ).write(to: executable)
    try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: executable.path)

    var bridge: CrabboxVNCBridge? = try await CrabboxVNCBridge.start(
      leaseID: "cloud/project/box-42",
      executableURL: executable,
      timeout: 2
    )
    #expect(bridge?.request.host == "127.0.0.1")
    #expect(bridge?.request.port == 15901)
    #expect(bridge?.request.username == "dev")
    #expect(bridge?.request.password == "secret")

    let pid = try #require(
      Int(String(contentsOf: pidFile, encoding: .utf8))
    )
    #expect(Darwin.kill(Int32(pid), 0) == 0)
    bridge?.stop()
    bridge = nil

    let deadline = Date().addingTimeInterval(3)
    while Darwin.kill(Int32(pid), 0) == 0 && Date() < deadline {
      try await Task.sleep(for: .milliseconds(50))
    }
    #expect(Darwin.kill(Int32(pid), 0) != 0)
  }

  @Test
  func rejectsNonLoopbackCrabboxNativeHandoff() async throws {
    let directory = FileManager.default.temporaryDirectory
      .appendingPathComponent("CrabfleetMacTests.\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    let executable = directory.appendingPathComponent("crabbox")
    try Data(
      """
      #!/bin/sh
      printf '%s\\n' '{"schema":"crabbox/vnc-handoff/v1","host":"desktop.example","port":5900,"username":"","password":"secret"}'
      sleep 5
      """.utf8
    ).write(to: executable)
    try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: executable.path)

    await #expect(throws: CrabboxVNCBridgeError.invalidHandoff) {
      _ = try await CrabboxVNCBridge.start(
        leaseID: "cbx_native123",
        executableURL: executable,
        timeout: 2
      )
    }
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
      address: .init(host: "127.0.0.1", port: 5901, username: "dev")
    )

    let reloaded = ConnectionLibrary(defaults: defaults, storageKey: "profiles")
    let saved = try #require(reloaded.profiles.first)
    #expect(saved.id == profile.id)
    #expect(saved.name == "Build box")
    #expect(saved.host == "127.0.0.1")
    #expect(saved.username == "dev")
  }

  @Test
  func searchMatchesLeaseIdentityAndRepository() {
    let lease = CrabboxLease(
      id: "IS-248",
      leaseID: "blue-lobster",
      nativeVncLeaseID: nil,
      owner: "operator",
      repository: "openclaw/crabfleet",
      branch: "codex/native-fleet",
      runtime: "crabbox",
      status: .attached,
      purpose: "Native fleet client",
      summary: "Building the Metal-backed macOS viewer",
      lastEvent: "Workspace active",
      updatedAt: .now,
      desktopAvailable: true,
      terminalAvailable: true
    )

    #expect(lease.matches("blue-lobster"))
    #expect(lease.matches("CRABFLEET"))
    #expect(lease.matches("native-fleet"))
    #expect(!lease.matches("unrelated-project"))
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
            "nativeVncLeaseId": "cbx_native123",
            "lastEvent": "ready",
            "updatedAt": 1770000000000
          }]
        }
      }
      """.utf8
    )

    let response = try JSONDecoder().decode(FleetAPIEnvelope.self, from: data)
    let lease = try #require(response.fleet.sessions.first?.lease())

    #expect(lease.displayName == "blue-lobster")
    #expect(lease.desktopAvailable)
    #expect(lease.updatedAt.timeIntervalSince1970 == 1_770_000_000)
    let host = try #require(response.fleet.desktopHosts?.first?.desktopHost())
    #expect(host.id == "studio")
    #expect(host.name == "Mac Studio")
    #expect(host.address == "100.68.201.40")
    #expect(host.port == 5901)

    let target = DesktopTarget(host: host)
    #expect(target.endpoint?.host == "100.68.201.40")
    #expect(target.endpoint?.port == 5901)
    #expect(target.desktopAvailable)

    let fleetTarget = DesktopTarget(lease: lease)
    #expect(fleetTarget.nativeVncLeaseID == "cbx_native123")
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
