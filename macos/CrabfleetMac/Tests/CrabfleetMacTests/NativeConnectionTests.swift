import Dispatch
import Foundation
import Testing

@testable import CrabfleetMac

@MainActor
struct NativeConnectionTests {
  @Test
  func normalizesSecureDeploymentOrigins() throws {
    let production = try DeploymentOrigin("  HTTPS://Fleet.Example.test/app/  ")
    #expect(production.url.scheme == "https")
    #expect(production.url.host == "Fleet.Example.test")
    #expect(production.url.path.isEmpty)
    #expect(try production.endpoint("/api/native/v1/fleet").path == "/api/native/v1/fleet")

    let local = try DeploymentOrigin("http://127.0.0.1:8787/app")
    #expect(local.url.port == 8787)
    #expect(throws: DeploymentOriginError.insecureURL) {
      try DeploymentOrigin("http://fleet.example.test")
    }
    #expect(throws: DeploymentOriginError.credentialsNotAllowed) {
      try DeploymentOrigin("https://user:secret@fleet.example.test")
    }
    #expect(throws: DeploymentOriginError.queryOrFragmentNotAllowed) {
      try DeploymentOrigin("https://fleet.example.test/?token=secret")
    }
  }

  @Test
  func nativeAPIUsesBearerAndRejectsRedirectedResponses() async throws {
    let origin = try DeploymentOrigin("https://fleet.example.test")
    let transport = RecordingHTTPTransport { request in
      #expect(request.url?.path == "/api/native/v1/session")
      #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer access-token")
      let body = Data(
        """
        {
          "user": {
            "subject": "github:1",
            "login": "operator",
            "email": null,
            "name": "Operator",
            "role": "maintainer"
          },
          "deployment": {
            "label": "Test Fleet",
            "canonicalUrl": "https://fleet.example.test",
            "productUrl": null,
            "sshHost": null
          }
        }
        """.utf8
      )
      return (body, httpResponse(url: request.url!, status: 200))
    }
    let client = NativeAPIClient(origin: origin, transport: transport)
    let session = try await client.session(accessToken: "access-token")
    #expect(session.user.login == "operator")
    #expect(session.deployment.label == "Test Fleet")

    let redirecting = RecordingHTTPTransport { _ in
      let redirected = try #require(URL(string: "https://login.example.test/"))
      return (Data(), httpResponse(url: redirected, status: 200))
    }
    let redirectedClient = NativeAPIClient(origin: origin, transport: redirecting)
    await #expect(throws: NativeAPIError.redirectRejected) {
      try await redirectedClient.session(accessToken: "access-token")
    }

    let crossOriginVerification = RecordingHTTPTransport { request in
      let body = Data(
        """
        {
          "deviceCode": "device-code",
          "verificationUri": "https://login.example.test/native/link/code",
          "expiresAt": \(Date().addingTimeInterval(300).timeIntervalSince1970 * 1_000),
          "intervalSeconds": 5
        }
        """.utf8
      )
      return (body, httpResponse(url: request.url!, status: 201))
    }
    let crossOriginClient = NativeAPIClient(origin: origin, transport: crossOriginVerification)
    await #expect(throws: NativeAPIError.invalidResponse) {
      try await crossOriginClient.createDeviceAuthorization(clientName: "Test Mac")
    }
  }

  @Test
  func nativeAPIRevokesThroughAuthTokenEndpoint() async throws {
    let origin = try DeploymentOrigin("https://fleet.example.test")
    let transport = RecordingHTTPTransport { request in
      #expect(request.httpMethod == "DELETE")
      #expect(request.url?.path == "/api/native/v1/auth/token")
      #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer access-token")
      return (Data(#"{"ok":true}"#.utf8), httpResponse(url: request.url!, status: 200))
    }

    try await NativeAPIClient(origin: origin, transport: transport)
      .revoke(accessToken: "access-token")

    let alreadyInvalid = RecordingHTTPTransport { request in
      (Data(#"{"error":"unauthorized"}"#.utf8), httpResponse(url: request.url!, status: 401))
    }
    try await NativeAPIClient(origin: origin, transport: alreadyInvalid)
      .revoke(accessToken: "expired-token")
  }

  @Test
  func nativeAPIFleetIncludesRegisteredDesktopHosts() async throws {
    let origin = try DeploymentOrigin("https://fleet.example.test")
    let transport = RecordingHTTPTransport { request in
      #expect(request.url?.path == "/api/native/v1/fleet")
      let body = Data(
        """
        {
          "fleet": {
            "generatedAt": 1730000000000,
            "registryAvailable": true,
            "totals": { "active": 0, "sessions": 0, "vnc": 1 },
            "sessions": [],
            "desktopHosts": [{
              "id": "studio",
              "owner": "operator",
              "name": "Studio",
              "address": "100.64.0.8",
              "port": 5901,
              "createdAt": 1730000000000,
              "updatedAt": 1730000001000
            }]
          }
        }
        """.utf8
      )
      return (body, httpResponse(url: request.url!, status: 200))
    }

    let fleet = try await NativeAPIClient(origin: origin, transport: transport)
      .fleet(accessToken: "access-token")

    #expect(fleet.leases.isEmpty)
    #expect(fleet.desktopHosts.map(\.id) == ["studio"])
    #expect(fleet.desktopHosts.first?.address == "100.64.0.8")
  }

  @Test
  func nativeAPIClientCloseInvalidatesItsTransportOnce() throws {
    let origin = try DeploymentOrigin("https://fleet.example.test")
    let transport = RecordingHTTPTransport { _ in
      throw NativeAPIError.invalidResponse
    }
    let client = NativeAPIClient(origin: origin, transport: transport)

    client.close()
    client.close()

    #expect(transport.closeCount == 1)
  }

  @Test
  func transportCloseWaitsForRequestRegistrationBeforeInvalidating() async throws {
    let registrationStarted = DispatchSemaphore(value: 0)
    let allowRegistrationToFinish = DispatchSemaphore(value: 0)
    let closeStarted = DispatchSemaphore(value: 0)
    let closeFinished = DispatchSemaphore(value: 0)
    let transport = RejectingRedirectURLSessionTransport(taskRegistrationHook: {
      registrationStarted.signal()
      allowRegistrationToFinish.wait()
    })
    let url = try #require(URL(string: "https://fleet.example.test/api/native/v1/session"))
    let request = URLRequest(url: url)
    let requestTask = Task.detached {
      try await transport.data(for: request)
    }

    let registrationResult = await waitForSemaphore(registrationStarted, timeout: .seconds(1))
    #expect(registrationResult == .success)
    let closeTask = Task.detached {
      closeStarted.signal()
      transport.close()
      closeFinished.signal()
    }
    let closeStartedResult = await waitForSemaphore(closeStarted, timeout: .seconds(1))
    #expect(closeStartedResult == .success)
    let prematureClose = await waitForSemaphore(closeFinished, timeout: .milliseconds(50))
    #expect(prematureClose == .timedOut)

    allowRegistrationToFinish.signal()
    if prematureClose == .timedOut {
      let closeFinishedResult = await waitForSemaphore(closeFinished, timeout: .seconds(1))
      #expect(closeFinishedResult == .success)
    }
    await closeTask.value
    await #expect(throws: CancellationError.self) {
      try await requestTask.value
    }
  }

  @Test
  func boundedResponseStopsBeforeConsumingAllOversizedChunks() {
    var yieldedChunks = 0
    let chunks = [Data(count: 3), Data(count: 3), Data(count: 3)].lazy.map { chunk in
      yieldedChunks += 1
      return chunk
    }
    var body = BoundedResponseBody(maximumBytes: 5)

    #expect(throws: NativeAPIError.responseTooLarge) {
      for chunk in chunks {
        try body.append(chunk)
      }
    }
    #expect(yieldedChunks == 2)
    #expect(body.data.count == 3)
  }

  @Test
  func restoresSavedCredentialAndLoadsRealFleet() async throws {
    let origin = try DeploymentOrigin("https://fleet.example.test")
    let origins = MemoryOriginStore(value: origin.displayValue)
    let tokens = MemoryTokenStore(values: [origin.displayValue: "saved-token"])
    let api = StubNativeAPIClient(origin: origin)
    api.sessionResult = .success(testSession())
    api.fleetResult = .success(testFleet())
    let store = FleetStore(
      environment: [:],
      originStore: origins,
      tokenStore: tokens,
      clientFactory: { _ in api },
      openURL: { _ in false }
    )

    await store.restore()

    #expect(store.connectionPhase == .connected)
    #expect(store.currentUser == "operator")
    #expect(store.leases.map(\.id) == ["IS-live"])
    #expect(api.sessionTokens == ["saved-token"])
    #expect(api.fleetTokens == ["saved-token"])
  }

  @Test
  func reentrantRestoreNeverPairsAnOldTokenWithANewOrigin() async throws {
    let oldOrigin = try DeploymentOrigin("https://old-fleet.example.test")
    let newOrigin = try DeploymentOrigin("https://new-fleet.example.test")
    let origins = MemoryOriginStore(value: oldOrigin.displayValue)
    let tokens = MemoryTokenStore(values: [oldOrigin.displayValue: "old-token"])
    let oldAPI = StubNativeAPIClient(origin: oldOrigin)
    oldAPI.sessionResult = .success(testSession())
    oldAPI.fleetResult = .success(testFleet(id: "IS-old"))
    let newAPI = StubNativeAPIClient(origin: newOrigin)
    let store = FleetStore(
      environment: [:],
      originStore: origins,
      tokenStore: tokens,
      clientFactory: { origin in origin == oldOrigin ? oldAPI : newAPI },
      openURL: { _ in false },
      sleep: { _ in }
    )

    await store.restore()
    #expect(store.connectionPhase == .connected)
    #expect(store.canRetrySavedSession)
    #expect(store.leases.map(\.id) == ["IS-old"])

    origins.value = newOrigin.displayValue
    await store.restore()

    #expect(store.connectionPhase == .disconnected)
    #expect(store.connectedOrigin == newOrigin)
    #expect(!store.canRetrySavedSession)
    #expect(!store.isConnected)
    #expect(store.leases.isEmpty)

    store.retrySavedSession()
    try await waitUntil { newAPI.deviceAuthorizationRequests == 1 }

    #expect(newAPI.sessionTokens.isEmpty)
    #expect(oldAPI.sessionTokens == ["old-token"])
  }

  @Test
  func missingConfigurationNeverLoadsPreviewFixtures() async {
    let origins = MemoryOriginStore()
    let store = FleetStore(
      environment: [:],
      originStore: origins,
      tokenStore: MemoryTokenStore(),
      clientFactory: { origin in StubNativeAPIClient(origin: origin) },
      openURL: { _ in false }
    )

    await store.restore()

    #expect(store.connectionPhase == .disconnected)
    #expect(store.leases.isEmpty)
    #expect(store.notice == nil)
  }

  @Test
  func unauthorizedRestoreDeletesSavedCredential() async throws {
    let origin = try DeploymentOrigin("https://fleet.example.test")
    let origins = MemoryOriginStore(value: origin.displayValue)
    let tokens = MemoryTokenStore(values: [origin.displayValue: "expired-token"])
    let api = StubNativeAPIClient(origin: origin)
    api.sessionResult = .failure(NativeAPIError.unauthorized)
    let store = FleetStore(
      environment: [:],
      originStore: origins,
      tokenStore: tokens,
      clientFactory: { _ in api },
      openURL: { _ in false }
    )

    await store.restore()

    #expect(store.connectionPhase == .failed)
    #expect(tokens.values[origin.displayValue] == nil)
    #expect(store.leases.isEmpty)
  }

  @Test
  func deviceApprovalStoresTokenAndDisconnectRevokesIt() async throws {
    let origin = try DeploymentOrigin("https://fleet.example.test")
    let verificationURL = try #require(
      URL(string: "https://fleet.example.test/native/link/link-code")
    )
    let origins = MemoryOriginStore()
    let tokens = MemoryTokenStore()
    let api = StubNativeAPIClient(origin: origin)
    api.deviceResult = .success(
      .init(
        deviceCode: "device-code",
        verificationURL: verificationURL,
        expiresAt: Date().addingTimeInterval(300),
        intervalSeconds: 5
      ))
    api.exchangeResults = [
      .success(
        .approved(
          .init(
            value: "new-token",
            expiresAt: Date().addingTimeInterval(3_600),
            user: testSession().user
          )))
    ]
    api.sessionResult = .success(testSession())
    api.fleetResult = .success(testFleet())
    var openedURL: URL?
    let store = FleetStore(
      environment: [:],
      originStore: origins,
      tokenStore: tokens,
      clientFactory: { _ in api },
      openURL: {
        openedURL = $0
        return true
      },
      sleep: { _ in }
    )

    store.connect(to: origin.displayValue)
    try await waitUntil { store.connectionPhase == .connected }
    #expect(openedURL == verificationURL)
    #expect(tokens.values[origin.displayValue] == "new-token")
    #expect(origins.value == origin.displayValue)

    store.disconnect()
    try await waitUntil {
      store.connectionPhase == .disconnected || store.connectionPhase == .failed
    }
    try await waitUntil { api.revokedTokens == ["new-token"] }
    try await waitUntil { api.closeCount == 1 }
    #expect(api.revokedTokens == ["new-token"])
    #expect(api.revokeWasCancelled == [false])
    #expect(api.lifecycleEvents == ["revoke-start", "revoke-finish", "close"])
    #expect(tokens.values[origin.displayValue] == nil)
    #expect(store.leases.isEmpty)
  }

  @Test
  func transientTokenExchangeFailuresReuseTheDeviceAuthorization() async throws {
    let origin = try DeploymentOrigin("https://fleet.example.test")
    let verificationURL = try #require(
      URL(string: "https://fleet.example.test/native/link/link-code")
    )
    let api = StubNativeAPIClient(origin: origin)
    api.deviceResult = .success(
      .init(
        deviceCode: "same-device-code",
        verificationURL: verificationURL,
        expiresAt: Date().addingTimeInterval(300),
        intervalSeconds: 5
      ))
    api.exchangeResults = [
      .failure(NativeAPIError.httpStatus(503, "temporarily unavailable")),
      .failure(URLError(.networkConnectionLost)),
      .success(
        .approved(
          .init(
            value: "new-token",
            expiresAt: Date().addingTimeInterval(3_600),
            user: testSession().user
          ))),
    ]
    api.sessionResult = .success(testSession())
    api.fleetResult = .success(testFleet())
    var openedURLs = [URL]()
    var sleepCount = 0
    let store = FleetStore(
      environment: [:],
      originStore: MemoryOriginStore(),
      tokenStore: MemoryTokenStore(),
      clientFactory: { _ in api },
      openURL: {
        openedURLs.append($0)
        return true
      },
      sleep: { _ in sleepCount += 1 }
    )

    store.connect(to: origin.displayValue)
    try await waitUntil { store.connectionPhase == .connected }

    #expect(api.deviceAuthorizationRequests == 1)
    #expect(api.exchangeDeviceCodes == ["same-device-code", "same-device-code", "same-device-code"])
    #expect(openedURLs == [verificationURL])
    #expect(sleepCount == 3)
    #expect(store.connectionError == nil)
  }

  @Test
  func cancellationAfterApprovalRevokesUsingAFreshTask() async throws {
    let origin = try DeploymentOrigin("https://fleet.example.test")
    let verificationURL = try #require(
      URL(string: "https://fleet.example.test/native/link/link-code")
    )
    let tokens = MemoryTokenStore()
    let api = StubNativeAPIClient(origin: origin)
    api.deviceResult = .success(
      .init(
        deviceCode: "device-code",
        verificationURL: verificationURL,
        expiresAt: Date().addingTimeInterval(300),
        intervalSeconds: 5
      ))
    api.exchangeResults = [
      .success(
        .approved(
          .init(
            value: "approved-token",
            expiresAt: Date().addingTimeInterval(3_600),
            user: testSession().user
          )))
    ]
    var sessionValidationStarted = false
    var sessionContinuation: CheckedContinuation<NativeAPISession, Error>?
    api.sessionHandler = { _ in
      sessionValidationStarted = true
      return try await withCheckedThrowingContinuation { continuation in
        sessionContinuation = continuation
      }
    }
    let store = FleetStore(
      environment: [:],
      originStore: MemoryOriginStore(),
      tokenStore: tokens,
      clientFactory: { _ in api },
      openURL: { _ in true },
      sleep: { _ in }
    )

    store.connect(to: origin.displayValue)
    try await waitUntil { sessionValidationStarted }
    store.cancelAuthorization()
    let continuation = try #require(sessionContinuation)
    continuation.resume(returning: testSession())

    try await waitUntil { api.revokedTokens == ["approved-token"] }
    try await waitUntil { api.closeCount == 1 }
    #expect(api.revokeWasCancelled == [false])
    #expect(api.lifecycleEvents == ["revoke-start", "revoke-finish", "close"])
    #expect(store.connectionPhase == .disconnected)
    #expect(tokens.values[origin.displayValue] == nil)
  }

  @Test
  func transientSessionValidationReusesTheApprovedToken() async throws {
    let origin = try DeploymentOrigin("https://fleet.example.test")
    let verificationURL = try #require(
      URL(string: "https://fleet.example.test/native/link/link-code")
    )
    let api = StubNativeAPIClient(origin: origin)
    api.deviceResult = .success(
      .init(
        deviceCode: "device-code",
        verificationURL: verificationURL,
        expiresAt: Date().addingTimeInterval(300),
        intervalSeconds: 5
      ))
    api.exchangeResults = [
      .success(
        .approved(
          .init(
            value: "approved-token",
            expiresAt: Date().addingTimeInterval(3_600),
            user: testSession().user
          )))
    ]
    api.sessionResults = [
      .failure(NativeAPIError.httpStatus(503, "temporarily unavailable")),
      .failure(URLError(.timedOut)),
      .success(testSession()),
    ]
    api.fleetResult = .success(testFleet())
    var openedURLs = [URL]()
    var sleepCount = 0
    let store = FleetStore(
      environment: [:],
      originStore: MemoryOriginStore(),
      tokenStore: MemoryTokenStore(),
      clientFactory: { _ in api },
      openURL: {
        openedURLs.append($0)
        return true
      },
      sleep: { _ in sleepCount += 1 }
    )

    store.connect(to: origin.displayValue)
    try await waitUntil { store.connectionPhase == .connected }

    #expect(api.deviceAuthorizationRequests == 1)
    #expect(api.exchangeDeviceCodes == ["device-code"])
    #expect(api.sessionTokens == ["approved-token", "approved-token", "approved-token"])
    #expect(openedURLs == [verificationURL])
    #expect(sleepCount == 3)
    #expect(api.revokedTokens.isEmpty)
  }

  @Test
  func permanentSessionValidationFailureRevokesAndFails() async throws {
    let origin = try DeploymentOrigin("https://fleet.example.test")
    let verificationURL = try #require(
      URL(string: "https://fleet.example.test/native/link/link-code")
    )
    let api = StubNativeAPIClient(origin: origin)
    api.deviceResult = .success(
      .init(
        deviceCode: "device-code",
        verificationURL: verificationURL,
        expiresAt: Date().addingTimeInterval(300),
        intervalSeconds: 5
      ))
    api.exchangeResults = [
      .success(
        .approved(
          .init(
            value: "approved-token",
            expiresAt: Date().addingTimeInterval(3_600),
            user: testSession().user
          )))
    ]
    api.sessionResults = [.failure(NativeAPIError.httpStatus(400, "invalid token"))]
    let store = FleetStore(
      environment: [:],
      originStore: MemoryOriginStore(),
      tokenStore: MemoryTokenStore(),
      clientFactory: { _ in api },
      openURL: { _ in true },
      sleep: { _ in }
    )

    store.connect(to: origin.displayValue)
    try await waitUntil { store.connectionPhase == .failed }
    try await waitUntil { api.revokedTokens == ["approved-token"] }
    try await waitUntil { api.closeCount == 1 }

    #expect(api.sessionTokens == ["approved-token"])
    #expect(api.revokeWasCancelled == [false])
    #expect(api.lifecycleEvents == ["revoke-start", "revoke-finish", "close"])
  }

  @Test
  func keychainSaveFailureRevokesApprovedTokenUsingFreshTask() async throws {
    let origin = try DeploymentOrigin("https://fleet.example.test")
    let verificationURL = try #require(
      URL(string: "https://fleet.example.test/native/link/link-code")
    )
    let tokens = MemoryTokenStore()
    tokens.saveError = TestTokenStoreError.unavailable
    let api = StubNativeAPIClient(origin: origin)
    api.deviceResult = .success(
      .init(
        deviceCode: "device-code",
        verificationURL: verificationURL,
        expiresAt: Date().addingTimeInterval(300),
        intervalSeconds: 5
      ))
    api.exchangeResults = [
      .success(
        .approved(
          .init(
            value: "approved-token",
            expiresAt: Date().addingTimeInterval(3_600),
            user: testSession().user
          )))
    ]
    api.sessionResult = .success(testSession())
    let store = FleetStore(
      environment: [:],
      originStore: MemoryOriginStore(),
      tokenStore: tokens,
      clientFactory: { _ in api },
      openURL: { _ in true },
      sleep: { _ in }
    )

    store.connect(to: origin.displayValue)
    try await waitUntil { store.connectionPhase == .failed }
    try await waitUntil { api.revokedTokens == ["approved-token"] }

    #expect(api.revokeWasCancelled == [false])
    #expect(tokens.values[origin.displayValue] == nil)
  }

  @Test
  func permanentTokenExchangeFailureDoesNotRetry() async throws {
    let origin = try DeploymentOrigin("https://fleet.example.test")
    let verificationURL = try #require(
      URL(string: "https://fleet.example.test/native/link/link-code")
    )
    let api = StubNativeAPIClient(origin: origin)
    api.deviceResult = .success(
      .init(
        deviceCode: "device-code",
        verificationURL: verificationURL,
        expiresAt: Date().addingTimeInterval(300),
        intervalSeconds: 5
      ))
    api.exchangeResults = [
      .failure(NativeAPIError.httpStatus(400, "invalid device code")),
      .success(
        .approved(
          .init(
            value: "must-not-be-used",
            expiresAt: Date().addingTimeInterval(3_600),
            user: testSession().user
          ))),
    ]
    let store = FleetStore(
      environment: [:],
      originStore: MemoryOriginStore(),
      tokenStore: MemoryTokenStore(),
      clientFactory: { _ in api },
      openURL: { _ in true },
      sleep: { _ in }
    )

    store.connect(to: origin.displayValue)
    try await waitUntil { store.connectionPhase == .failed }
    try await waitUntil { api.closeCount == 1 }

    #expect(api.deviceAuthorizationRequests == 1)
    #expect(api.exchangeDeviceCodes == ["device-code"])
    #expect(api.exchangeResults.count == 1)
    #expect(api.lifecycleEvents == ["close"])
  }

  @Test
  func relinkingClearsThePreviousDeploymentCredential() async throws {
    let oldOrigin = try DeploymentOrigin("https://old-fleet.example.test")
    let newOrigin = try DeploymentOrigin("https://new-fleet.example.test")
    let origins = MemoryOriginStore(value: oldOrigin.displayValue)
    let tokens = MemoryTokenStore(values: [oldOrigin.displayValue: "old-token"])
    let oldAPI = StubNativeAPIClient(origin: oldOrigin)
    oldAPI.sessionResult = .failure(NativeAPIError.httpStatus(503, "offline"))

    let newAPI = StubNativeAPIClient(origin: newOrigin)
    let verificationURL = try #require(
      URL(string: "https://new-fleet.example.test/native/link/link-code")
    )
    newAPI.deviceResult = .success(
      .init(
        deviceCode: "device-code",
        verificationURL: verificationURL,
        expiresAt: Date().addingTimeInterval(300),
        intervalSeconds: 5
      ))
    newAPI.exchangeResults = [
      .success(
        .approved(
          .init(
            value: "new-token",
            expiresAt: Date().addingTimeInterval(3_600),
            user: testSession().user
          )))
    ]
    newAPI.sessionResult = .success(testSession())
    newAPI.fleetResult = .success(testFleet())

    let store = FleetStore(
      environment: [:],
      originStore: origins,
      tokenStore: tokens,
      clientFactory: { origin in origin == oldOrigin ? oldAPI : newAPI },
      openURL: { _ in true },
      sleep: { _ in }
    )

    await store.restore()
    #expect(store.connectionPhase == .failed)
    store.connect(to: newOrigin.displayValue)
    try await waitUntil { store.connectionPhase == .connected }

    try await waitUntil { oldAPI.revokedTokens == ["old-token"] }
    try await waitUntil { oldAPI.closeCount == 1 }
    #expect(oldAPI.revokeWasCancelled == [false])
    #expect(oldAPI.lifecycleEvents == ["revoke-start", "revoke-finish", "close"])
    #expect(tokens.values[oldOrigin.displayValue] == nil)
    #expect(tokens.values[newOrigin.displayValue] == "new-token")
  }

  @Test
  func relinkAfterKeychainLoadFailureDeletesOldItemBeforeSavingNewOrigin() async throws {
    let oldOrigin = try DeploymentOrigin("https://old-fleet.example.test")
    let newOrigin = try DeploymentOrigin("https://new-fleet.example.test")
    let origins = MemoryOriginStore(value: oldOrigin.displayValue)
    let tokens = MemoryTokenStore(values: [oldOrigin.displayValue: "old-token"])
    tokens.loadError = TestTokenStoreError.unavailable
    let oldAPI = StubNativeAPIClient(origin: oldOrigin)
    let newAPI = StubNativeAPIClient(origin: newOrigin)
    let verificationURL = try #require(
      URL(string: "https://new-fleet.example.test/native/link/link-code")
    )
    newAPI.deviceResult = .success(
      .init(
        deviceCode: "device-code",
        verificationURL: verificationURL,
        expiresAt: Date().addingTimeInterval(300),
        intervalSeconds: 5
      ))
    newAPI.exchangeResults = [
      .success(
        .approved(
          .init(
            value: "new-token",
            expiresAt: Date().addingTimeInterval(3_600),
            user: testSession().user
          )))
    ]
    newAPI.sessionResult = .success(testSession())
    newAPI.fleetResult = .success(testFleet())
    var persistenceEvents = [String]()
    tokens.onDelete = { origin in
      persistenceEvents.append("delete:\(origin.displayValue)")
    }
    origins.onSave = { value in
      persistenceEvents.append("save:\(value)")
      #expect(tokens.values[oldOrigin.displayValue] == nil)
    }
    let store = FleetStore(
      environment: [:],
      originStore: origins,
      tokenStore: tokens,
      clientFactory: { origin in origin == oldOrigin ? oldAPI : newAPI },
      openURL: { _ in true },
      sleep: { _ in }
    )

    await store.restore()
    #expect(store.connectionPhase == .failed)
    #expect(store.connectedOrigin == oldOrigin)
    #expect(tokens.values[oldOrigin.displayValue] == "old-token")
    tokens.loadError = nil

    store.connect(to: newOrigin.displayValue)
    try await waitUntil { store.connectionPhase == .connected }

    #expect(
      persistenceEvents == [
        "delete:\(oldOrigin.displayValue)",
        "save:\(newOrigin.displayValue)",
      ])
    #expect(tokens.values[oldOrigin.displayValue] == nil)
    #expect(tokens.values[newOrigin.displayValue] == "new-token")
    #expect(origins.value == newOrigin.displayValue)
  }

  @Test
  func relinkStopsBeforeChangingStateWhenOldKeychainDeleteFails() async throws {
    let oldOrigin = try DeploymentOrigin("https://old-fleet.example.test")
    let newOrigin = try DeploymentOrigin("https://new-fleet.example.test")
    let origins = MemoryOriginStore(value: oldOrigin.displayValue)
    let tokens = MemoryTokenStore(values: [oldOrigin.displayValue: "old-token"])
    let oldAPI = StubNativeAPIClient(origin: oldOrigin)
    oldAPI.sessionResult = .success(testSession())
    oldAPI.fleetResult = .success(testFleet(id: "IS-old"))
    let newAPI = StubNativeAPIClient(origin: newOrigin)
    let store = FleetStore(
      environment: [:],
      originStore: origins,
      tokenStore: tokens,
      clientFactory: { origin in origin == oldOrigin ? oldAPI : newAPI },
      openURL: { _ in true },
      sleep: { _ in }
    )
    await store.restore()
    tokens.deleteError = TestTokenStoreError.unavailable

    store.connect(to: newOrigin.displayValue)

    #expect(store.connectionPhase == .connected)
    #expect(store.isConnected)
    #expect(store.connectedOrigin == oldOrigin)
    #expect(store.leases.map(\.id) == ["IS-old"])
    #expect(origins.value == oldOrigin.displayValue)
    #expect(tokens.values[oldOrigin.displayValue] == "old-token")
    #expect(newAPI.deviceAuthorizationRequests == 0)
    #expect(oldAPI.revokedTokens.isEmpty)
    #expect(oldAPI.closeCount == 0)
    #expect(store.connectionError?.contains("Keychain cleanup failed") == true)
  }

  @Test
  func disconnectKeepsConnectionWhenKeychainDeleteFailsThenClearsBeforeRevoke() async throws {
    let origin = try DeploymentOrigin("https://fleet.example.test")
    let origins = MemoryOriginStore(value: origin.displayValue)
    let tokens = MemoryTokenStore(values: [origin.displayValue: "saved-token"])
    let api = StubNativeAPIClient(origin: origin)
    api.sessionResult = .success(testSession())
    api.fleetResult = .success(testFleet())
    let store = FleetStore(
      environment: [:],
      originStore: origins,
      tokenStore: tokens,
      clientFactory: { _ in api },
      openURL: { _ in false }
    )
    await store.restore()
    tokens.deleteError = TestTokenStoreError.unavailable

    store.disconnect()

    #expect(store.connectionPhase == .connected)
    #expect(store.isConnected)
    #expect(tokens.values[origin.displayValue] == "saved-token")
    #expect(api.revokedTokens.isEmpty)
    #expect(api.closeCount == 0)
    #expect(store.connectionError?.contains("Keychain cleanup failed") == true)

    tokens.deleteError = nil
    var revokeStarted = false
    var revokeContinuation: CheckedContinuation<Void, Error>?
    api.revokeHandler = { _ in
      revokeStarted = true
      return try await withCheckedThrowingContinuation { continuation in
        revokeContinuation = continuation
      }
    }
    store.disconnect()

    #expect(store.connectionPhase == .disconnected)
    #expect(!store.isConnected)
    #expect(tokens.values[origin.displayValue] == nil)
    #expect(store.leases.isEmpty)
    try await waitUntil { revokeStarted }
    #expect(store.connectionPhase == .disconnected)
    #expect(tokens.values[origin.displayValue] == nil)
    let continuation = try #require(revokeContinuation)
    continuation.resume(returning: ())
    try await waitUntil { api.closeCount == 1 }
    #expect(api.revokeWasCancelled == [false])
    #expect(api.lifecycleEvents == ["revoke-start", "revoke-finish", "close"])
  }

  @Test
  func staleUnauthorizedRefreshCannotExpireANewDeployment() async throws {
    try await verifyStaleRefreshIsIgnored(.failure(NativeAPIError.unauthorized))
  }

  @Test
  func staleSuccessfulRefreshCannotReplaceANewDeploymentFleet() async throws {
    try await verifyStaleRefreshIsIgnored(.success(testFleet(id: "IS-old")))
  }

  private func verifyStaleRefreshIsIgnored(
    _ staleResult: Result<NativeAPIFleet, Error>
  ) async throws {
    let oldOrigin = try DeploymentOrigin("https://old-fleet.example.test")
    let newOrigin = try DeploymentOrigin("https://new-fleet.example.test")
    let origins = MemoryOriginStore(value: oldOrigin.displayValue)
    let tokens = MemoryTokenStore(values: [oldOrigin.displayValue: "old-token"])
    let oldAPI = StubNativeAPIClient(origin: oldOrigin)
    oldAPI.sessionResult = .success(testSession())
    var oldRefreshStarted = false
    var oldRefreshContinuation: CheckedContinuation<NativeAPIFleet, Error>?
    oldAPI.fleetHandler = {
      oldRefreshStarted = true
      return try await withCheckedThrowingContinuation { continuation in
        oldRefreshContinuation = continuation
      }
    }

    let newAPI = StubNativeAPIClient(origin: newOrigin)
    let verificationURL = try #require(
      URL(string: "https://new-fleet.example.test/native/link/link-code")
    )
    newAPI.deviceResult = .success(
      .init(
        deviceCode: "new-device-code",
        verificationURL: verificationURL,
        expiresAt: Date().addingTimeInterval(300),
        intervalSeconds: 5
      ))
    newAPI.exchangeResults = [
      .success(
        .approved(
          .init(
            value: "new-token",
            expiresAt: Date().addingTimeInterval(3_600),
            user: testSession().user
          )))
    ]
    newAPI.sessionResult = .success(testSession())
    newAPI.fleetResult = .success(testFleet(id: "IS-new"))

    let store = FleetStore(
      environment: [:],
      originStore: origins,
      tokenStore: tokens,
      clientFactory: { origin in origin == oldOrigin ? oldAPI : newAPI },
      openURL: { _ in true },
      sleep: { _ in }
    )

    let restoreTask = Task { await store.restore() }
    try await waitUntil { oldRefreshStarted }

    store.connect(to: newOrigin.displayValue)
    try await waitUntil {
      store.connectionPhase == .connected && store.leases.map(\.id) == ["IS-new"]
    }

    let continuation = try #require(oldRefreshContinuation)
    switch staleResult {
    case .success(let fleet): continuation.resume(returning: fleet)
    case .failure(let error): continuation.resume(throwing: error)
    }
    await restoreTask.value

    #expect(store.connectionPhase == .connected)
    #expect(store.connectedOrigin == newOrigin)
    #expect(store.leases.map(\.id) == ["IS-new"])
    #expect(tokens.values[newOrigin.displayValue] == "new-token")
  }

  private func waitUntil(
    timeout: Duration = .seconds(1),
    condition: @escaping @MainActor () -> Bool
  ) async throws {
    let clock = ContinuousClock()
    let deadline = clock.now.advanced(by: timeout)
    while clock.now < deadline {
      if condition() { return }
      try await Task.sleep(for: .milliseconds(10))
    }
    #expect(condition())
  }
}

