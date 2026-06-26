import AppKit
import CryptoKit
import Darwin
import Foundation
import Security

struct OAuthGatewayAccessToken: Equatable, Sendable {
  let value: String
  let expiresAt: Date
  let clientID: String
  let tokenEndpoint: URL?
  let revocationEndpoint: URL?
  let refreshToken: String?
  let scope: String
  let resources: [URL]
  let expectedAudiences: [String]

  init(
    value: String,
    expiresAt: Date,
    clientID: String = "",
    tokenEndpoint: URL? = nil,
    revocationEndpoint: URL? = nil,
    refreshToken: String? = nil,
    scope: String = "",
    resource: URL? = nil,
    resources: [URL]? = nil,
    expectedAudiences: [String] = []
  ) {
    self.value = value
    self.expiresAt = expiresAt
    self.clientID = clientID
    self.tokenEndpoint = tokenEndpoint
    self.revocationEndpoint = revocationEndpoint
    self.refreshToken = refreshToken
    self.scope = scope
    self.resources = resources ?? resource.map { [$0] } ?? []
    self.expectedAudiences = expectedAudiences
  }
}

protocol OAuthGatewayAuthorizing: AnyObject {
  func authorize(
    origin: DeploymentOrigin,
    transport: HTTPDataTransport
  ) async throws -> OAuthGatewayAccessToken
  func refresh(
    token: OAuthGatewayAccessToken,
    transport: HTTPDataTransport
  ) async throws -> OAuthGatewayAccessToken
  func revoke(
    token: String,
    tokenTypeHint: String,
    clientID: String,
    endpoint: URL,
    transport: HTTPDataTransport
  ) async throws
}

protocol OAuthEndpointTrustConfirming: AnyObject {
  func confirm(endpoint: URL, deployment: DeploymentOrigin) async -> Bool
}

final class OAuthEndpointTrustConfirmer: OAuthEndpointTrustConfirming, @unchecked Sendable {
  private let lock = NSLock()
  private var approvedOrigins: Set<String> = []

  func confirm(endpoint: URL, deployment: DeploymentOrigin) async -> Bool {
    if deployment.contains(endpoint) { return true }
    guard let origin = Self.originString(endpoint) else { return false }

    let alreadyApproved = lock.withLock { approvedOrigins.contains(origin) }
    if alreadyApproved { return true }

    let approved = await MainActor.run {
      let alert = NSAlert()
      alert.alertStyle = .warning
      alert.messageText = "Trust OAuth provider?"
      alert.informativeText =
        "This deployment wants Crabfleet to contact \(origin) for sign-in. Continue only if you trust this provider."
      alert.addButton(withTitle: "Continue")
      alert.addButton(withTitle: "Cancel")
      return alert.runModal() == .alertFirstButtonReturn
    }
    if approved {
      _ = lock.withLock { approvedOrigins.insert(origin) }
    }
    return approved
  }

  private static func originString(_ url: URL) -> String? {
    guard var components = URLComponents(url: url, resolvingAgainstBaseURL: false),
      let scheme = components.scheme?.lowercased(),
      let host = components.host?.lowercased(),
      !host.isEmpty
    else { return nil }
    components.scheme = scheme
    components.host = host
    components.user = nil
    components.password = nil
    components.path = ""
    components.query = nil
    components.fragment = nil
    return components.url?.absoluteString
  }
}

final class OAuthGatewayAuthorizer: OAuthGatewayAuthorizing {
  private let decoder = JSONDecoder()
  private let encoder = JSONEncoder()
  private let endpointTrust: OAuthEndpointTrustConfirming

  init(endpointTrust: OAuthEndpointTrustConfirming = OAuthEndpointTrustConfirmer()) {
    self.endpointTrust = endpointTrust
  }

