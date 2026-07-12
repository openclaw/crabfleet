import AppKit
import Foundation
import Network
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
        "HOME": "/Users/tester",
        "PATH": "/tmp/untrusted",
        "SECRET_TOKEN": "test-token-placeholder",
        "TS_DEBUG": "unsafe",
        "TAILSCALE_SOCKET": "/tmp/unsafe.sock",
      ]
    )
    #expect(environment["HOME"] == "/Users/tester")
    #expect(environment["PATH"] == SubprocessEnvironment.safePath)
    #expect(environment["SECRET_TOKEN"] == nil)
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
  func tailscaleCommandTimesOutAndRespondsToCancellation() async throws {
    let directory = FileManager.default.temporaryDirectory
      .appendingPathComponent("CrabfleetMacTests.\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    let executable = directory.appendingPathComponent("tailscale")
    let pidFile = directory.appendingPathComponent("pid")
    try Data(
      """
      #!/bin/sh
      printf '%s' "$$" > '\(pidFile.path)'
      exec sleep 30
      """.utf8
    ).write(to: executable)
    try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: executable.path)

    let timedRunner = SystemTailscaleCommandRunner(executableURL: executable, timeout: 0.1)
    await #expect(throws: PrivateMacShareError.commandTimedOut) {
      _ = try await timedRunner.run(arguments: ["status"])
    }

    try? FileManager.default.removeItem(at: pidFile)
    let cancellableRunner = SystemTailscaleCommandRunner(executableURL: executable, timeout: 30)
    let task = Task {
      try await cancellableRunner.run(arguments: ["status"])
    }
    let launched = await waitUntilAsync {
      FileManager.default.fileExists(atPath: pidFile.path)
    }
    #expect(launched)
    let cancelledPID = try #require(Int(String(contentsOf: pidFile, encoding: .utf8)))
    task.cancel()
    await #expect(throws: CancellationError.self) {
      try await task.value
    }
    #expect(await waitUntilAsync { Darwin.kill(Int32(cancelledPID), 0) != 0 })
  }

  @Test
  func tailscaleCommandTimeoutDoesNotWaitForDescendantPipeEOF() async throws {
    let directory = FileManager.default.temporaryDirectory
      .appendingPathComponent("CrabfleetMacTests.\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    let executable = directory.appendingPathComponent("tailscale")
    let descendantPIDFile = directory.appendingPathComponent("descendant-pid")
    try Data(
      """
      #!/bin/sh
      (
        trap '' HUP TERM
        exec sleep 30
      ) &
      printf '%s' "$!" > '\(descendantPIDFile.path)'
      exec sleep 30
      """.utf8
    ).write(to: executable)
    try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: executable.path)

    // Give the helper time to spawn under a concurrently loaded Swift test runner.
    let runner = SystemTailscaleCommandRunner(executableURL: executable, timeout: 2)
    let clock = ContinuousClock()
    let startedAt = clock.now
    await #expect(throws: PrivateMacShareError.commandTimedOut) {
      _ = try await runner.run(arguments: ["status"])
    }
    let elapsed = startedAt.duration(to: clock.now)

    let descendantPID = try #require(
      Int32(String(contentsOf: descendantPIDFile, encoding: .utf8))
    )
    defer {
      _ = Darwin.kill(descendantPID, SIGKILL)
    }
    #expect(Darwin.kill(descendantPID, 0) == 0)
    #expect(elapsed < .seconds(4))
  }

  @Test
  func successfulTailscaleCommandDoesNotWaitForDescendantPipeEOF() async throws {
    let directory = FileManager.default.temporaryDirectory
      .appendingPathComponent("CrabfleetMacTests.\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    let executable = directory.appendingPathComponent("tailscale")
    let descendantPIDFile = directory.appendingPathComponent("descendant-pid")
    try Data(
      """
      #!/bin/sh
      (
        trap '' HUP TERM
        exec sleep 30
      ) &
      printf '%s' "$!" > '\(descendantPIDFile.path)'
      printf 'status complete'
      exit 0
      """.utf8
    ).write(to: executable)
    try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: executable.path)

    let runner = SystemTailscaleCommandRunner(executableURL: executable, timeout: 5)
    let clock = ContinuousClock()
    let startedAt = clock.now
    let result = try await runner.run(arguments: ["status"])
    let elapsed = startedAt.duration(to: clock.now)

    let descendantPID = try #require(
      Int32(String(contentsOf: descendantPIDFile, encoding: .utf8))
    )
    defer {
      _ = Darwin.kill(descendantPID, SIGKILL)
    }
    #expect(result.standardOutput == "status complete")
    #expect(Darwin.kill(descendantPID, 0) == 0)
    #expect(elapsed < .seconds(2))
  }

  @Test @MainActor
  func stopInvalidatesAnInFlightPrivateShareStart() async throws {
    let runner = SuspendedTailscaleRunner()
    let defaults = try #require(
      UserDefaults(suiteName: "CrabfleetMacTests.\(UUID().uuidString)")
    )
    let controller = PrivateMacShareController(
      runner: runner,
      desktopRegistration: nil,
      defaults: defaults
    )
    let startTask = Task { await controller.start() }
    let started = await waitUntilAsync { await runner.hasStarted }
    #expect(started)

    await controller.stop()
    await runner.resume(
      .success(.init(standardOutput: statusJSON(), standardError: ""))
    )
    await startTask.value

    #expect(controller.phase == .idle)
    #expect(controller.identity == nil)
  }

  @Test @MainActor
  func startWaitsForAnInFlightRefresh() async throws {
    let runner = SequencedTailscaleRunner()
    let defaults = try #require(
      UserDefaults(suiteName: "CrabfleetMacTests.\(UUID().uuidString)")
    )
    let controller = PrivateMacShareController(
      runner: runner,
      desktopRegistration: nil,
      defaults: defaults
    )

    let refreshTask = Task { await controller.refresh() }
    #expect(await waitUntilAsync { await runner.callCount == 1 })
    #expect(controller.isRefreshing)

    let startState = AsyncInvocationState()
    let startTask = Task {
      await startState.markStarted()
      await controller.start()
      await startState.markFinished()
    }
    #expect(await waitUntilAsync { await startState.started })
    try await Task.sleep(for: .milliseconds(20))
    #expect(!(await startState.finished))

    await runner.resumeNext(
      .success(.init(standardOutput: statusJSON(), standardError: ""))
    )
    await refreshTask.value
    #expect(await waitUntilAsync { await runner.callCount == 2 })
    await runner.resumeNext(.failure(PrivateMacShareError.tailscaleOffline))
    await startTask.value

    #expect(controller.phase == .failed)
    #expect(await runner.callCount == 2)
  }

  @Test @MainActor
  func stopInvalidatesAStartWaitingForRefreshCompletion() async throws {
    let runner = SequencedTailscaleRunner()
    let defaults = try #require(
      UserDefaults(suiteName: "CrabfleetMacTests.\(UUID().uuidString)")
    )
    let controller = PrivateMacShareController(
      runner: runner,
      desktopRegistration: nil,
      defaults: defaults
    )

    let refreshTask = Task { await controller.refresh() }
    #expect(await waitUntilAsync { await runner.callCount == 1 })

    let startTask = Task { await controller.start() }
    #expect(await waitUntilAsync { controller.phase == .starting })

    await controller.stop()
    #expect(controller.phase == .idle)

    await runner.resumeNext(
      .success(.init(standardOutput: statusJSON(), standardError: ""))
    )
    await refreshTask.value
    await startTask.value

    #expect(await runner.callCount == 1)
    #expect(controller.phase == .idle)
  }

  @Test @MainActor
  func cancellationRestoresIdleWhileStartWaitsForRefresh() async throws {
    let runner = SequencedTailscaleRunner()
    let defaults = try #require(
      UserDefaults(suiteName: "CrabfleetMacTests.\(UUID().uuidString)")
    )
    let controller = PrivateMacShareController(
      runner: runner,
      desktopRegistration: nil,
      defaults: defaults
    )

    let refreshTask = Task { await controller.refresh() }
    #expect(await waitUntilAsync { await runner.callCount == 1 })

    let startTask = Task { await controller.start() }
    #expect(await waitUntilAsync { controller.phase == .starting })
    startTask.cancel()

    await runner.resumeNext(
      .success(.init(standardOutput: statusJSON(), standardError: ""))
    )
    await refreshTask.value
    await startTask.value

    #expect(await runner.callCount == 1)
    #expect(controller.phase == .idle)
  }

  @Test
  func desktopRemovalWaitsForACommittedRegistrationAfterCancellation() async throws {
    let registration = SuspendedDesktopRegistration()
    let coordinator = DesktopHostRegistrationCoordinator(registration: registration)
    let identity = try TailnetIdentityPolicy.identity(from: statusDocument())

    let publish = Task {
      _ = try await coordinator.register(identity: identity, port: 5_901)
    }
    #expect(await waitUntilAsync { await registration.hasStartedRegistration })
    publish.cancel()

    let remove = Task {
      try await coordinator.unregister(identity: identity, ownershipToken: "registration-token")
    }
    try await Task.sleep(for: .milliseconds(20))
    #expect(await registration.events == [.registerStarted])

    await registration.finishRegistration()
    try await publish.value
    try await remove.value

    #expect(
      await registration.events
        == [.registerStarted, .registerFinished, .unregisterStarted]
    )
  }

  @Test @MainActor
  func stopReturnsBeforeSlowDesktopRegistryCleanup() async throws {
    let registration = SuspendedDesktopCleanupRegistration()
    let lifecycle = DesktopHostRegistrationLifecycle(registration: registration)
    let identity = desktopIdentity(name: "slow-cleanup", address: "100.64.12.43")
    try await lifecycle.publish(identity: identity, port: 5_901)

    let runner = SuspendedTailscaleRunner()
    let defaults = try #require(
      UserDefaults(suiteName: "CrabfleetMacTests.\(UUID().uuidString)")
    )
    let controller = PrivateMacShareController(
      runner: runner,
      desktopRegistration: registration,
      registrationLifecycle: lifecycle,
      defaults: defaults
    )
    let startTask = Task { await controller.start() }
    #expect(await waitUntilAsync { await runner.hasStarted })

    let stopState = AsyncInvocationState()
    let stopTask = Task {
      await controller.stop()
      await stopState.markFinished()
    }
    #expect(await waitUntilAsync { await stopState.finished })
    #expect(controller.phase == .idle)
    #expect(await waitUntilAsync { await registration.hasStartedUnregistration })

    await runner.resume(
      .success(.init(standardOutput: statusJSON(), standardError: ""))
    )
    await startTask.value
    await registration.finishUnregistration()
    await stopTask.value
    #expect(await waitUntilAsync { controller.registryPhase == .notPublished })
  }

  @Test @MainActor
  func concurrentStopsAwaitTheSameInFlightOperation() async throws {
    let coordinator = PrivateMacShareStopCoordinator()
    let operation = SuspendedAsyncOperation()
    let firstState = AsyncInvocationState()
    let secondState = AsyncInvocationState()

    let first = Task {
      await coordinator.perform {
        await operation.run()
      }
      await firstState.markFinished()
    }
    #expect(await waitUntilAsync { await operation.invocationCount == 1 })

    let second = Task {
      await coordinator.perform {
        await operation.run()
      }
      await secondState.markFinished()
    }
    try await Task.sleep(for: .milliseconds(20))

    #expect(await operation.invocationCount == 1)
    #expect(!(await firstState.finished))
    #expect(!(await secondState.finished))

    await operation.finish()
    await first.value
    await second.value

    #expect(await firstState.finished)
    #expect(await secondState.finished)
  }

  @Test @MainActor
  func completedStopDoesNotCoalesceWithTheNextOperation() async {
    let coordinator = PrivateMacShareStopCoordinator()
    let operation = SuspendedAsyncOperation()

    let first = Task {
      await coordinator.perform {
        await operation.run()
      }
    }
    #expect(await waitUntilAsync { await operation.invocationCount == 1 })
    await operation.finish()
    await first.value

    let second = Task {
      await coordinator.perform {
        await operation.run()
      }
    }
    #expect(await waitUntilAsync { await operation.invocationCount == 2 })
    await operation.finish()
    await second.value
  }

  @Test @MainActor
  func failedDesktopPublicationIsNotUnregistered() async throws {
    let identity = desktopIdentity(name: "failed-publish", address: "100.64.12.40")
    let registration = RecordingDesktopRegistration(registerFailures: [identity.dnsName: 1])
    let lifecycle = DesktopHostRegistrationLifecycle(registration: registration)

    await #expect(throws: DesktopRegistrationTestError.failed) {
      try await lifecycle.publish(identity: identity, port: 5_901)
    }
    try await lifecycle.removePublishedIdentities()

    #expect(await registration.events == [.register(identity.dnsName)])
  }

  @Test @MainActor
  func failedDesktopRemovalSurvivesLaterIdentityChanges() async throws {
    let first = desktopIdentity(name: "first-host", address: "100.64.12.41")
    let second = desktopIdentity(name: "second-host", address: "100.64.12.42")
    let registration = RecordingDesktopRegistration(
      unregisterFailures: [first.dnsName: 2]
    )
    let lifecycle = DesktopHostRegistrationLifecycle(registration: registration)

    try await lifecycle.publish(identity: first, port: 5_901)
    await #expect(throws: DesktopRegistrationTestError.failed) {
      try await lifecycle.removePublishedIdentities()
    }

    try await lifecycle.publish(identity: second, port: 5_901)
    await #expect(throws: DesktopRegistrationTestError.failed) {
      try await lifecycle.removePublishedIdentities()
    }
    try await lifecycle.removePublishedIdentities()

    #expect(
      await registration.events
        == [
          .register(first.dnsName),
          .unregister(first.dnsName, "token:\(first.dnsName)"),
          .register(second.dnsName),
          .unregister(first.dnsName, "token:\(first.dnsName)"),
          .unregister(second.dnsName, "token:\(second.dnsName)"),
          .unregister(first.dnsName, "token:\(first.dnsName)"),
        ]
    )
  }

  @Test @MainActor
  func terminationRetriesRetainedDesktopCleanup() async throws {
    let identity = desktopIdentity(name: "retry-cleanup", address: "100.64.12.45")
    let registration = RecordingDesktopRegistration(
      unregisterFailures: [identity.dnsName: 1]
    )
    let lifecycle = DesktopHostRegistrationLifecycle(registration: registration)
    try await lifecycle.publish(identity: identity, port: 5_901)
    await #expect(throws: DesktopRegistrationTestError.failed) {
      try await lifecycle.removePublishedIdentities()
    }

    let defaults = try #require(
      UserDefaults(suiteName: "CrabfleetMacTests.\(UUID().uuidString)")
    )
    let controller = PrivateMacShareController(
      runner: StaticTailscaleRunner(output: statusJSON()),
      desktopRegistration: registration,
      registrationLifecycle: lifecycle,
      defaults: defaults
    )

    await controller.stopAndWaitForCleanup()

    #expect(controller.registryPhase == .notPublished)
    #expect(
      await registration.events
        == [
          .register(identity.dnsName),
          .unregister(identity.dnsName, "token:\(identity.dnsName)"),
          .unregister(identity.dnsName, "token:\(identity.dnsName)"),
        ]
    )
  }

  @Test @MainActor
  func applicationDelegateOwnsTheShareControllerUsedByTheApp() throws {
    let defaults = try #require(
      UserDefaults(suiteName: "CrabfleetMacTests.\(UUID().uuidString)")
    )
    let controller = PrivateMacShareController(
      runner: StaticTailscaleRunner(output: statusJSON()),
      desktopRegistration: nil,
      defaults: defaults
    )
    let delegate = CrabfleetApplicationDelegate(shareController: controller)

    #expect(delegate.shareController === controller)
  }

  @Test @MainActor
  func applicationTerminationWaitsForPrivateShareCleanup() async throws {
    let registration = SuspendedDesktopCleanupRegistration()
    let lifecycle = DesktopHostRegistrationLifecycle(registration: registration)
    let identity = desktopIdentity(name: "termination-cleanup", address: "100.64.12.44")
    try await lifecycle.publish(identity: identity, port: 5_901)

    let runner = SuspendedTailscaleRunner()
    let defaults = try #require(
      UserDefaults(suiteName: "CrabfleetMacTests.\(UUID().uuidString)")
    )
    let controller = PrivateMacShareController(
      runner: runner,
      desktopRegistration: registration,
      registrationLifecycle: lifecycle,
      defaults: defaults
    )
    let startTask = Task { await controller.start() }
    #expect(await waitUntilAsync { await runner.hasStarted })

    var replies: [Bool] = []
    let delegate = CrabfleetApplicationDelegate(
      shareController: controller,
      replyToTerminationRequest: { replies.append($0) }
    )

    #expect(delegate.applicationShouldTerminate(NSApplication.shared) == .terminateLater)
    #expect(await waitUntilAsync { await registration.hasStartedUnregistration })
    #expect(replies.isEmpty)

    await runner.resume(
      .success(.init(standardOutput: statusJSON(), standardError: ""))
    )
    await startTask.value
    await registration.finishUnregistration()

    #expect(await waitUntilAsync { replies == [true] })
    #expect(controller.phase == .idle)
    #expect(controller.registryPhase == .notPublished)
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
    #expect(
      request.value(forHTTPHeaderField: CrabfleetDesktopRegistration.ownershipModeHeader)
        == CrabfleetDesktopRegistration.tokenOwnershipMode
    )
    let body = try #require(request.httpBody)
    let json = try #require(JSONSerialization.jsonObject(with: body) as? [String: Any])
    #expect(json["name"] as? String == "Workstation")
    #expect(json["address"] as? String == "100.64.12.34")
    #expect(json["port"] as? Int == 5901)

    let removal = try registration.removalRequest(
      identity: identity,
      ownershipToken: "desktop-ownership-token"
    )
    #expect(removal.url == request.url)
    #expect(removal.httpMethod == "DELETE")
    #expect(removal.value(forHTTPHeaderField: "Cookie") == "crabbox_session=secret")
    #expect(
      removal.value(forHTTPHeaderField: "X-Crabfleet-Ownership-Token")
        == "desktop-ownership-token"
    )
    #expect(removal.httpBody == nil)
  }

  @Test
  func desktopRegistrationReturnsTheServerOwnershipToken() async throws {
    let transport = DesktopRegistrationTransport { request in
      let responseURL = try #require(request.url)
      return (
        Data(#"{"host":{"id":"workstation"},"ownershipToken":"server-ownership-token"}"#.utf8),
        try #require(
          HTTPURLResponse(
            url: responseURL,
            statusCode: 200,
            httpVersion: nil,
            headerFields: nil
          ))
      )
    }
    let registration = try #require(
      CrabfleetDesktopRegistration(
        environment: [
          "CRABFLEET_API_URL": "https://fleet.example/api/fleet",
          "CRABFLEET_SESSION_COOKIE": "crabbox_session=secret",
        ],
        transport: transport
      ))
    let identity = try TailnetIdentityPolicy.identity(from: statusDocument())

    #expect(
      try await registration.register(identity: identity, port: 5_901)
        == "server-ownership-token"
    )
  }

  @Test
  func desktopRegistrationFallsBackToLegacyCleanupForOldServers() async throws {
    let transport = DesktopRegistrationTransport { request in
      let responseURL = try #require(request.url)
      return (
        Data(#"{"host":{"id":"workstation"}}"#.utf8),
        try #require(
          HTTPURLResponse(
            url: responseURL,
            statusCode: 200,
            httpVersion: nil,
            headerFields: nil
          ))
      )
    }
    let registration = try #require(
      CrabfleetDesktopRegistration(
        environment: [
          "CRABFLEET_API_URL": "https://fleet.example/api/fleet",
          "CRABFLEET_SESSION_COOKIE": "crabbox_session=secret",
        ],
        transport: transport
      ))
    let identity = try TailnetIdentityPolicy.identity(from: statusDocument())

    #expect(try await registration.register(identity: identity, port: 5_901) == nil)
    let removal = try registration.removalRequest(identity: identity, ownershipToken: nil)
    #expect(removal.value(forHTTPHeaderField: "X-Crabfleet-Ownership-Token") == nil)
  }

  @Test
  func desktopRegistrationRejectsMalformedAdvertisedOwnershipTokens() async throws {
    let transport = DesktopRegistrationTransport { request in
      let responseURL = try #require(request.url)
      return (
        Data(#"{"host":{"id":"workstation"},"ownershipToken":null}"#.utf8),
        try #require(
          HTTPURLResponse(
            url: responseURL,
            statusCode: 200,
            httpVersion: nil,
            headerFields: nil
          ))
      )
    }
    let registration = try #require(
      CrabfleetDesktopRegistration(
        environment: [
          "CRABFLEET_API_URL": "https://fleet.example/api/fleet",
          "CRABFLEET_SESSION_COOKIE": "crabbox_session=secret",
        ],
        transport: transport
      ))
    let identity = try TailnetIdentityPolicy.identity(from: statusDocument())

    await #expect(throws: DesktopHostRegistrationError.invalidResponse) {
      try await registration.register(identity: identity, port: 5_901)
    }
  }

  @Test
  func desktopRegistrationRejectsRedirectedResponses() async throws {
    let redirectedURL = try #require(URL(string: "https://login.example.test/desktop-host"))
    let transport = DesktopRegistrationTransport { _ in
      (
        Data(),
        try #require(
          HTTPURLResponse(
            url: redirectedURL,
            statusCode: 200,
            httpVersion: nil,
            headerFields: nil
          ))
      )
    }
    let registration = try #require(
      CrabfleetDesktopRegistration(
        environment: [
          "CRABFLEET_API_URL": "https://fleet.example/api/fleet",
          "CRABFLEET_SESSION_COOKIE": "crabbox_session=secret",
        ],
        transport: transport
      ))
    let identity = try TailnetIdentityPolicy.identity(from: statusDocument())

    await #expect(throws: DesktopHostRegistrationError.redirectRejected) {
      try await registration.register(identity: identity, port: 5_901)
    }
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
    #expect(!(await accepted.authorize(remoteAddress: identity.ipv4Address)))
  }

  @Test @MainActor
  func expiresIncompleteRFBHandshakeAndReleasesInput() async throws {
    let identity = TailnetIdentity(
      tailnetName: "example.com",
      loginName: "tester@example.com",
      dnsName: "workstation.example.ts.net.",
      hostName: "Workstation",
      ipv4Address: "127.0.0.1",
      userID: 42
    )
    let capture = MacScreenCapture()
    let input = RemoteInputRecorder()
    let events = RFBEventRecorder()
    let port: UInt16 = 5_923
    let server = TailnetRFBServer(
      identity: identity,
      runner: StaticTailscaleRunner(output: ""),
      capture: capture,
      descriptor: .init(
        displayID: 0,
        displayBounds: CGRect(x: 0, y: 0, width: 64, height: 64),
        frameWidth: 64,
        frameHeight: 64,
        sourcePixelWidth: 64,
        sourcePixelHeight: 64
      ),
      input: input,
      peerAuthorizer: LoopbackPeerAuthorizer(),
      port: port,
      handshakeTimeout: .milliseconds(100),
      eventHandler: { events.append($0) }
    )
    try server.start()
    defer { server.stop() }
    try await Task.sleep(for: .milliseconds(100))

    let connection = NWConnection(
      host: "127.0.0.1",
      port: try #require(NWEndpoint.Port(rawValue: port)),
      using: .tcp
    )
    connection.start(queue: .global(qos: .userInitiated))
    defer { connection.cancel() }

    try await waitFor {
      events.values.contains {
        if case .sessionFailed(let message) = $0 {
          return message.contains("handshake timed out")
        }
        return false
      }
    }
    #expect(input.releaseCount == 1)
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
    #expect(retina.width == 2_560)
    #expect(retina.height == 1_440)
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

  @Test
  func retriesHeldInputReleaseAfterAccessibilityReturns() async {
    let trust = AccessibilityTrust(granted: true)
    let events = RemoteInputEventRecorder()
    let controller = MacRemoteInputController(
      descriptor: CapturedDisplayDescriptor(
        displayID: 1,
        displayBounds: CGRect(x: 0, y: 0, width: 100, height: 100),
        frameWidth: 100,
        frameHeight: 100,
        sourcePixelWidth: 100,
        sourcePixelHeight: 100
      ),
      accessibilityGranted: { trust.isGranted() },
      pendingReleaseRetryDelay: .milliseconds(10),
      keyEventPoster: { down, keysym in
        events.append(.key(down: down, keysym: keysym))
      },
      mouseEventPoster: { type, _, button in
        events.append(.mouse(type: type, button: button))
      }
    )

    controller.keyEvent(down: true, keysym: 0x61)
    controller.pointerEvent(buttonMask: 0x01, x: 50, y: 50)
    #expect(await waitUntilAsync {
      events.contains(.key(down: true, keysym: 0x61))
        && events.contains(.mouse(type: .leftMouseDown, button: .left))
    })

    let checksBeforeRevocation = trust.checkCount
    trust.setGranted(false)
    controller.releaseAllInput()
    #expect(await waitUntilAsync {
      trust.checkCount > checksBeforeRevocation
    })
    #expect(!events.contains(.key(down: false, keysym: 0x61)))
    #expect(!events.contains(.mouse(type: .leftMouseUp, button: .left)))

    trust.setGranted(true)
    #expect(await waitUntilAsync {
      events.contains(.key(down: false, keysym: 0x61))
        && events.contains(.mouse(type: .leftMouseUp, button: .left))
    })
  }

  @Test
  func decodesX11UnicodeKeysymsForMacInput() {
    #expect(MacRemoteInputController.unicodeScalar(for: 0x0100_03BB) == "λ")
    #expect(MacRemoteInputController.unicodeScalar(for: 0x0101_F980) == "🦀")
    #expect(MacRemoteInputController.unicodeScalar(for: 0x0111_0000) == nil)
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
    // with an out-of-resources status and continues serving frames). An
    // unchanged frame is deduplicated into rectangle-free heartbeats, so new
    // content must arrive as a fresh framebuffer update.
    let updates = session.framebufferUpdateCount
    await capture.frameStore.update(
      .init(jpegData: jpeg, sequence: 2, width: 64, height: 64)
    )
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

  private func desktopIdentity(name: String, address: String) -> TailnetIdentity {
    TailnetIdentity(
      tailnetName: "example.com",
      loginName: "operator@example.com",
      dnsName: "\(name).example.ts.net",
      hostName: name,
      ipv4Address: address,
      userID: 42
    )
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

  @Test
  func buildScriptRecreatesTheAppBundleBeforeAssembly() throws {
    let testFile = URL(fileURLWithPath: #filePath)
    let script =
      testFile
      .deletingLastPathComponent()
      .deletingLastPathComponent()
      .deletingLastPathComponent()
      .appendingPathComponent("scripts/build-app.sh")
    let contents = try String(contentsOf: script, encoding: .utf8)
    let removal = try #require(contents.range(of: "rm -rf \"$app_dir\""))
    let assembly = try #require(contents.range(of: "mkdir -p \"$macos_dir\" \"$resources_dir\""))
    #expect(removal.lowerBound < assembly.lowerBound)
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

private actor SuspendedTailscaleRunner: TailscaleCommandRunning {
  private var continuation: CheckedContinuation<TailscaleCommandResult, Error>?
  private(set) var hasStarted = false

  func run(arguments: [String]) async throws -> TailscaleCommandResult {
    hasStarted = true
    return try await withCheckedThrowingContinuation { continuation in
      self.continuation = continuation
    }
  }

  func resume(_ result: Result<TailscaleCommandResult, Error>) {
    continuation?.resume(with: result)
    continuation = nil
  }
}

private actor SequencedTailscaleRunner: TailscaleCommandRunning {
  private var continuations: [CheckedContinuation<TailscaleCommandResult, Error>] = []
  private(set) var callCount = 0

  func run(arguments: [String]) async throws -> TailscaleCommandResult {
    callCount += 1
    return try await withCheckedThrowingContinuation { continuation in
      continuations.append(continuation)
    }
  }

  func resumeNext(_ result: Result<TailscaleCommandResult, Error>) {
    guard !continuations.isEmpty else { return }
    continuations.removeFirst().resume(with: result)
  }
}

private actor AsyncInvocationState {
  private(set) var started = false
  private(set) var finished = false

  func markStarted() {
    started = true
  }

  func markFinished() {
    finished = true
  }
}

private actor SuspendedAsyncOperation {
  private var continuation: CheckedContinuation<Void, Never>?
  private(set) var invocationCount = 0

  func run() async {
    invocationCount += 1
    await withCheckedContinuation { continuation in
      self.continuation = continuation
    }
  }

  func finish() {
    continuation?.resume()
    continuation = nil
  }
}

private actor SuspendedDesktopRegistration: DesktopHostRegistering {
  enum Event: Equatable {
    case registerStarted
    case registerFinished
    case unregisterStarted
  }

  private var registrationContinuation: CheckedContinuation<Void, Never>?
  private(set) var events: [Event] = []

  var hasStartedRegistration: Bool {
    registrationContinuation != nil
  }

  func register(identity: TailnetIdentity, port: UInt16) async throws -> String? {
    events.append(.registerStarted)
    await withCheckedContinuation { continuation in
      registrationContinuation = continuation
    }
    events.append(.registerFinished)
    return "registration-token"
  }

  func unregister(identity: TailnetIdentity, ownershipToken: String?) async throws {
    #expect(ownershipToken == "registration-token")
    events.append(.unregisterStarted)
  }

  func finishRegistration() {
    registrationContinuation?.resume()
    registrationContinuation = nil
  }
}

private enum DesktopRegistrationTestError: Error {
  case failed
}

private actor RecordingDesktopRegistration: DesktopHostRegistering {
  enum Event: Equatable {
    case register(String)
    case unregister(String, String?)
  }

  private var registerFailures: [String: Int]
  private var unregisterFailures: [String: Int]
  private(set) var events: [Event] = []

  init(
    registerFailures: [String: Int] = [:],
    unregisterFailures: [String: Int] = [:]
  ) {
    self.registerFailures = registerFailures
    self.unregisterFailures = unregisterFailures
  }

  func register(identity: TailnetIdentity, port: UInt16) async throws -> String? {
    events.append(.register(identity.dnsName))
    if consumeFailure(for: identity.dnsName, from: &registerFailures) {
      throw DesktopRegistrationTestError.failed
    }
    return "token:\(identity.dnsName)"
  }

  func unregister(identity: TailnetIdentity, ownershipToken: String?) async throws {
    events.append(.unregister(identity.dnsName, ownershipToken))
    if consumeFailure(for: identity.dnsName, from: &unregisterFailures) {
      throw DesktopRegistrationTestError.failed
    }
  }

  private func consumeFailure(
    for identity: String,
    from failures: inout [String: Int]
  ) -> Bool {
    guard let remaining = failures[identity], remaining > 0 else { return false }
    failures[identity] = remaining - 1
    return true
  }
}

private actor SuspendedDesktopCleanupRegistration: DesktopHostRegistering {
  private var unregistrationContinuation: CheckedContinuation<Void, Never>?

  var hasStartedUnregistration: Bool {
    unregistrationContinuation != nil
  }

  func register(identity: TailnetIdentity, port: UInt16) async throws -> String? {
    "slow-cleanup-token"
  }

  func unregister(identity: TailnetIdentity, ownershipToken: String?) async throws {
    #expect(ownershipToken == "slow-cleanup-token")
    await withCheckedContinuation { continuation in
      unregistrationContinuation = continuation
    }
  }

  func finishUnregistration() {
    unregistrationContinuation?.resume()
    unregistrationContinuation = nil
  }
}

private final class RemoteInputRecorder: RemoteInputForwarding, @unchecked Sendable {
  private let lock = NSLock()
  private var releases = 0

  var releaseCount: Int {
    lock.lock()
    defer { lock.unlock() }
    return releases
  }

  func keyEvent(down: Bool, keysym: UInt32) {}
  func pointerEvent(buttonMask: UInt8, x: UInt16, y: UInt16) {}

  func releaseAllInput() {
    lock.lock()
    releases += 1
    lock.unlock()
  }
}

private final class RFBEventRecorder: @unchecked Sendable {
  private let lock = NSLock()
  private var storage: [TailnetRFBServerEvent] = []

  var values: [TailnetRFBServerEvent] {
    lock.lock()
    defer { lock.unlock() }
    return storage
  }

  func append(_ event: TailnetRFBServerEvent) {
    lock.lock()
    storage.append(event)
    lock.unlock()
  }
}

private enum RecordedRemoteInputEvent: Equatable {
  case key(down: Bool, keysym: UInt32)
  case mouse(type: CGEventType, button: CGMouseButton)
}

private final class RemoteInputEventRecorder: @unchecked Sendable {
  private let lock = NSLock()
  private var events: [RecordedRemoteInputEvent] = []

  func append(_ event: RecordedRemoteInputEvent) {
    lock.lock()
    events.append(event)
    lock.unlock()
  }

  func contains(_ event: RecordedRemoteInputEvent) -> Bool {
    lock.lock()
    defer { lock.unlock() }
    return events.contains(event)
  }
}

private final class AccessibilityTrust: @unchecked Sendable {
  private let lock = NSLock()
  private var granted: Bool
  private var checks = 0

  init(granted: Bool) {
    self.granted = granted
  }

  var checkCount: Int {
    lock.lock()
    defer { lock.unlock() }
    return checks
  }

  func isGranted() -> Bool {
    lock.lock()
    defer { lock.unlock() }
    checks += 1
    return granted
  }

  func setGranted(_ granted: Bool) {
    lock.lock()
    self.granted = granted
    lock.unlock()
  }
}

private final class DesktopRegistrationTransport: HTTPDataTransport {
  private let handler: (URLRequest) throws -> (Data, HTTPURLResponse)

  init(handler: @escaping (URLRequest) throws -> (Data, HTTPURLResponse)) {
    self.handler = handler
  }

  func data(for request: URLRequest) async throws -> (Data, HTTPURLResponse) {
    try handler(request)
  }

  func close() {}
}

private func waitUntilAsync(
  timeout: Duration = .seconds(2),
  condition: @escaping () async -> Bool
) async -> Bool {
  let clock = ContinuousClock()
  let deadline = clock.now.advanced(by: timeout)
  while clock.now < deadline {
    if await condition() { return true }
    try? await Task.sleep(for: .milliseconds(10))
  }
  return await condition()
}