private final class RecordingHTTPTransport: HTTPDataTransport {
  let handler: (URLRequest) throws -> (Data, HTTPURLResponse)
  private(set) var closeCount = 0

  init(handler: @escaping (URLRequest) throws -> (Data, HTTPURLResponse)) {
    self.handler = handler
  }

  func data(for request: URLRequest) async throws -> (Data, HTTPURLResponse) {
    try handler(request)
  }

  func close() {
    closeCount += 1
  }
}

@MainActor
private final class StubNativeAPIClient: NativeAPIClientProtocol {
  let origin: DeploymentOrigin
  var deviceResult: Result<NativeDeviceAuthorization, Error> = .failure(NativeAPIError.invalidResponse)
  var exchangeResults: [Result<NativeTokenExchange, Error>] = []
  var sessionResult: Result<NativeAPISession, Error> = .failure(NativeAPIError.invalidResponse)
  var sessionResults: [Result<NativeAPISession, Error>] = []
  var sessionHandler: ((String) async throws -> NativeAPISession)?
  var fleetResult: Result<NativeAPIFleet, Error> = .failure(NativeAPIError.invalidResponse)
  var fleetHandler: (() async throws -> NativeAPIFleet)?
  var sessionTokens: [String] = []
  var fleetTokens: [String] = []
  var revokedTokens: [String] = []
  var revokeWasCancelled: [Bool] = []
  var revokeHandler: ((String) async throws -> Void)?
  var deviceAuthorizationRequests = 0
  var exchangeDeviceCodes: [String] = []
  private(set) var closeCount = 0
  private(set) var lifecycleEvents: [String] = []