  func authorize(
    origin: DeploymentOrigin,
    transport: HTTPDataTransport
  ) async throws -> OAuthGatewayAccessToken {
    var discoveries: [OAuthDiscoveryResult] = []
    for path in [
      "/mcp/crabfleet/native/v1/session",
      "/mcp/crabfleet/native/v1/fleet",
    ] {
      let challenge = try await discoverResourceChallenge(
        origin: origin,
        path: path,
        transport: transport
      )
      let discoveryData = try await dataRequest(
        URLRequest(url: challenge.metadataURL),
        transport: transport
      )
      discoveries.append(
        try await resolveAuthorizationServerMetadata(
          data: discoveryData,
          challenge: challenge,
          origin: origin,
          transport: transport
        ))
    }
    guard let discovery = discoveries.first,
      discoveries.allSatisfy({
        $0.metadata == discovery.metadata && $0.expectedIssuer == discovery.expectedIssuer
      })
    else {
      throw OAuthGatewayError.invalidMetadata
    }
    var requiredScopes: [String] = []
    for scope in discoveries.flatMap(\.requiredScopes) where !requiredScopes.contains(scope) {
      requiredScopes.append(scope)
    }
    let protectedResources = discoveries.compactMap(\.protectedResource)
    guard !requiredScopes.isEmpty,
      requiredScopes.count <= 8,
      requiredScopes.joined(separator: " ").utf8.count <= 1_024,
      protectedResources.isEmpty || protectedResources.count == discoveries.count
    else {
      throw OAuthGatewayError.invalidMetadata
    }
    let endpoints = try ValidatedOAuthEndpoints(
      discovery.metadata,
      requiredScopes: requiredScopes,
      expectedResourceOrigin: origin,
      expectedIssuer: discovery.expectedIssuer,
      protectedResources: protectedResources
    )
    try await requireTrusted(
      [
        endpoints.issuer,
        endpoints.authorization,
        endpoints.token,
        endpoints.registration,
        endpoints.revocation,
      ].compactMap { $0 },
      deployment: origin
    )
    var callbackServer = try LoopbackOAuthServer()
    let requestedRedirectURL = callbackServer.redirectURL(path: "/callback")
    let registration = try await registerClient(
      endpoints: endpoints,
      redirectURL: requestedRedirectURL,
      transport: transport
    )
    let redirectURL = try registration.validatedLoopbackRedirectURL()
    if redirectURL != requestedRedirectURL {
      if redirectURL.port != callbackServer.port {
        callbackServer = try LoopbackOAuthServer(port: redirectURL.port)
      }
      guard callbackServer.redirectURL(path: redirectURL.path) == redirectURL else {
        throw OAuthGatewayError.invalidMetadata
      }
    }
    let (verifier, verifierChallenge) = try pkcePair()
    let state = try randomBase64URL(byteCount: 24)
    let authorizationURL = try makeAuthorizationURL(
      endpoints: endpoints,
      clientID: registration.clientId,
      redirectURL: redirectURL,
      verifierChallenge: verifierChallenge,
      state: state
    )
    let callbackURL = try await LoopbackOAuthCallback.wait(
      server: callbackServer,
      redirectURL: redirectURL,
      authorizationURL: authorizationURL,
      expectedState: state
    )
    let callback = try OAuthCallback(url: callbackURL, expectedState: state)
    return try await exchange(
      callback: callback,
      endpoints: endpoints,
      clientID: registration.clientId,
      redirectURL: redirectURL,
      verifier: verifier,
      transport: transport
    )
  }

  func revoke(
    token: String,
    tokenTypeHint: String,
    clientID: String,
    endpoint: URL,
    transport: HTTPDataTransport
  ) async throws {
    guard !token.isEmpty, !clientID.isEmpty,
      tokenTypeHint == "access_token" || tokenTypeHint == "refresh_token"
    else { return }
    let body = formEncodedData([
      URLQueryItem(name: "token", value: token),
      URLQueryItem(name: "token_type_hint", value: tokenTypeHint),
      URLQueryItem(name: "client_id", value: clientID),
    ])
    var request = URLRequest(url: endpoint)
    request.httpMethod = "POST"
    request.timeoutInterval = 20
    request.setValue(
      "application/x-www-form-urlencoded",
      forHTTPHeaderField: "Content-Type"
    )
    request.httpBody = body
    let (_, response) = try await transport.data(for: request)
    guard (200..<300).contains(response.statusCode) else {
      throw OAuthGatewayError.httpStatus(response.statusCode)
    }
  }

  func refresh(
    token: OAuthGatewayAccessToken,
    transport: HTTPDataTransport
  ) async throws -> OAuthGatewayAccessToken {
    guard let endpoint = token.tokenEndpoint,
      let refreshToken = token.refreshToken,
      !refreshToken.isEmpty,
      refreshToken.utf8.count <= 16 * 1_024,
      !token.clientID.isEmpty
    else {
      throw OAuthGatewayError.invalidMetadata
    }
    var queryItems = [
      URLQueryItem(name: "grant_type", value: "refresh_token"),
      URLQueryItem(name: "client_id", value: token.clientID),
      URLQueryItem(name: "refresh_token", value: refreshToken),
    ]
    for resource in token.resources {
      queryItems.append(
        URLQueryItem(name: "resource", value: resource.absoluteString)
      )
    }
    let body = formEncodedData(queryItems)
    var request = URLRequest(url: endpoint)
    request.httpMethod = "POST"
    request.timeoutInterval = 20
    request.setValue("application/json", forHTTPHeaderField: "Accept")
    request.setValue(
      "application/x-www-form-urlencoded",
      forHTTPHeaderField: "Content-Type"
    )
    request.httpBody = body
    let response = try await tokenRequest(request, transport: transport)
    return try validatedToken(
      response,
      clientID: token.clientID,
      tokenEndpoint: endpoint,
      revocationEndpoint: token.revocationEndpoint,
      previousRefreshToken: refreshToken,
      scope: token.scope,
      resources: token.resources,
      expectedAudiences: Set(token.expectedAudiences)
    )
  }

  private func registerClient(
    endpoints: ValidatedOAuthEndpoints,
    redirectURL: URL,
    transport: HTTPDataTransport
  ) async throws -> OAuthClientRegistration {
    var request = URLRequest(url: endpoints.registration)
    request.httpMethod = "POST"
    request.timeoutInterval = 20
    request.setValue("application/json", forHTTPHeaderField: "Accept")
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.httpBody = try encoder.encode(
      OAuthRegistrationRequest(
        clientName: "Crabfleet for macOS",
        redirectUris: [redirectURL.absoluteString],
        grantTypes: endpoints.supportsRefreshTokens
          ? ["authorization_code", "refresh_token"]
          : ["authorization_code"],
        responseTypes: ["code"],
        tokenEndpointAuthMethod: "none"
      ))
    return try await jsonRequest(request, transport: transport)
  }

