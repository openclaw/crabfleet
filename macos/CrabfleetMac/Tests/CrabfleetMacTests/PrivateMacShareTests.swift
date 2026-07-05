import AppKit
import Foundation
import Testing

@testable import CrabfleetMac

struct PrivateMacShareTests {
  @Test
  func launchesOnlyAProtectedTailscaleCLIContext() {
    #expect(
      SystemTailscaleCommandRunner.executableCandidates.first
        == "/Applications/Tailscale.app/Contents/MacOS/Tailscale"
    )
    #expect(
      !SystemTailscaleCommandRunner.executableCandidates.contains(
        "/opt/homebrew/bin/tailscale"
      ))
    #expect(
      !SystemTailscaleCommandRunner.executableCandidates.contains(
        "/usr/local/bin/tailscale"
      ))

    let environment = SystemTailscaleCommandRunner.commandEnvironment(
      from: [
        "PATH": "/usr/bin:/bin",
        "TS_DEBUG": "unsafe",
        "TAILSCALE_SOCKET": "/tmp/unsafe.sock",
      ]
    )
    #expect(environment["PATH"] == "/usr/bin:/bin")
    #expect(environment["TS_DEBUG"] == nil)
    #expect(environment["TAILSCALE_SOCKET"] == nil)
    #expect(environment["TAILSCALE_BE_CLI"] == "1")

    #expect(
      SystemTailscaleCommandRunner.isTrustedExecutable(
        attributes: [
          .ownerAccountID: NSNumber(value: 0),
          .posixPermissions: NSNumber(value: 0o755),
        ]
      ))
    #expect(
      !SystemTailscaleCommandRunner.isTrustedExecutable(
        attributes: [
          .ownerAccountID: NSNumber(value: 501),
          .posixPermissions: NSNumber(value: 0o755),
        ]
      ))
    #expect(
      !SystemTailscaleCommandRunner.isTrustedExecutable(
        attributes: [
          .ownerAccountID: NSNumber(value: 0),
          .posixPermissions: NSNumber(value: 0o775),
        ]
      ))
  }

  @Test
  func privateShareCanStartViewOnlyWithoutAccessibility() {
    #expect(
      PrivateMacSharePermissionPolicy.canStart(
        identityAvailable: true,
        screenRecordingGranted: true
      ))
    #expect(
      !PrivateMacSharePermissionPolicy.canStart(
        identityAvailable: false,
        screenRecordingGranted: true
      ))
    #expect(
      !PrivateMacSharePermissionPolicy.canStart(
        identityAvailable: true,
        screenRecordingGranted: false
      ))
  }

  @Test
  func recognizesExplicitPrivateShareLaunchMode() {
    #expect(
      PrivateMacShareLaunchMode.isEnabled(
        arguments: ["CrabfleetMac", "--share-this-mac"], environment: [:]))
    #expect(
      PrivateMacShareLaunchMode.isEnabled(
        arguments: ["CrabfleetMac"], environment: ["CRABFLEET_AUTO_SHARE": "1"]))
    #expect(
      !PrivateMacShareLaunchMode.isEnabled(
        arguments: ["CrabfleetMac"], environment: ["CRABFLEET_AUTO_SHARE": "true"]))
    #expect(!PrivateMacShareLaunchMode.isEnabled(arguments: ["CrabfleetMac"], environment: [:]))
  }

  @Test
  func parsesExplicitVNCConnectionLaunchMode() throws {
    let explicitAddress = try VNCConnectionLaunchMode.address(
      arguments: ["CrabfleetMac", "--connect", "vnc://100.64.0.8:5901"],
      environment: ["CRABFLEET_AUTO_CONNECT": "vnc://ignored.example:5900"]
    )
    let explicit = try #require(explicitAddress)
    #expect(explicit.host == "100.64.0.8")
    #expect(explicit.port == 5_901)

    let environmentAddress = try VNCConnectionLaunchMode.address(
      arguments: ["CrabfleetMac"],
      environment: ["CRABFLEET_AUTO_CONNECT": "viewer.example:5999"]
    )
    let environment = try #require(environmentAddress)
    #expect(environment.host == "viewer.example")
    #expect(environment.port == 5_999)
    #expect(
      try VNCConnectionLaunchMode.address(
        arguments: ["CrabfleetMac"], environment: [:]) == nil)
  }

  @Test
  func rejectsMissingOrCredentialedVNCConnectionLaunchAddress() {
    #expect(throws: VNCAddressError.missingHost) {
      try VNCConnectionLaunchMode.address(
        arguments: ["CrabfleetMac", "--connect"], environment: [:])
    }
    #expect(throws: VNCAddressError.embeddedPassword) {
      try VNCConnectionLaunchMode.address(
        arguments: ["CrabfleetMac", "--connect", "vnc://user:secret@example.test"],
        environment: [:]
      )
    }
  }

  @Test
  func acceptsOnlineUserOnActiveTailnet() throws {
    let identity = try TailnetIdentityPolicy.identity(from: statusDocument())

    #expect(identity.tailnetName == "example.com")
    #expect(identity.loginName == "operator@example.com")
    #expect(identity.ipv4Address == "100.64.12.34")
    #expect(identity.vncAddress(port: 5901) == "vnc://100.64.12.34:5901")
  }

  @Test
  func derivesGenericStableDesktopHostID() {
    let identity = TailnetIdentity(
      tailnetName: "example.com",
      loginName: "operator@example.com",
      dnsName: "workstation-1.example.ts.net",
      hostName: "Workstation",
      ipv4Address: "100.64.12.34",
      userID: 42
    )
    #expect(CrabfleetDesktopRegistration.hostID(identity: identity) == "workstation-1")

    let fallback = TailnetIdentity(
      tailnetName: identity.tailnetName,
      loginName: identity.loginName,
      dnsName: "",
      hostName: identity.hostName,
      ipv4Address: identity.ipv4Address,
      userID: identity.userID
    )
    #expect(CrabfleetDesktopRegistration.hostID(identity: fallback) == "mac-100-64-12-34")
  }

  @Test
  func acceptsOnlySecureCrabfleetAPIURLs() throws {
    #expect(
      CrabfleetDesktopRegistration.isSecureAPIURL(
        try #require(URL(string: "https://fleet.example/api/fleet"))))
    #expect(
      CrabfleetDesktopRegistration.isSecureAPIURL(
        try #require(URL(string: "http://127.0.0.1:8787"))))
    #expect(
      !CrabfleetDesktopRegistration.isSecureAPIURL(
        try #require(URL(string: "http://fleet.example"))))
    #expect(
      !CrabfleetDesktopRegistration.isSecureAPIURL(
        try #require(URL(string: "https://user@fleet.example"))))
    #expect(
      !CrabfleetDesktopRegistration.isSecureAPIURL(
        try #require(URL(string: "https://fleet.example?token=value"))))
  }

  @Test
  func buildsAuthenticatedDesktopRegistrationRequest() throws {
    let registration = try #require(
      CrabfleetDesktopRegistration(environment: [
        "CRABFLEET_API_URL": "https://fleet.example/api/fleet",
        "CRABFLEET_SESSION_COOKIE": "crabbox_session=secret",
      ]))
    let identity = TailnetIdentity(
      tailnetName: "example.com",
      loginName: "operator@example.com",
      dnsName: "workstation-1.example.ts.net",
      hostName: "Workstation",
      ipv4Address: "100.64.12.34",
      userID: 42
    )

    let request = try registration.registrationRequest(identity: identity, port: 5901)
    #expect(request.url?.absoluteString == "https://fleet.example/api/desktop-hosts/workstation-1")
    #expect(request.httpMethod == "PUT")
    #expect(request.value(forHTTPHeaderField: "Cookie") == "crabbox_session=secret")
    let body = try #require(request.httpBody)
    let json = try #require(JSONSerialization.jsonObject(with: body) as? [String: Any])
    #expect(json["name"] as? String == "Workstation")
    #expect(json["address"] as? String == "100.64.12.34")
    #expect(json["port"] as? Int == 5901)
  }

  @Test
  func rejectsInvalidTailnetAndIdentityFields() throws {
    var value = statusJSON()
    value = value.replacingOccurrences(
      of: #""Name": "example.com""#, with: #""Name": """#)
    let missingTailnet = try JSONDecoder().decode(
      TailscaleStatusDocument.self,
      from: Data(value.utf8)
    )
    #expect(throws: PrivateMacShareError.invalidTailnetIdentity) {
      try TailnetIdentityPolicy.identity(from: missingTailnet)
    }

    value = statusJSON().replacingOccurrences(
      of: "operator@example.com",
      with: ""
    )
    let missingUser = try JSONDecoder().decode(
      TailscaleStatusDocument.self,
      from: Data(value.utf8)
    )
    #expect(throws: PrivateMacShareError.invalidTailnetUser) {
      try TailnetIdentityPolicy.identity(from: missingUser)
    }
  }

  @Test
  func recognizesOnlyTailscaleIPv4Range() {
    #expect(TailnetIdentityPolicy.isTailscaleIPv4("100.64.0.1"))
    #expect(TailnetIdentityPolicy.isTailscaleIPv4("100.127.255.254"))
    #expect(!TailnetIdentityPolicy.isTailscaleIPv4("100.63.255.255"))
    #expect(!TailnetIdentityPolicy.isTailscaleIPv4("100.128.0.1"))
    #expect(!TailnetIdentityPolicy.isTailscaleIPv4("10.0.0.1"))
    #expect(!TailnetIdentityPolicy.isTailscaleIPv4("100.64.invalid.1.2"))
    #expect(!TailnetIdentityPolicy.isTailscaleIPv4("100.64..1"))
  }

  @Test
  func validatesBoundedTailnetIdentityFields() {
    #expect(TailnetIdentityPolicy.isValidTailnetName("example.com"))
    #expect(TailnetIdentityPolicy.isValidTailnetName("example.github"))
    #expect(!TailnetIdentityPolicy.isValidTailnetName(""))
    #expect(!TailnetIdentityPolicy.isValidTailnetName(" example.com"))
    #expect(!TailnetIdentityPolicy.isValidTailnetName("bad\nname"))
    #expect(!TailnetIdentityPolicy.isValidTailnetName(String(repeating: "a", count: 254)))

    #expect(TailnetIdentityPolicy.isValidLogin("operator@example.com"))
    #expect(TailnetIdentityPolicy.isValidLogin("github-user"))
    #expect(!TailnetIdentityPolicy.isValidLogin(""))
    #expect(!TailnetIdentityPolicy.isValidLogin("github-user "))
    #expect(!TailnetIdentityPolicy.isValidLogin("bad\u{0}login"))
    #expect(!TailnetIdentityPolicy.isValidLogin(String(repeating: "a", count: 321)))
  }

  @Test
  func authorizesOnlySameTailnetUserAndExactPeerAddress() async throws {
    let identity = try TailnetIdentityPolicy.identity(from: statusDocument())
    let accepted = TailnetPeerAuthorizer(
      runner: StaticTailscaleRunner(output: whoisJSON(login: identity.loginName)),
      expectedIdentity: identity
    )
    #expect(await accepted.authorize(remoteAddress: "100.100.10.20"))

    let otherUser = TailnetPeerAuthorizer(
      runner: StaticTailscaleRunner(output: whoisJSON(login: "other@example.com")),
      expectedIdentity: identity
    )
    let otherUserID = TailnetPeerAuthorizer(
      runner: StaticTailscaleRunner(
        output: whoisJSON(login: identity.loginName, userID: 43)),
      expectedIdentity: identity
    )
    let otherAddress = TailnetPeerAuthorizer(
      runner: StaticTailscaleRunner(
        output: whoisJSON(login: identity.loginName, addresses: ["100.100.10.21/32"])),
      expectedIdentity: identity
    )
    let unauthorizedNode = TailnetPeerAuthorizer(
      runner: StaticTailscaleRunner(
        output: whoisJSON(login: identity.loginName, machineAuthorized: false)),
      expectedIdentity: identity
    )
    #expect(!(await otherUser.authorize(remoteAddress: "100.100.10.20")))
    #expect(!(await otherUserID.authorize(remoteAddress: "100.100.10.20")))
    #expect(!(await otherAddress.authorize(remoteAddress: "100.100.10.20")))
    #expect(!(await unauthorizedNode.authorize(remoteAddress: "100.100.10.20")))
    #expect(!(await accepted.authorize(remoteAddress: "192.168.1.4")))
  }

  @Test
  func keepsNewestCapturedFrameWhenUpdatesArriveOutOfOrder() async throws {
    let store = CapturedDesktopFrameStore()
    await store.update(.init(jpegData: Data([2]), sequence: 2, width: 2, height: 2))
    await store.update(.init(jpegData: Data([1]), sequence: 1, width: 2, height: 2))

    #expect(await store.latest()?.sequence == 2)
  }

  @Test
  func buildsTightJPEGFramebufferUpdate() throws {
    let jpeg = Data([0xFF, 0xD8, 0xFF, 0xD9])
    let frame = CapturedDesktopFrame(jpegData: jpeg, sequence: 7, width: 1_600, height: 900)
    let packet = try RFBWire.tightJPEGUpdate(frame: frame)

    #expect(packet[0] == 0)
    #expect(packet.readUInt16(at: 2) == 1)
    #expect(packet.readUInt16(at: 8) == 1_600)
    #expect(packet.readUInt16(at: 10) == 900)
    #expect(packet.readInt32(at: 12) == RFBWire.tightEncoding)
    #expect(packet[16] == 0x90)
    #expect(packet[17] == 4)
    #expect(packet.suffix(4) == jpeg)
  }

  @Test
  func encodesTightCompactLengths() {
    #expect(RFBWire.tightCompactLength(0) == Data([0x00]))
    #expect(RFBWire.tightCompactLength(127) == Data([0x7F]))
    #expect(RFBWire.tightCompactLength(128) == Data([0x80, 0x01]))
    #expect(RFBWire.tightCompactLength(16_383) == Data([0xFF, 0x7F]))
    #expect(RFBWire.tightCompactLength(16_384) == Data([0x80, 0x80, 0x01]))
  }

  @Test
  func scalesCaptureWithinBoundedEvenDimensions() {
    let retina = MacScreenCapture.captureDimensions(sourceWidth: 5_120, sourceHeight: 2_880)
    #expect(retina.width == 1_600)
    #expect(retina.height == 900)
    #expect(retina.width.isMultiple(of: 2))
    #expect(retina.height.isMultiple(of: 2))

    let small = MacScreenCapture.captureDimensions(sourceWidth: 1_280, sourceHeight: 800)
    #expect(small.width == 1_280)
    #expect(small.height == 800)
  }

  @Test
  func mapsRFBKeysymsToMacKeys() {
    #expect(MacRemoteInputController.keyCode(for: 0x61) != nil)
    #expect(MacRemoteInputController.keyCode(for: 0xFF51) != nil)
    #expect(MacRemoteInputController.keyCode(for: 0xFFE7) != nil)
    #expect(MacRemoteInputController.keyCode(for: 0x1F980) == nil)
  }

  @Test @MainActor
  func servesRoyalVNCKitOverTheCurrentTailnet() async throws {
    guard ProcessInfo.processInfo.environment["CRABFLEET_TAILNET_RFB_SMOKE"] == "1" else {
      return
    }

    let runner = try SystemTailscaleCommandRunner()
    let status = try await runner.run(arguments: ["status", "--json"])
    let document = try JSONDecoder().decode(
      TailscaleStatusDocument.self,
      from: Data(status.standardOutput.utf8)
    )
    let identity = try TailnetIdentityPolicy.identity(from: document)
    let capture = MacScreenCapture()
    let jpeg = try #require(testJPEG())
    await capture.frameStore.update(
      .init(jpegData: jpeg, sequence: 1, width: 64, height: 64)
    )

    let port: UInt16 = 5_909
    let server = TailnetRFBServer(
      identity: identity,
      runner: runner,
      capture: capture,
      descriptor: .init(
        displayID: 0,
        displayBounds: CGRect(x: 0, y: 0, width: 64, height: 64),
        frameWidth: 64,
        frameHeight: 64,
        sourcePixelWidth: 64,
        sourcePixelHeight: 64
      ),
      input: NoopRemoteInput(),
      port: port,
      eventHandler: { _ in }
    )
    try server.start()
    defer { server.stop() }
    try await Task.sleep(for: .milliseconds(250))

    let session = VNCSessionController()
    session.connect(
      host: identity.ipv4Address,
      port: port,
      username: "",
      password: "",
      clipboardEnabled: false
    )
    defer { session.disconnect() }

    let clock = ContinuousClock()
    let deadline = clock.now.advanced(by: .seconds(15))
    while clock.now < deadline {
      if session.phase == .connected && session.framebufferUpdateCount > 0 { break }
      try await Task.sleep(for: .milliseconds(25))
    }
    #expect(session.phase == .connected)
    #expect(session.framebufferUpdateCount > 0)
    #expect(session.framebuffer?.size.width == 64)
    #expect(session.framebuffer?.size.height == 64)
  }

  @Test @MainActor
  func syncsUTF8ClipboardAndNegotiatesResizeOverLoopback() async throws {
    // Full-protocol end-to-end: the production server and the RoyalVNCKit
    // client exchange handshake, Tight frames, Extended Clipboard, and
    // ExtendedDesktopSize over a real TCP connection on loopback. The
    // tailnet-specific pieces (address binding, whois) are injected.
    let identity = TailnetIdentity(
      tailnetName: "example.com",
      loginName: "tester@example.com",
      dnsName: "workstation.example.ts.net.",
      hostName: "Workstation",
      ipv4Address: "127.0.0.1",
      userID: 42
    )
    let capture = MacScreenCapture()
    let jpeg = try #require(testJPEG())
    await capture.frameStore.update(
      .init(jpegData: jpeg, sequence: 1, width: 64, height: 64)
    )

    let hostPasteboard = NSPasteboard(name: .init("CrabfleetMacTests.host.\(UUID().uuidString)"))
    hostPasteboard.clearContents()
    let hostClipboard = HostClipboardBridge(pasteboard: hostPasteboard, pollingInterval: 0.02)

    let port: UInt16 = 5_921
    let server = TailnetRFBServer(
      identity: identity,
      runner: StaticTailscaleRunner(output: ""),
      capture: capture,
      descriptor: .init(
        displayID: 0,
        displayBounds: CGRect(x: 0, y: 0, width: 64, height: 64),
        frameWidth: 64,
        frameHeight: 64,
        sourcePixelWidth: 256,
        sourcePixelHeight: 256
      ),
      input: NoopRemoteInput(),
      clipboard: hostClipboard,
      peerAuthorizer: LoopbackPeerAuthorizer(),
      port: port,
      eventHandler: { _ in }
    )
    try server.start()
    defer { server.stop() }
    try await Task.sleep(for: .milliseconds(250))

    let viewerPasteboard = NSPasteboard(
      name: .init("CrabfleetMacTests.viewer.\(UUID().uuidString)")
    )
    viewerPasteboard.clearContents()
    let coordinator = ClipboardCoordinator(pasteboard: viewerPasteboard, pollingInterval: 0.02)
    let session = VNCSessionController(targetID: "smoke", clipboardCoordinator: coordinator)
    coordinator.focus(session: session, targetID: "smoke")
    session.connect(
      host: identity.ipv4Address,
      port: port,
      username: "",
      password: ""
    )
    defer { session.disconnect() }

    // The Extended Clipboard caps handshake must complete on the client.
    try await waitFor { session.connection?.supportsUTF8Clipboard == true }

    // Viewer to host: emoji only survives the extended UTF-8 path.
    viewerPasteboard.clearContents()
    viewerPasteboard.setString("client copy 🚀", forType: .string)
    try await waitFor { hostPasteboard.string(forType: .string) == "client copy 🚀" }

    // Host to server-cut-text: the host push lands on the viewer pasteboard.
    hostPasteboard.clearContents()
    hostPasteboard.setString("host copy 🦀", forType: .string)
    try await waitFor { viewerPasteboard.string(forType: .string) == "host copy 🦀" }

    // The ExtendedDesktopSize announce must unlock client resize requests.
    try await waitFor { session.requestDesktopSize(.init(width: 128, height: 128)) }

    // The stream must keep flowing after the resize exchange (this test
    // fixture has no live capture stream, so the server answers the resize
    // with an out-of-resources status and continues serving frames).
    let updates = session.framebufferUpdateCount
    try await waitFor { session.framebufferUpdateCount > updates }
    #expect(session.phase == .connected)
  }

  @MainActor
  private func waitFor(
    timeout: Duration = .seconds(15),
    _ condition: @escaping @MainActor () -> Bool
  ) async throws {
    let clock = ContinuousClock()
    let deadline = clock.now.advanced(by: timeout)
    while clock.now < deadline {
      if condition() { return }
      try await Task.sleep(for: .milliseconds(25))
    }
    #expect(condition())
  }

  private func statusDocument() throws -> TailscaleStatusDocument {
    try JSONDecoder().decode(TailscaleStatusDocument.self, from: Data(statusJSON().utf8))
  }

  private func statusJSON() -> String {
    """
    {
      "BackendState": "Running",
      "CurrentTailnet": { "Name": "example.com" },
      "Self": {
        "DNSName": "workstation.example.ts.net.",
        "HostName": "Workstation",
        "Online": true,
        "TailscaleIPs": ["100.64.12.34", "fd7a:115c:a1e0::1"],
        "UserID": 42
      },
      "User": {
        "42": { "LoginName": "operator@example.com" }
      }
    }
    """
  }

  private func whoisJSON(
    login: String,
    userID: Int64 = 42,
    addresses: [String] = ["100.100.10.20/32"],
    machineAuthorized: Bool = true
  ) -> String {
    let encodedAddresses = addresses.map { "\"\($0)\"" }.joined(separator: ", ")
    return """
      {
        "Node": {
          "Addresses": [\(encodedAddresses)],
          "MachineAuthorized": \(machineAuthorized),
          "User": \(userID)
        },
        "UserProfile": { "LoginName": "\(login)" }
      }
      """
  }

  private func testJPEG() -> Data? {
    guard
      let bitmap = NSBitmapImageRep(
        bitmapDataPlanes: nil,
        pixelsWide: 64,
        pixelsHigh: 64,
        bitsPerSample: 8,
        samplesPerPixel: 4,
        hasAlpha: true,
        isPlanar: false,
        colorSpaceName: .deviceRGB,
        bytesPerRow: 0,
        bitsPerPixel: 0
      )
    else { return nil }
    bitmap.setColor(
      NSColor(deviceRed: 0.25, green: 0.9, blue: 0.7, alpha: 1),
      atX: 16,
      y: 16
    )
    bitmap.setColor(
      NSColor(deviceRed: 1, green: 0.55, blue: 0.2, alpha: 1),
      atX: 48,
      y: 48
    )
    return bitmap.representation(using: .jpeg, properties: [.compressionFactor: 0.8])
  }
}

private struct StaticTailscaleRunner: TailscaleCommandRunning {
  let output: String

  func run(arguments: [String]) async throws -> TailscaleCommandResult {
    .init(standardOutput: output, standardError: "")
  }
}

private struct NoopRemoteInput: RemoteInputForwarding {
  func keyEvent(down: Bool, keysym: UInt32) {}
  func pointerEvent(buttonMask: UInt8, x: UInt16, y: UInt16) {}
}

private struct LoopbackPeerAuthorizer: TailnetPeerAuthorizing {
  func authorize(remoteAddress: String) async -> Bool {
    remoteAddress == "127.0.0.1"
  }
}