  init(origin: DeploymentOrigin) {
    self.origin = origin
  }

  func createDeviceAuthorization(clientName: String) async throws -> NativeDeviceAuthorization {
    deviceAuthorizationRequests += 1
    return try deviceResult.get()
  }

  func exchangeDeviceCode(_ deviceCode: String) async throws -> NativeTokenExchange {
    exchangeDeviceCodes.append(deviceCode)
    guard !exchangeResults.isEmpty else { throw NativeAPIError.invalidResponse }
    return try exchangeResults.removeFirst().get()
  }

  func session(accessToken: String) async throws -> NativeAPISession {
    sessionTokens.append(accessToken)
    if let sessionHandler { return try await sessionHandler(accessToken) }
    if !sessionResults.isEmpty { return try sessionResults.removeFirst().get() }
    return try sessionResult.get()
  }

  func fleet(accessToken: String) async throws -> NativeAPIFleet {
    fleetTokens.append(accessToken)
    if let fleetHandler { return try await fleetHandler() }
    return try fleetResult.get()
  }

  func revoke(accessToken: String) async throws {
    revokedTokens.append(accessToken)
    revokeWasCancelled.append(Task.isCancelled)
    lifecycleEvents.append("revoke-start")
    defer { lifecycleEvents.append("revoke-finish") }
    try await revokeHandler?(accessToken)
  }