  private func discoverResourceChallenge(
    origin: DeploymentOrigin,
    path: String,
    transport: HTTPDataTransport
  ) async throws -> OAuthResourceChallenge {
    let resourceURL = try origin.endpoint(path)
    var request = URLRequest(url: resourceURL)
    request.httpMethod = "GET"
    request.timeoutInterval = 20
    request.setValue("application/json", forHTTPHeaderField: "Accept")
    let (_, response) = try await transport.data(for: request)
    guard response.statusCode == 401,
      let challenge = response.value(forHTTPHeaderField: "WWW-Authenticate"),
      let metadataValue = quotedAttribute("resource_metadata", in: challenge),
      let metadataURL = URL(string: metadataValue),
      origin.contains(metadataURL),
      metadataURL.user == nil,
      metadataURL.password == nil,
      metadataURL.query == nil,
      metadataURL.fragment == nil
    else {
      throw OAuthGatewayError.invalidMetadata
    }
    let scopeValue = quotedAttribute("scope", in: challenge) ?? ""
    let scopes = scopeValue.split(separator: " ").map(String.init)
    let resourceScopes = scopes.filter { !$0.isEmpty && $0 != "offline_access" }
    guard !resourceScopes.isEmpty,
      resourceScopes.count <= 8,
      resourceScopes.allSatisfy(validScopeToken),
      resourceScopes.joined(separator: " ").utf8.count <= 1_024
    else {
      throw OAuthGatewayError.invalidMetadata
    }
    return .init(metadataURL: metadataURL, resourceURL: resourceURL, scopes: resourceScopes)
  }

  private func quotedAttribute(_ name: String, in challenge: String) -> String? {
    guard let marker = challenge.range(of: "\(name)=\"", options: .caseInsensitive),
      let end = challenge[marker.upperBound...].firstIndex(of: "\"")
    else {
      return nil
    }
    return String(challenge[marker.upperBound..<end])
  }

  private func validScopeToken(_ value: String) -> Bool {
    !value.isEmpty && value.utf8.count <= 512 && value.utf8.allSatisfy { byte in
      byte == 0x21 || (0x23...0x5B).contains(byte) || (0x5D...0x7E).contains(byte)
    }
  }

  private func makeAuthorizationURL(
    endpoints: ValidatedOAuthEndpoints,
    clientID: String,
    redirectURL: URL,
    verifierChallenge: String,
    state: String
  ) throws -> URL {
    guard !clientID.isEmpty, clientID.utf8.count <= 512 else {
      throw OAuthGatewayError.invalidMetadata
    }
    guard var components = URLComponents(
      url: endpoints.authorization,
      resolvingAgainstBaseURL: false
    ) else {
      throw OAuthGatewayError.invalidMetadata
    }
    var requestQueryItems = [
      URLQueryItem(name: "client_id", value: clientID),
      URLQueryItem(name: "response_type", value: "code"),
      URLQueryItem(name: "redirect_uri", value: redirectURL.absoluteString),
      URLQueryItem(name: "code_challenge", value: verifierChallenge),
      URLQueryItem(name: "code_challenge_method", value: "S256"),
      URLQueryItem(name: "state", value: state),
    ]
    if !endpoints.scope.isEmpty {
      requestQueryItems.append(URLQueryItem(name: "scope", value: endpoints.scope))
    }
    for resource in endpoints.resources {
      requestQueryItems.append(URLQueryItem(name: "resource", value: resource.absoluteString))
    }
    let requestQuery = formEncodedQuery(requestQueryItems)
    components.percentEncodedQuery = [components.percentEncodedQuery, requestQuery]
      .compactMap { $0?.isEmpty == false ? $0 : nil }
      .joined(separator: "&")
    guard let url = components.url else { throw OAuthGatewayError.invalidMetadata }
    return url
  }

  private func exchange(
    callback: OAuthCallback,
    endpoints: ValidatedOAuthEndpoints,
    clientID: String,
    redirectURL: URL,
    verifier: String,
    transport: HTTPDataTransport
  ) async throws -> OAuthGatewayAccessToken {
    var queryItems = [
      URLQueryItem(name: "grant_type", value: "authorization_code"),
      URLQueryItem(name: "client_id", value: clientID),
      URLQueryItem(name: "code", value: callback.code),
      URLQueryItem(name: "redirect_uri", value: redirectURL.absoluteString),
      URLQueryItem(name: "code_verifier", value: verifier),
    ]
    for resource in endpoints.resources {
      queryItems.append(
        URLQueryItem(name: "resource", value: resource.absoluteString)
      )
    }
    let body = formEncodedData(queryItems)
    var request = URLRequest(url: endpoints.token)
    request.httpMethod = "POST"
    request.timeoutInterval = 20
    request.setValue("application/json", forHTTPHeaderField: "Accept")
    request.setValue(
      "application/x-www-form-urlencoded",
      forHTTPHeaderField: "Content-Type"
    )
    request.httpBody = body
    let response = try await tokenRequest(request, transport: transport)
    return try validatedToken(
      response,
      clientID: clientID,
      tokenEndpoint: endpoints.token,
      revocationEndpoint: endpoints.revocation,
      previousRefreshToken: nil,
      scope: endpoints.scope,
      resources: endpoints.resources,
      expectedAudiences: endpoints.expectedAudiences
    )
  }