  func close() {
    guard closeCount == 0 else { return }
    closeCount = 1
    lifecycleEvents.append("close")
  }
}

private final class MemoryOriginStore: DeploymentOriginStoring {
  var value: String?
  var onSave: ((String) -> Void)?

  init(value: String? = nil) {
    self.value = value
  }

  func load() -> String? { value }
  func save(_ value: String) {
    onSave?(value)
    self.value = value
  }
}

private final class MemoryTokenStore: APIAccessTokenStoring {
  var values: [String: String]
  var loadError: Error?
  var saveError: Error?
  var deleteError: Error?
  var onDelete: ((DeploymentOrigin) -> Void)?

  init(values: [String: String] = [:]) {
    self.values = values
  }

  func load(for origin: DeploymentOrigin) throws -> String? {
    if let loadError { throw loadError }
    return values[origin.displayValue]
  }

  func save(_ token: String, for origin: DeploymentOrigin) throws {
    if let saveError { throw saveError }
    values[origin.displayValue] = token
  }

  func delete(for origin: DeploymentOrigin) throws {
    if let deleteError { throw deleteError }
    values[origin.displayValue] = nil
    onDelete?(origin)
  }
}

private enum TestTokenStoreError: LocalizedError {
  case unavailable

  var errorDescription: String? { "test Keychain unavailable" }
}