  private func validatedToken(
    _ response: OAuthTokenResponse,
    clientID: String,
    tokenEndpoint: URL,
    revocationEndpoint: URL?,
    previousRefreshToken: String?,
    scope: String,
    resources: [URL],
    expectedAudiences: Set<String>
  ) throws -> OAuthGatewayAccessToken {
    let requestedScopes = Set(scope.split(separator: " ").map(String.init))
    let requiredScopes = requestedScopes
      .subtracting(["offline_access"])
    let returnedScopes = response.scope.map {
      Set($0.split(separator: " ").map(String.init))
    }
    let refreshToken = response.refreshToken ?? previousRefreshToken
    let expiresIn = response.expiresIn ?? 3_600
    guard response.tokenType.caseInsensitiveCompare("Bearer") == .orderedSame,
      !response.accessToken.isEmpty,
      response.accessToken.utf8.count <= 16 * 1_024,
      expiresIn > 0,
      expiresIn <= 86_400,
      refreshToken.map({ !$0.isEmpty && $0.utf8.count <= 16 * 1_024 }) != false,
      returnedScopes.map({ returned in
        requiredScopes.isSubset(of: returned) && returned.isSubset(of: requestedScopes)
      }) != false,
      expectedAudiences.isEmpty
        || tokenAudiences(response.accessToken).map({ !$0.isDisjoint(with: expectedAudiences) }) == true
    else {
      throw OAuthGatewayError.invalidResponse
    }
    return .init(
      value: response.accessToken,
      expiresAt: Date().addingTimeInterval(expiresIn),
      clientID: clientID,
      tokenEndpoint: tokenEndpoint,
      revocationEndpoint: revocationEndpoint,
      refreshToken: refreshToken,
      scope: scope,
      resources: resources,
      expectedAudiences: expectedAudiences.sorted()
    )
  }

  private func jsonRequest<Value: Decodable>(
    _ request: URLRequest,
    transport: HTTPDataTransport
  ) async throws -> Value {
    let data = try await dataRequest(request, transport: transport)
    do {
      return try decoder.decode(Value.self, from: data)
    } catch {
      throw OAuthGatewayError.invalidResponse
    }
  }

  private func tokenRequest(
    _ request: URLRequest,
    transport: HTTPDataTransport
  ) async throws -> OAuthTokenResponse {
    let (data, response) = try await transport.data(for: request)
    guard (200..<300).contains(response.statusCode) else {
      let error = try? decoder.decode(OAuthTokenErrorResponse.self, from: data).error
      throw OAuthGatewayError.tokenEndpoint(response.statusCode, error)
    }
    do {
      return try decoder.decode(OAuthTokenResponse.self, from: data)
    } catch {
      throw OAuthGatewayError.invalidResponse
    }
  }

  private func dataRequest(
    _ request: URLRequest,
    transport: HTTPDataTransport
  ) async throws -> Data {
    let (data, response) = try await transport.data(for: request)
    guard (200..<300).contains(response.statusCode) else {
      throw OAuthGatewayError.httpStatus(response.statusCode)
    }
    return data
  }

  private func formEncodedData(_ items: [URLQueryItem]) -> Data {
    Data(formEncodedQuery(items).utf8)
  }

  private func formEncodedQuery(_ items: [URLQueryItem]) -> String {
    items.map { item in
      "\(formEncodedComponent(item.name))=\(formEncodedComponent(item.value ?? ""))"
    }.joined(separator: "&")
  }

  private func formEncodedComponent(_ value: String) -> String {
    let hex = Array("0123456789ABCDEF".utf8)
    var result = ""
    for byte in value.utf8 {
      switch byte {
      case 0x30...0x39, 0x41...0x5A, 0x61...0x7A, 0x2A, 0x2D, 0x2E, 0x5F:
        result.unicodeScalars.append(UnicodeScalar(byte))
      case 0x20:
        result.append("+")
      default:
        result.append("%")
        result.unicodeScalars.append(UnicodeScalar(hex[Int(byte >> 4)]))
        result.unicodeScalars.append(UnicodeScalar(hex[Int(byte & 0x0F)]))
      }
    }
    return result
  }

  private func tokenAudiences(_ token: String) -> Set<String>? {
    let parts = token.split(separator: ".", omittingEmptySubsequences: false)
    guard parts.count == 3,
      let data = Data(base64URLEncoded: String(parts[1])),
      let payload = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    else { return nil }
    if let audience = payload["aud"] as? String, !audience.isEmpty {
      return [audience]
    }
    if let audiences = payload["aud"] as? [String],
      !audiences.isEmpty,
      audiences.allSatisfy({ !$0.isEmpty })
    {
      return Set(audiences)
    }
    return nil
  }

  private func resolveAuthorizationServerMetadata(
    data: Data,
    challenge: OAuthResourceChallenge,
    origin: DeploymentOrigin,
    transport: HTTPDataTransport
  ) async throws -> OAuthDiscoveryResult {
    if let protectedMetadata = try? decoder.decode(
      OAuthProtectedResourceMetadata.self,
      from: data
    ) {
      guard let protectedResource = URL(string: protectedMetadata.resource),
        validProtectedResource(
          protectedResource,
          endpoint: challenge.resourceURL,
          origin: origin
        ),
        protectedMetadata.authorizationServers.count == 1,
        let issuer = URL(string: protectedMetadata.authorizationServers[0]),
        issuer.scheme?.lowercased() == "https",
        issuer.user == nil,
        issuer.password == nil,
        issuer.query == nil,
        issuer.fragment == nil
      else {
        throw OAuthGatewayError.invalidMetadata
      }
      try await requireTrusted([issuer], deployment: origin)
      let metadataURL = try authorizationServerMetadataURL(issuer: issuer)
      let metadata: OAuthAuthorizationServerMetadata = try await jsonRequest(
        URLRequest(url: metadataURL),
        transport: transport
      )
      return .init(
        metadata: metadata,
        expectedIssuer: issuer,
        protectedResource: protectedResource,
        requiredScopes: challenge.scopes
      )
    }

    let metadata: OAuthAuthorizationServerMetadata
    do {
      metadata = try decoder.decode(OAuthAuthorizationServerMetadata.self, from: data)
    } catch {
      throw OAuthGatewayError.invalidResponse
    }
    guard let issuer = URL(string: metadata.issuer) else {
      throw OAuthGatewayError.invalidMetadata
    }
    guard metadata.resource == nil else {
      throw OAuthGatewayError.invalidMetadata
    }
    try await requireTrusted([issuer], deployment: origin)
    return .init(
      metadata: metadata,
      expectedIssuer: nil,
      protectedResource: nil,
      requiredScopes: challenge.scopes
    )
  }

  private func validProtectedResource(
    _ resource: URL,
    endpoint: URL,
    origin: DeploymentOrigin
  ) -> Bool {
    guard origin.contains(resource),
      resource.user == nil,
      resource.password == nil,
      resource.query == nil,
      resource.fragment == nil
    else { return false }
    return resource == endpoint
  }

  private func requireTrusted(
    _ endpoints: [URL],
    deployment: DeploymentOrigin
  ) async throws {
    var checkedOrigins: Set<String> = []
    for endpoint in endpoints {
      if deployment.contains(endpoint) { continue }
      let key = "\(endpoint.scheme?.lowercased() ?? "")://\(endpoint.host?.lowercased() ?? ""):\(endpoint.port ?? 443)"
      if !checkedOrigins.insert(key).inserted { continue }
      guard await endpointTrust.confirm(endpoint: endpoint, deployment: deployment) else {
        throw OAuthGatewayError.untrustedEndpoint
      }
    }
  }

  private func authorizationServerMetadataURL(issuer: URL) throws -> URL {
    guard var components = URLComponents(url: issuer, resolvingAgainstBaseURL: false) else {
      throw OAuthGatewayError.invalidMetadata
    }
    let issuerPath = components.percentEncodedPath
      .trimmingCharacters(in: CharacterSet(charactersIn: "/"))
    components.percentEncodedPath = "/.well-known/oauth-authorization-server"
      + (issuerPath.isEmpty ? "" : "/\(issuerPath)")
    guard let result = components.url else { throw OAuthGatewayError.invalidMetadata }
    return result
  }

  private func randomBase64URL(byteCount: Int) throws -> String {
    var bytes = [UInt8](repeating: 0, count: byteCount)
    guard SecRandomCopyBytes(kSecRandomDefault, byteCount, &bytes) == errSecSuccess else {
      throw OAuthGatewayError.randomnessUnavailable
    }
    return Data(bytes).base64URLEncodedString()
  }

  private func pkcePair() throws -> (verifier: String, challenge: String) {
    while true {
      let verifier = try randomBase64URL(byteCount: 32)
      let challenge = Data(SHA256.hash(data: Data(verifier.utf8))).base64URLEncodedString()
      guard let first = challenge.utf8.first else { continue }
      if (0x30...0x39).contains(first) || (0x41...0x5A).contains(first)
        || (0x61...0x7A).contains(first)
      {
        return (verifier, challenge)
      }
    }
  }
}

private struct OAuthAuthorizationServerMetadata: Decodable, Equatable {
  let issuer: String
  let resource: String?
  let authorizationEndpoint: String
  let tokenEndpoint: String
  let registrationEndpoint: String
  let revocationEndpoint: String?
  let scopesSupported: [String]?
  let codeChallengeMethodsSupported: [String]
  let grantTypesSupported: [String]?

  enum CodingKeys: String, CodingKey {
    case issuer
    case resource
    case authorizationEndpoint = "authorization_endpoint"
    case tokenEndpoint = "token_endpoint"
    case registrationEndpoint = "registration_endpoint"
    case revocationEndpoint = "revocation_endpoint"
    case scopesSupported = "scopes_supported"
    case codeChallengeMethodsSupported = "code_challenge_methods_supported"
    case grantTypesSupported = "grant_types_supported"
  }
}

private struct OAuthProtectedResourceMetadata: Decodable {
  let resource: String
  let authorizationServers: [String]

  enum CodingKeys: String, CodingKey {
    case resource
    case authorizationServers = "authorization_servers"
  }
}