private func httpResponse(url: URL, status: Int) -> HTTPURLResponse {
  HTTPURLResponse(
    url: url,
    statusCode: status,
    httpVersion: "HTTP/1.1",
    headerFields: ["Content-Type": "application/json"]
  )!
}

private func waitForSemaphore(
  _ semaphore: DispatchSemaphore,
  timeout: DispatchTimeInterval
) async -> DispatchTimeoutResult {
  await withCheckedContinuation { continuation in
    DispatchQueue.global().async {
      continuation.resume(returning: semaphore.wait(timeout: .now() + timeout))
    }
  }
}

private func testSession() -> NativeAPISession {
  .init(
    user: .init(
      subject: "github:1",
      login: "operator",
      email: nil,
      name: "Operator",
      role: "maintainer"
    ),
    deployment: .init(
      label: "Test Fleet",
      canonicalUrl: "https://fleet.example.test",
      productUrl: nil,
      sshHost: nil
    )
  )
}

private func testLease(id: String = "IS-live") -> CrabboxLease {
  .init(
    id: id,
    leaseID: "live-crab",
    owner: "operator",
    repository: "openclaw/crabfleet",
    branch: "main",
    runtime: "crabbox",
    status: .ready,
    purpose: "Live test",
    summary: "Real deployment data",
    lastEvent: "ready",
    updatedAt: .now,
    desktopAvailable: true,
    terminalAvailable: true
  )
}

private func testFleet(id: String = "IS-live") -> NativeAPIFleet {
  .init(leases: [testLease(id: id)], desktopHosts: [])
}