private struct OAuthDiscoveryResult {
  let metadata: OAuthAuthorizationServerMetadata
  let expectedIssuer: URL?
  let protectedResource: URL?
  let requiredScopes: [String]
}

private struct OAuthResourceChallenge {
  let metadataURL: URL
  let resourceURL: URL
  let scopes: [String]
}

private struct ValidatedOAuthEndpoints {
  let issuer: URL
  let authorization: URL
  let token: URL
  let registration: URL
  let revocation: URL?
  let resources: [URL]
  let scope: String
  let supportsRefreshTokens: Bool
  let expectedAudiences: Set<String>

  init(
    _ metadata: OAuthAuthorizationServerMetadata,
    requiredScopes: [String],
    expectedResourceOrigin: DeploymentOrigin,
    expectedIssuer: URL?,
    protectedResources: [URL]
  ) throws {
    let parsedIssuer = try Self.issuerURL(metadata.issuer)
    let parsedAuthorization = try Self.httpsURL(metadata.authorizationEndpoint)
    let parsedToken = try Self.httpsURL(metadata.tokenEndpoint)
    let parsedRegistration = try Self.httpsURL(metadata.registrationEndpoint)
    let parsedRevocation = try metadata.revocationEndpoint.map(Self.httpsURL)
    let metadataResource = try metadata.resource.map(Self.httpsURL)
    let parsedResources = protectedResources.isEmpty
      ? metadataResource.map { [$0] } ?? []
      : protectedResources
    let parsedAudiences = parsedResources.isEmpty
      ? Self.scopeAudiences(requiredScopes)
      : []
    guard expectedIssuer.map({ $0 == parsedIssuer }) != false,
      !parsedResources.isEmpty || !parsedAudiences.isEmpty,
      parsedResources.allSatisfy(expectedResourceOrigin.contains),
      metadata.resource.map({ value in
        URL(string: value).map({ advertised in
          parsedResources.isEmpty || parsedResources.contains(advertised)
        }) ?? false
      }) != false,
      metadata.scopesSupported.map({ supported in
        requiredScopes.allSatisfy(supported.contains)
      }) != false,
      metadata.codeChallengeMethodsSupported.contains("S256")
    else {
      throw OAuthGatewayError.invalidMetadata
    }
    issuer = parsedIssuer
    authorization = parsedAuthorization
    token = parsedToken
    registration = parsedRegistration
    revocation = parsedRevocation
    resources = Array(Set(parsedResources)).sorted { $0.absoluteString < $1.absoluteString }
    var requestedScopes = requiredScopes
    if metadata.scopesSupported?.contains("offline_access") == true,
      !requestedScopes.contains("offline_access")
    {
      requestedScopes.append("offline_access")
    }
    guard requestedScopes.count <= 9,
      requestedScopes.joined(separator: " ").utf8.count <= 1_024
    else {
      throw OAuthGatewayError.invalidMetadata
    }
    scope = requestedScopes.joined(separator: " ")
    supportsRefreshTokens = metadata.grantTypesSupported?.contains("refresh_token") == true
    expectedAudiences = parsedAudiences
  }

  private static func issuerURL(_ value: String) throws -> URL {
    let url = try httpsURL(value)
    guard url.query == nil, url.fragment == nil else {
      throw OAuthGatewayError.invalidMetadata
    }
    return url
  }

  private static func httpsURL(_ value: String) throws -> URL {
    guard let url = URL(string: value), url.scheme?.lowercased() == "https",
      url.host?.isEmpty == false,
      url.user == nil,
      url.password == nil,
      url.fragment == nil
    else {
      throw OAuthGatewayError.invalidMetadata
    }
    return url
  }

  private static func scopeAudiences(_ scopes: [String]) -> Set<String> {
    var shared: Set<String>?
    for scope in scopes {
      guard var components = URLComponents(string: scope),
        components.scheme?.lowercased() == "api",
        let host = components.host,
        !host.isEmpty
      else { return [] }
      var pathParts = components.path.split(separator: "/").map(String.init)
      guard !pathParts.isEmpty else { return [] }
      pathParts.removeLast()
      components.path = pathParts.isEmpty ? "" : "/" + pathParts.joined(separator: "/")
      components.query = nil
      components.fragment = nil
      guard let resource = components.url?.absoluteString else { return [] }
      var candidates: Set<String> = [resource]
      if pathParts.isEmpty { candidates.insert(host) }
      shared = shared.map { $0.intersection(candidates) } ?? candidates
      if shared?.isEmpty == true { return [] }
    }
    return shared ?? []
  }

}

private struct OAuthRegistrationRequest: Encodable {
  let clientName: String
  let redirectUris: [String]
  let grantTypes: [String]
  let responseTypes: [String]
  let tokenEndpointAuthMethod: String

  enum CodingKeys: String, CodingKey {
    case clientName = "client_name"
    case redirectUris = "redirect_uris"
    case grantTypes = "grant_types"
    case responseTypes = "response_types"
    case tokenEndpointAuthMethod = "token_endpoint_auth_method"
  }
}

private struct OAuthClientRegistration: Decodable {
  let clientId: String
  let redirectUris: [String]

  enum CodingKeys: String, CodingKey {
    case clientId = "client_id"
    case redirectUris = "redirect_uris"
  }

  func validatedLoopbackRedirectURL() throws -> URL {
    guard redirectUris.count == 1,
      let url = URL(string: redirectUris[0]),
      url.scheme?.lowercased() == "http",
      url.host == "127.0.0.1",
      let port = url.port,
      (1_024...65_535).contains(port),
      !url.path.isEmpty,
      url.user == nil,
      url.password == nil,
      url.query == nil,
      url.fragment == nil
    else {
      throw OAuthGatewayError.invalidMetadata
    }
    return url
  }
}

private struct OAuthTokenResponse: Decodable {
  let accessToken: String
  let tokenType: String
  let expiresIn: TimeInterval?
  let refreshToken: String?
  let scope: String?

  enum CodingKeys: String, CodingKey {
    case accessToken = "access_token"
    case tokenType = "token_type"
    case expiresIn = "expires_in"
    case refreshToken = "refresh_token"
    case scope
  }
}

private struct OAuthTokenErrorResponse: Decodable {
  let error: String
}

private struct OAuthCallback {
  let code: String

  init(url: URL, expectedState: String) throws {
    guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false) else {
      throw OAuthGatewayError.invalidCallback
    }
    let values = Dictionary(grouping: components.queryItems ?? [], by: \.name)
    guard values["state"]?.count == 1,
      values["state"]?.first?.value == expectedState
    else {
      throw OAuthGatewayError.invalidCallback
    }
    if let error = values["error"]?.first?.value, !error.isEmpty {
      throw OAuthGatewayError.authorizationDenied(error)
    }
    guard values["code"]?.count == 1,
      let code = values["code"]?.first?.value,
      !code.isEmpty,
      code.utf8.count <= 4_096
    else {
      throw OAuthGatewayError.invalidCallback
    }
    self.code = code
  }
}

private final class LoopbackOAuthServer: @unchecked Sendable {
  let fileDescriptor: Int32
  let port: Int

  init(port requestedPort: Int? = nil) throws {
    if let requestedPort, !(1_024...65_535).contains(requestedPort) {
      throw OAuthGatewayError.invalidMetadata
    }
    let descriptor = socket(AF_INET, SOCK_STREAM, 0)
    guard descriptor >= 0 else { throw OAuthGatewayError.loopbackUnavailable }
    var shouldClose = true
    defer {
      if shouldClose { Darwin.close(descriptor) }
    }

    var one: Int32 = 1
    setsockopt(
      descriptor,
      SOL_SOCKET,
      SO_REUSEADDR,
      &one,
      socklen_t(MemoryLayout.size(ofValue: one))
    )
    setsockopt(
      descriptor,
      SOL_SOCKET,
      SO_NOSIGPIPE,
      &one,
      socklen_t(MemoryLayout.size(ofValue: one))
    )
    var address = sockaddr_in()
    address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
    address.sin_family = sa_family_t(AF_INET)
    address.sin_port = in_port_t(requestedPort ?? 0).bigEndian
    address.sin_addr = in_addr(s_addr: inet_addr("127.0.0.1"))
    let bindResult = withUnsafePointer(to: &address) { pointer in
      pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { socketAddress in
        Darwin.bind(descriptor, socketAddress, socklen_t(MemoryLayout<sockaddr_in>.size))
      }
    }
    guard bindResult == 0, Darwin.listen(descriptor, 4) == 0 else {
      throw OAuthGatewayError.loopbackUnavailable
    }

    var boundAddress = sockaddr_in()
    var boundLength = socklen_t(MemoryLayout<sockaddr_in>.size)
    let nameResult = withUnsafeMutablePointer(to: &boundAddress) { pointer in
      pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { socketAddress in
        getsockname(descriptor, socketAddress, &boundLength)
      }
    }
    let boundPort = Int(in_port_t(bigEndian: boundAddress.sin_port))
    guard nameResult == 0, (1_024...65_535).contains(boundPort) else {
      throw OAuthGatewayError.loopbackUnavailable
    }
    fileDescriptor = descriptor
    port = boundPort
    shouldClose = false
  }

  deinit {
    Darwin.close(fileDescriptor)
  }

  func redirectURL(path: String) -> URL {
    URL(string: "http://127.0.0.1:\(port)\(path)")!
  }
}

private enum LoopbackOAuthCallback {
  static func wait(
    server: LoopbackOAuthServer,
    redirectURL: URL,
    authorizationURL: URL,
    expectedState: String
  ) async throws -> URL {
    let task = Task.detached(priority: .userInitiated) {
      try await listen(
        server: server,
        redirectURL: redirectURL,
        authorizationURL: authorizationURL,
        expectedState: expectedState
      )
    }
    return try await withTaskCancellationHandler {
      try await task.value
    } onCancel: {
      task.cancel()
    }
  }

  private static func listen(
    server: LoopbackOAuthServer,
    redirectURL: URL,
    authorizationURL: URL,
    expectedState: String
  ) async throws -> URL {
    var one: Int32 = 1
    try Task.checkCancellation()
    let opened = await MainActor.run { NSWorkspace.shared.open(authorizationURL) }
    guard opened else { throw OAuthGatewayError.cannotOpenBrowser }

    let deadline = Date().addingTimeInterval(5 * 60)
    while !Task.isCancelled && Date() < deadline {
      var descriptor = pollfd(fd: server.fileDescriptor, events: Int16(POLLIN), revents: 0)
      let result = Darwin.poll(&descriptor, 1, 250)
      if result < 0 && errno != EINTR { throw OAuthGatewayError.loopbackUnavailable }
      if result <= 0 || descriptor.revents & Int16(POLLIN) == 0 { continue }
      let client = Darwin.accept(server.fileDescriptor, nil, nil)
      guard client >= 0 else { continue }
      defer { Darwin.close(client) }
      setsockopt(client, SOL_SOCKET, SO_NOSIGPIPE, &one, socklen_t(MemoryLayout.size(ofValue: one)))
      let callback = try readCallback(client: client, redirectURL: redirectURL)
      guard let callback else {
        writeBrowserResponse(client: client, succeeded: false)
        continue
      }
      do {
        _ = try OAuthCallback(url: callback, expectedState: expectedState)
        writeBrowserResponse(client: client, succeeded: true)
        return callback
      } catch OAuthGatewayError.authorizationDenied {
        writeBrowserResponse(client: client, succeeded: false)
        return callback
      } catch {
        writeBrowserResponse(client: client, succeeded: false)
      }
    }
    if Task.isCancelled { throw CancellationError() }
    throw OAuthGatewayError.callbackTimedOut
  }

  private static func readCallback(client: Int32, redirectURL: URL) throws -> URL? {
    var data = Data()
    var buffer = [UInt8](repeating: 0, count: 2_048)
    while data.count < 16 * 1_024 {
      var descriptor = pollfd(fd: client, events: Int16(POLLIN), revents: 0)
      let result = Darwin.poll(&descriptor, 1, 2_000)
      guard result > 0, descriptor.revents & Int16(POLLIN) != 0 else { return nil }
      let count = Darwin.recv(client, &buffer, buffer.count, 0)
      guard count > 0 else { return nil }
      data.append(contentsOf: buffer.prefix(count))
      if data.range(of: Data("\r\n\r\n".utf8)) != nil { break }
    }
    guard let request = String(data: data, encoding: .utf8),
      let firstLine = request.split(separator: "\r\n", maxSplits: 1).first,
      firstLine.hasPrefix("GET "),
      let target = firstLine.split(separator: " ").dropFirst().first,
      let callback = URL(string: "http://127.0.0.1:\(redirectURL.port!)\(target)"),
      callback.path == redirectURL.path
    else {
      return nil
    }
    return callback
  }

  private static func writeBrowserResponse(client: Int32, succeeded: Bool) {
    let message = succeeded
      ? "Crabfleet sign-in is complete. You can return to the app."
      : "Crabfleet could not complete sign-in. Return to the app and try again."
    let body = "<!doctype html><meta charset=\"utf-8\"><title>Crabfleet</title><p>\(message)</p>"
    let response =
      "HTTP/1.1 \(succeeded ? "200 OK" : "400 Bad Request")\r\n" +
      "Content-Type: text/html; charset=utf-8\r\n" +
      "Content-Length: \(body.utf8.count)\r\n" +
      "Connection: close\r\n\r\n" + body
    let data = Data(response.utf8)
    data.withUnsafeBytes { bytes in
      guard let base = bytes.baseAddress else { return }
      _ = Darwin.send(client, base, bytes.count, 0)
    }
  }
}

enum OAuthGatewayError: LocalizedError, Equatable {
  case invalidMetadata
  case invalidResponse
  case invalidCallback
  case httpStatus(Int)
  case tokenEndpoint(Int, String?)
  case authorizationDenied(String)
  case loopbackUnavailable
  case cannotOpenBrowser
  case callbackTimedOut
  case randomnessUnavailable
  case untrustedEndpoint

  var errorDescription: String? {
    switch self {
    case .invalidMetadata: "The deployment returned invalid OAuth metadata."
    case .invalidResponse: "The deployment returned an invalid OAuth response."
    case .invalidCallback: "The browser returned an invalid OAuth callback."
    case .httpStatus(let status): "OAuth sign-in returned HTTP \(status)."
    case .tokenEndpoint(let status, _): "The OAuth token endpoint returned HTTP \(status)."
    case .authorizationDenied(let reason): "OAuth sign-in was denied: \(reason)."
    case .loopbackUnavailable: "Crabfleet could not open its local OAuth callback port."
    case .cannotOpenBrowser: "The OAuth sign-in page could not be opened."
    case .callbackTimedOut: "OAuth sign-in timed out. Try connecting again."
    case .randomnessUnavailable: "Crabfleet could not generate secure OAuth state."
    case .untrustedEndpoint: "OAuth sign-in was cancelled before contacting an untrusted provider."
    }
  }
}

private extension Data {
  init?(base64URLEncoded value: String) {
    var base64 = value
      .replacingOccurrences(of: "-", with: "+")
      .replacingOccurrences(of: "_", with: "/")
    let remainder = base64.utf8.count % 4
    if remainder != 0 {
      base64.append(String(repeating: "=", count: 4 - remainder))
    }
    self.init(base64Encoded: base64)
  }

  func base64URLEncodedString() -> String {
    base64EncodedString()
      .replacingOccurrences(of: "+", with: "-")
      .replacingOccurrences(of: "/", with: "_")
      .replacingOccurrences(of: "=", with: "")
  }
}
