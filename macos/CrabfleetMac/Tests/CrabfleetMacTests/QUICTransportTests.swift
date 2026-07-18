import Darwin
import Foundation
import Network
import Security
import Testing

@testable import CrabfleetMac

private let udpLoopbackAvailable: Bool = {
  let receiver = socket(AF_INET, SOCK_DGRAM, 0)
  let sender = socket(AF_INET, SOCK_DGRAM, 0)
  guard receiver >= 0, sender >= 0 else {
    if receiver >= 0 { close(receiver) }
    if sender >= 0 { close(sender) }
    return false
  }
  defer {
    close(receiver)
    close(sender)
  }
  var address = sockaddr_in()
  address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
  address.sin_family = sa_family_t(AF_INET)
  address.sin_addr = in_addr(s_addr: inet_addr("127.0.0.1"))
  let didBind = withUnsafePointer(to: &address) {
    $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
      bind(receiver, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) == 0
    }
  }
  guard didBind else { return false }
  var length = socklen_t(MemoryLayout<sockaddr_in>.size)
  guard withUnsafeMutablePointer(to: &address, {
    $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
      getsockname(receiver, $0, &length) == 0
    }
  }) else { return false }
  var byte: UInt8 = 0x51
  let sent = withUnsafePointer(to: &address) { pointer in
    pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { destination in
      sendto(sender, &byte, 1, 0, destination, length) == 1
    }
  }
  guard sent else { return false }
  var event = pollfd(fd: receiver, events: Int16(POLLIN), revents: 0)
  guard poll(&event, 1, 500) == 1, event.revents & Int16(POLLIN) != 0 else { return false }
  return recv(receiver, &byte, 1, 0) == 1 && byte == 0x51
}()

@Suite(.serialized)
struct QUICTransportTests {
  @Test
  func certificateSerialsUseMinimalPositiveDERIntegers() {
    #expect(X509SerialNumber.canonicalDERContent(Data([0, 0x7f])) == Data([0x7f]))
    #expect(X509SerialNumber.canonicalDERContent(Data([0, 0x80])) == Data([0, 0x80]))
    #expect(X509SerialNumber.canonicalDERContent(Data([0x80])) == Data([0, 0x80]))
    #expect(X509SerialNumber.canonicalDERContent(Data([1])) == Data([1]))
  }

  @Test(
    .enabled(if: udpLoopbackAvailable, "UDP loopback is unavailable in this sandbox"),
    .timeLimit(.minutes(1)))
  func fullRFBHandshakeRoundTripsOverQUICLoopback() async throws {
    let fixture = try QUICIdentityFixture()
    defer { fixture.remove() }
    let listener = try NWListener(
      using: QUICParameters.server(identity: fixture.hostIdentity.identity),
      on: .any)
    let accepted = AsyncStream<NWConnectionGroup> { continuation in
      listener.newConnectionGroupHandler = { continuation.yield($0) }
    }
    try await start(listener)
    defer { listener.cancel() }
    let port = try #require(listener.port)

    let endpoint = NWEndpoint.hostPort(host: "127.0.0.1", port: port)
    let client = NWConnection(
      to: endpoint,
      using: try QUICParameters.client(expectedCertHash: fixture.hostIdentity.certHash))
    let serverTask = Task {
      var iterator = accepted.makeAsyncIterator()
      let group = try #require(await iterator.next())
      let streams = AsyncStream<NWConnection> { continuation in
        group.newConnectionHandler = { continuation.yield($0) }
      }
      try await start(group)
      var streamIterator = streams.makeAsyncIterator()
      let connection = try #require(await streamIterator.next())
      try await start(connection)
      try await performServerHandshake(RFBConnectionIO(connection: connection))
      group.cancel()
      return connection
    }
    defer { serverTask.cancel() }
    client.start(queue: .global(qos: .userInitiated))
    defer { client.cancel() }
    try await withTimeout("client stream") {
      try await send(Data("RFB 003.008\n".utf8), on: client)
    }
    try await withTimeout("client RFB handshake") {
      try await performClientHandshake(
        RFBConnectionIO(connection: client),
        protocolVersionAlreadySent: true)
    }
    let server = try await withTimeout("server RFB handshake") { try await serverTask.value }
    server.cancel()
  }

  @Test(
    .enabled(if: udpLoopbackAvailable, "UDP loopback is unavailable in this sandbox"),
    .timeLimit(.minutes(1)))
  @MainActor
  func tailnetQUICListenerAuthenticatesWithARD() async throws {
    let fixture = try QUICIdentityFixture()
    defer { fixture.remove() }
    let tcpPort = try availableLoopbackPort(socketType: SOCK_STREAM)
    let quicPort = try availableLoopbackPort(socketType: SOCK_DGRAM)
    let events = QUICEventLog()
    let server = TailnetRFBServer(
      identity: .init(
        tailnetName: "example.test",
        loginName: "tester@example.test",
        dnsName: "test-host.example.test",
        hostName: "Test Host",
        ipv4Address: "127.0.0.1",
        userID: 42),
      runner: QUICNoopTailscaleRunner(),
      capture: MacScreenCapture(),
      descriptor: .init(
        displayID: 0,
        displayBounds: CGRect(x: 0, y: 0, width: 64, height: 64),
        frameWidth: 64,
        frameHeight: 64,
        sourcePixelWidth: 64,
        sourcePixelHeight: 64),
      input: QUICNoopRemoteInput(),
      peerAuthorizer: QUICLoopbackPeerAuthorizer(),
      port: tcpPort,
      quicPort: quicPort,
      quicIdentity: fixture.hostIdentity,
      credentialProvider: { "test-auth-token" },
      authThrottle: RFBAuthThrottle(),
      eventHandler: { events.append($0) })
    try server.start()
    defer { server.stop() }

    let clock = ContinuousClock()
    var deadline = clock.now.advanced(by: .seconds(30))
    while !server.quicAvailable, clock.now < deadline {
      try await Task.sleep(for: .milliseconds(10))
    }
    #expect(server.quicAvailable)

    let controller = VNCSessionController(quicFallbackDelay: .seconds(30))
    controller.connect(
      host: "127.0.0.1",
      port: tcpPort,
      username: "",
      password: "test-auth-token",
      clipboardEnabled: false,
      quic: QUICConnectionConfiguration(
        port: Int(quicPort),
        certHash: fixture.hostIdentity.certHash),
      prefersPasswordOnlyARD: true)
    defer { controller.disconnect() }

    deadline = clock.now.advanced(by: .seconds(30))
    while controller.phase != .connected, clock.now < deadline {
      try await Task.sleep(for: .milliseconds(20))
    }
    #expect(controller.phase == .connected)
    #expect(controller.transport == .quic)
    #expect(
      events.values.contains {
        if case .connected = $0 { return true }
        return false
      })
  }

  @Test(
    .enabled(if: udpLoopbackAvailable, "UDP loopback is unavailable in this sandbox"),
    .timeLimit(.minutes(1)))
  @MainActor
  func quicToTCPFallbackAuthenticatesFromTheSameSource() async throws {
    let fixture = try QUICIdentityFixture()
    defer { fixture.remove() }
    let quicListener = try NWListener(
      using: QUICParameters.server(identity: fixture.hostIdentity.identity),
      on: .any)
    let quicGroups = AsyncStream<NWConnectionGroup> { continuation in
      quicListener.newConnectionGroupHandler = { continuation.yield($0) }
    }
    try await start(quicListener)
    defer { quicListener.cancel() }

    let tcpListener = try NWListener(using: .tcp, on: .any)
    let tcpConnections = AsyncStream<NWConnection> { continuation in
      tcpListener.newConnectionHandler = { continuation.yield($0) }
    }
    try await start(tcpListener)
    defer { tcpListener.cancel() }

    let authentication = RFBListenerAuthentication(
      credentialProvider: { "test-auth-token" },
      throttle: RFBAuthThrottle(),
      challengeProvider: { Data(0..<16) })
    let gate = QUICAuthenticationReadGate()
    let quicServerTask = Task {
      var groupIterator = quicGroups.makeAsyncIterator()
      let group = try #require(await groupIterator.next())
      let streams = AsyncStream<NWConnection> { continuation in
        group.newConnectionHandler = { continuation.yield($0) }
      }
      try await start(group)
      defer { group.cancel() }
      var streamIterator = streams.makeAsyncIterator()
      let connection = try #require(await streamIterator.next())
      try await start(connection)
      defer { connection.cancel() }
      let stream = StallingAuthenticationRFBByteStream(
        base: RFBConnectionIO(connection: connection),
        gate: gate)
      try await performAuthenticatedServerHandshake(
        stream,
        authentication: authentication,
        source: "127.0.0.1")
    }
    let tcpServerTask = Task {
      var iterator = tcpConnections.makeAsyncIterator()
      let connection = try #require(await iterator.next())
      try await start(connection)
      try await performAuthenticatedServerHandshake(
        RFBConnectionIO(connection: connection),
        authentication: authentication,
        source: "127.0.0.1")
      return connection
    }
    defer {
      gate.open()
      quicServerTask.cancel()
      tcpServerTask.cancel()
    }

    let controller = VNCSessionController(quicFallbackDelay: .seconds(4))
    controller.connect(
      host: "127.0.0.1",
      port: try #require(tcpListener.port).rawValue,
      username: "",
      password: "test-auth-token",
      clipboardEnabled: false,
      quic: QUICConnectionConfiguration(
        port: Int(try #require(quicListener.port).rawValue),
        certHash: fixture.hostIdentity.certHash))
    defer { controller.disconnect() }

    let clock = ContinuousClock()
    var deadline = clock.now.advanced(by: .seconds(3))
    while !gate.hasReached, clock.now < deadline {
      try await Task.sleep(for: .milliseconds(20))
    }
    #expect(gate.hasReached)
    guard gate.hasReached else { return }

    deadline = clock.now.advanced(by: .seconds(8))
    while controller.phase != .connected, clock.now < deadline {
      try await Task.sleep(for: .milliseconds(20))
    }
    #expect(controller.phase == .connected)
    #expect(controller.transport == .tcp)
  }

  @Test
  func rejectsMismatchedSPKIPin() throws {
    let fixture = try QUICIdentityFixture()
    defer { fixture.remove() }
    let wrongPin = String(repeating: "A", count: 43)
    #expect(wrongPin != fixture.hostIdentity.certHash)
    var certificate: SecCertificate?
    #expect(
      SecIdentityCopyCertificate(fixture.hostIdentity.identity, &certificate) == errSecSuccess)
    let hostCertificate = try #require(certificate)
    #expect(
      QUICCertificatePin.matches(
        certificate: hostCertificate,
        expectedHash: fixture.hostIdentity.certHash))
    #expect(!QUICCertificatePin.matches(certificate: hostCertificate, expectedHash: wrongPin))
  }

  @Test(
    .enabled(if: udpLoopbackAvailable, "UDP loopback is unavailable in this sandbox"),
    .timeLimit(.minutes(1)))
  func rejectsMismatchedSPKIPinDuringQUICHandshake() async throws {
    let fixture = try QUICIdentityFixture()
    defer { fixture.remove() }
    let listener = try NWListener(
      using: QUICParameters.server(identity: fixture.hostIdentity.identity),
      on: .any)
    let serverGroups = QUICConnectionGroupStore()
    listener.newConnectionGroupHandler = { group in
      serverGroups.insert(group)
      group.newConnectionHandler = { $0.start(queue: .global(qos: .userInitiated)) }
      group.start(queue: .global(qos: .userInitiated))
    }
    try await start(listener)
    defer {
      listener.cancel()
      serverGroups.cancelAll()
    }

    let wrongPin = String(repeating: "A", count: 43)
    let endpoint = NWEndpoint.hostPort(
      host: "127.0.0.1",
      port: try #require(listener.port))
    let client = NWConnection(
      to: endpoint,
      using: try QUICParameters.client(expectedCertHash: wrongPin))
    let states = AsyncStream<NWConnection.State> { continuation in
      client.stateUpdateHandler = { continuation.yield($0) }
    }
    client.start(queue: .global(qos: .userInitiated))
    client.send(content: Data("RFB 003.008\n".utf8), completion: .idempotent)
    defer { client.cancel() }

    for await state in states {
      switch state {
      case .waiting, .failed:
        return
      case .ready:
        Issue.record("QUIC accepted a server whose SPKI did not match the registration pin")
        return
      case .cancelled:
        throw CancellationError()
      default:
        continue
      }
    }
    throw CancellationError()
  }

  @Test(
    .enabled(if: udpLoopbackAvailable, "UDP loopback is unavailable in this sandbox"),
    .timeLimit(.minutes(1)))
  @MainActor
  func fallsBackToTCPAfterTwoSecondsAndRetriesARejectedReplacement() async throws {
    let fixture = try QUICIdentityFixture()
    defer { fixture.remove() }
    let quicListener = try NWListener(
      using: QUICParameters.server(identity: fixture.hostIdentity.identity),
      on: .any)
    let stalledQUIC = AsyncStream<NWConnectionGroup> { continuation in
      quicListener.newConnectionGroupHandler = { group in
        group.newConnectionHandler = { connection in
          connection.start(queue: .global(qos: .userInitiated))
        }
        group.start(queue: .global(qos: .userInitiated))
        continuation.yield(group)
      }
    }
    try await start(quicListener)
    defer { quicListener.cancel() }

    let tcpListener = try NWListener(using: .tcp, on: .any)
    let tcpAccepted = AsyncStream<NWConnection> { continuation in
      tcpListener.newConnectionHandler = { continuation.yield($0) }
    }
    try await start(tcpListener)
    defer { tcpListener.cancel() }

    let stalledTask = Task {
      var iterator = stalledQUIC.makeAsyncIterator()
      return await iterator.next()
    }
    let tcpServerTask = Task {
      var iterator = tcpAccepted.makeAsyncIterator()
      let rejected = try #require(await iterator.next())
      try await start(rejected)
      rejected.cancel()
      let connection = try #require(await iterator.next())
      try await start(connection)
      try await performServerHandshake(RFBConnectionIO(connection: connection))
      return connection
    }

    let controller = VNCSessionController()
    let clock = ContinuousClock()
    let started = clock.now
    let quic = QUICConnectionConfiguration(
      port: Int(try #require(quicListener.port).rawValue),
      certHash: fixture.hostIdentity.certHash)
    #expect(quic != nil)
    controller.connect(
      host: "127.0.0.1",
      port: try #require(tcpListener.port).rawValue,
      username: "",
      password: "",
      clipboardEnabled: false,
      quic: quic)

    let deadline = ContinuousClock().now.advanced(by: .seconds(5))
    while controller.phase != .connected, ContinuousClock().now < deadline {
      try await Task.sleep(for: .milliseconds(20))
    }
    #expect(controller.phase == .connected)
    #expect(controller.transport == .tcp)
    #expect(started.duration(to: clock.now) >= .seconds(2))
    controller.disconnect()
    (await stalledTask.value)?.cancel()
    (try await tcpServerTask.value).cancel()
  }

  @Test(.enabled(if: udpLoopbackAvailable, "UDP loopback is unavailable in this sandbox"))
  func keepsTCPListenerReadyWhenQUICPortIsOccupied() async throws {
    let fixture = try QUICIdentityFixture()
    defer { fixture.remove() }
    let blocker = try UDPPortReservation()
    let tcpPort = try availableLoopbackPort(socketType: SOCK_STREAM)

    let descriptor = CapturedDisplayDescriptor(
      displayID: 0,
      displayBounds: CGRect(x: 0, y: 0, width: 64, height: 64),
      frameWidth: 64,
      frameHeight: 64,
      sourcePixelWidth: 64,
      sourcePixelHeight: 64)
    let events = QUICEventLog()
    let server = TailnetRFBServer(
      identity: .init(
        tailnetName: "example.test",
        loginName: "tester@example.test",
        dnsName: "test-host.example.test",
        hostName: "Test Host",
        ipv4Address: "127.0.0.1",
        userID: 42),
      runner: QUICNoopTailscaleRunner(),
      capture: MacScreenCapture(),
      descriptor: descriptor,
      input: QUICNoopRemoteInput(),
      port: tcpPort,
      quicPort: blocker.port,
      quicIdentity: fixture.hostIdentity,
      credentialProvider: { "test-ownership-token-1" },
      authThrottle: RFBAuthThrottle(),
      eventHandler: { events.append($0) })
    try server.start()
    defer { server.stop() }

    let clock = ContinuousClock()
    let deadline = clock.now.advanced(by: .seconds(2))
    while !events.values.contains(.listening), clock.now < deadline {
      try await Task.sleep(for: .milliseconds(10))
    }
    #expect(events.values.contains(.listening))
    #expect(!server.quicAvailable)
  }

  @Test(
    .enabled(if: udpLoopbackAvailable, "UDP loopback is unavailable in this sandbox"),
    .timeLimit(.minutes(1)))
  func connectionGroupsWithoutStreamsDoNotReserveViewerSlots() async throws {
    let fixture = try QUICIdentityFixture()
    defer { fixture.remove() }
    let tcpPort = try availableLoopbackPort(socketType: SOCK_STREAM)
    let quicPort = try availableLoopbackPort(socketType: SOCK_DGRAM)
    let descriptor = CapturedDisplayDescriptor(
      displayID: 0,
      displayBounds: CGRect(x: 0, y: 0, width: 64, height: 64),
      frameWidth: 64,
      frameHeight: 64,
      sourcePixelWidth: 64,
      sourcePixelHeight: 64)
    let gate = RFBHostSessionGate()
    let events = QUICEventLog()
    let server = TailnetRFBServer(
      identity: .init(
        tailnetName: "example.test",
        loginName: "tester@example.test",
        dnsName: "test-host.example.test",
        hostName: "Test Host",
        ipv4Address: "127.0.0.1",
        userID: 42),
      runner: QUICNoopTailscaleRunner(),
      capture: MacScreenCapture(),
      descriptor: descriptor,
      input: QUICNoopRemoteInput(),
      port: tcpPort,
      quicPort: quicPort,
      quicIdentity: fixture.hostIdentity,
      credentialProvider: { "test-ownership-token-1" },
      authThrottle: RFBAuthThrottle(),
      sessionGate: gate,
      eventHandler: { events.append($0) })
    try server.start()
    defer { server.stop() }

    let clock = ContinuousClock()
    var deadline = clock.now.advanced(by: .seconds(2))
    while !server.quicAvailable, clock.now < deadline {
      try await Task.sleep(for: .milliseconds(10))
    }
    #expect(server.quicAvailable)

    let endpoint = NWEndpoint.hostPort(
      host: "127.0.0.1",
      port: try #require(NWEndpoint.Port(rawValue: quicPort)))
    let connections = try (0..<TailnetRFBServer.maximumSessions).map { _ in
      NWConnection(
        to: endpoint,
        using: try QUICParameters.client(expectedCertHash: fixture.hostIdentity.certHash))
    }
    for connection in connections { connection.start(queue: .global(qos: .userInitiated)) }
    defer { for connection in connections { connection.cancel() } }

    deadline = clock.now.advanced(by: .seconds(1))
    while server.pendingQUICGroupCount < connections.count, clock.now < deadline {
      try await Task.sleep(for: .milliseconds(10))
    }
    #expect(server.pendingQUICGroupCount == connections.count)
    #expect(gate.reservedCount == 0)
    #expect(gate.activeCount == 0)
  }

  @Test
  func tcpAndQUICSessionsShareTheFourSessionGate() throws {
    let gate = RFBHostSessionGate()
    let activeTransports: [DirectRFBTransport] = [.tcp, .quic]
    let sessions = try activeTransports.map { transport in
      (transport: transport, claim: try #require(gate.acquire()))
    }
    let pendingStreams = try [#require(gate.reserve()), #require(gate.reserve())]
    #expect(sessions.filter { $0.transport == .quic }.count == 1)
    #expect(gate.activeCount == activeTransports.count)
    #expect(gate.reservedCount == pendingStreams.count)
    #expect(gate.acquire() == nil)
    for session in sessions { gate.release(session.claim) }
    for reservation in pendingStreams { gate.release(reservation) }
    #expect(gate.activeCount == 0)
    #expect(gate.reservedCount == 0)
  }
}

private func availableLoopbackPort(socketType: Int32) throws -> UInt16 {
  let descriptor = socket(AF_INET, socketType, 0)
  guard descriptor >= 0 else { throw POSIXError(.ENOTSOCK) }
  defer { close(descriptor) }
  var address = sockaddr_in()
  address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
  address.sin_family = sa_family_t(AF_INET)
  address.sin_addr = in_addr(s_addr: inet_addr("127.0.0.1"))
  let bound = withUnsafePointer(to: &address) {
    $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
      bind(descriptor, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) == 0
    }
  }
  guard bound else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EINVAL) }
  var length = socklen_t(MemoryLayout<sockaddr_in>.size)
  let resolved = withUnsafeMutablePointer(to: &address) {
    $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
      getsockname(descriptor, $0, &length) == 0
    }
  }
  guard resolved else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EINVAL) }
  return UInt16(bigEndian: address.sin_port)
}

private final class UDPPortReservation {
  let descriptor: Int32
  let port: UInt16

  init() throws {
    let socketDescriptor = socket(AF_INET, SOCK_DGRAM, 0)
    guard socketDescriptor >= 0 else { throw POSIXError(.ENOTSOCK) }
    var address = sockaddr_in()
    address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
    address.sin_family = sa_family_t(AF_INET)
    address.sin_addr = in_addr(s_addr: inet_addr("127.0.0.1"))
    let bound = withUnsafePointer(to: &address) {
      $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
        bind(socketDescriptor, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) == 0
      }
    }
    guard bound else {
      close(socketDescriptor)
      throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EINVAL)
    }
    var length = socklen_t(MemoryLayout<sockaddr_in>.size)
    let resolved = withUnsafeMutablePointer(to: &address) {
      $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
        getsockname(socketDescriptor, $0, &length) == 0
      }
    }
    guard resolved else {
      close(socketDescriptor)
      throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EINVAL)
    }
    descriptor = socketDescriptor
    port = UInt16(bigEndian: address.sin_port)
  }

  deinit { close(descriptor) }
}

private struct QUICNoopTailscaleRunner: TailscaleCommandRunning {
  func run(arguments: [String]) async throws -> TailscaleCommandResult {
    .init(standardOutput: "", standardError: "")
  }
}

private struct QUICNoopRemoteInput: RemoteInputForwarding {
  func keyEvent(down: Bool, keysym: UInt32) {}
  func pointerEvent(buttonMask: UInt8, x: UInt16, y: UInt16) {}
}

private struct QUICLoopbackPeerAuthorizer: TailnetPeerAuthorizing {
  func authorize(remoteAddress: String) async -> Bool {
    remoteAddress == "127.0.0.1"
  }
}

private final class QUICEventLog: @unchecked Sendable {
  private let lock = NSLock()
  private var events: [TailnetRFBServerEvent] = []

  var values: [TailnetRFBServerEvent] { lock.withLock { events } }

  func append(_ event: TailnetRFBServerEvent) {
    lock.withLock { events.append(event) }
  }
}

private final class QUICConnectionGroupStore: @unchecked Sendable {
  private let lock = NSLock()
  private var groups: [NWConnectionGroup] = []

  func insert(_ group: NWConnectionGroup) {
    lock.withLock { groups.append(group) }
  }

  func cancelAll() {
    let values = lock.withLock {
      defer { groups.removeAll() }
      return groups
    }
    for group in values { group.cancel() }
  }
}

private struct QUICIdentityFixture {
  let applicationTag: Data
  let certificateLabel: String
  let hostIdentity: QUICHostIdentity

  init() throws {
    let id = UUID().uuidString
    applicationTag = Data("org.openclaw.crabfleet.tests.quic.\(id)".utf8)
    certificateLabel = "Crabfleet QUIC Test Certificate \(id)"
    hostIdentity = try QUICIdentityStore.loadOrCreate(
      applicationTag: applicationTag,
      certificateLabel: certificateLabel,
      keyLabel: "Crabfleet QUIC Test Key \(id)")
  }

  func remove() {
    QUICIdentityStore.remove(applicationTag: applicationTag, certificateLabel: certificateLabel)
  }
}

private func start(_ listener: NWListener) async throws {
  let states = AsyncStream<NWListener.State> { continuation in
    listener.stateUpdateHandler = { continuation.yield($0) }
  }
  listener.start(queue: .global(qos: .userInitiated))
  for await state in states {
    switch state {
    case .ready: return
    case .failed(let error): throw error
    case .cancelled: throw CancellationError()
    default: continue
    }
  }
  throw CancellationError()
}

private func start(_ connection: NWConnection) async throws {
  let states = AsyncStream<NWConnection.State> { continuation in
    connection.stateUpdateHandler = { continuation.yield($0) }
  }
  connection.start(queue: .global(qos: .userInitiated))
  for await state in states {
    switch state {
    case .ready: return
    case .failed(let error): throw error
    case .cancelled: throw CancellationError()
    default: continue
    }
  }
  throw CancellationError()
}

private func start(_ group: NWConnectionGroup) async throws {
  let states = AsyncStream<NWConnectionGroup.State> { continuation in
    group.stateUpdateHandler = { continuation.yield($0) }
  }
  group.start(queue: .global(qos: .userInitiated))
  for await state in states {
    switch state {
    case .ready: return
    case .failed(let error): throw error
    case .cancelled: throw CancellationError()
    default: continue
    }
  }
  throw CancellationError()
}

private func send(_ data: Data, on connection: NWConnection) async throws {
  try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
    connection.send(content: data, completion: .contentProcessed { error in
      if let error {
        continuation.resume(throwing: error)
      } else {
        continuation.resume()
      }
    })
  }
}

private struct QUICPhaseTimeout: Error, CustomStringConvertible {
  let phase: String
  var description: String { "Timed out during \(phase)" }
}

private func withTimeout<Value: Sendable>(
  _ phase: String,
  operation: @escaping @Sendable () async throws -> Value
) async throws -> Value {
  try await withThrowingTaskGroup(of: Value.self) { group in
    group.addTask(operation: operation)
    group.addTask {
      try await Task.sleep(for: .seconds(5))
      throw QUICPhaseTimeout(phase: phase)
    }
    let value = try await group.next()!
    group.cancelAll()
    return value
  }
}

private func performServerHandshake(_ stream: RFBConnectionIO) async throws {
  let banner = Data("RFB 003.008\n".utf8)
  try await stream.send(banner)
  #expect(try await stream.readExactly(banner.count) == banner)
  try await stream.send(Data([1, 1]))
  #expect(try await stream.readExactly(1) == Data([1]))
  try await stream.send(Data([0, 0, 0, 0]))
  #expect(try await stream.readExactly(1) == Data([1]))

  let name = Data("Crabfleet QUIC Test".utf8)
  var serverInit = Data([0x02, 0x80, 0x01, 0xE0])
  serverInit.append(Data([32, 24, 0, 1, 0, 255, 0, 255, 0, 255, 16, 8, 0, 0, 0, 0]))
  serverInit.append(bigEndian: UInt32(name.count))
  serverInit.append(name)
  try await stream.send(serverInit)
}

private func performAuthenticatedServerHandshake(
  _ stream: any RFBByteStream,
  authentication: RFBListenerAuthentication,
  source: String
) async throws {
  let banner = Data("RFB 003.008\n".utf8)
  try await stream.send(banner)
  #expect(try await stream.readExactly(banner.count) == banner)
  try await authentication.authenticate(
    version: .v3Point8,
    source: source,
    io: stream)
  #expect(try await stream.readExactly(1) == Data([1]))

  let name = Data("Crabfleet Authenticated Fallback Test".utf8)
  var serverInit = Data([0x02, 0x80, 0x01, 0xE0])
  serverInit.append(Data([32, 24, 0, 1, 0, 255, 0, 255, 0, 255, 16, 8, 0, 0, 0, 0]))
  serverInit.append(bigEndian: UInt32(name.count))
  serverInit.append(name)
  try await stream.send(serverInit)
}

private func performClientHandshake(
  _ stream: RFBConnectionIO,
  protocolVersionAlreadySent: Bool = false
) async throws {
  let banner = Data("RFB 003.008\n".utf8)
  #expect(try await stream.readExactly(banner.count) == banner)
  if !protocolVersionAlreadySent { try await stream.send(banner) }
  #expect(try await stream.readExactly(2) == Data([1, 1]))
  try await stream.send(Data([1]))
  #expect(try await stream.readExactly(4) == Data([0, 0, 0, 0]))
  try await stream.send(Data([1]))
  let header = try await stream.readExactly(24)
  let nameLength = header.suffix(4).reduce(UInt32(0)) { ($0 << 8) | UInt32($1) }
  #expect(nameLength <= 4_096)
  #expect(try await stream.readExactly(Int(nameLength)) == Data("Crabfleet QUIC Test".utf8))
}

extension Data {
  fileprivate mutating func append(bigEndian value: UInt32) {
    append(UInt8((value >> 24) & 0xff))
    append(UInt8((value >> 16) & 0xff))
    append(UInt8((value >> 8) & 0xff))
    append(UInt8(value & 0xff))
  }
}

private final class StallingAuthenticationRFBByteStream: RFBByteStream, @unchecked Sendable {
  private let base: any RFBByteStream
  private let gate: QUICAuthenticationReadGate
  private let lock = NSLock()
  private var didStall = false

  init(base: any RFBByteStream, gate: QUICAuthenticationReadGate) {
    self.base = base
    self.gate = gate
  }

  func readExactly(_ count: Int) async throws -> Data {
    let shouldStall = withLock {
      let shouldStall = count == 16 && !didStall
      if shouldStall { didStall = true }
      return shouldStall
    }
    if shouldStall { await gate.wait() }
    return try await base.readExactly(count)
  }

  func send(_ data: Data) async throws {
    try await base.send(data)
  }

  func send(_ data: Data, deadline: ContinuousClock.Instant?) async throws {
    try await base.send(data, deadline: deadline)
  }

  private func withLock<T>(_ body: () -> T) -> T {
    lock.lock()
    defer { lock.unlock() }
    return body()
  }
}

private final class QUICAuthenticationReadGate: @unchecked Sendable {
  private let lock = NSLock()
  private var isOpen = false
  private var reached = false
  private var releaseWaiters: [CheckedContinuation<Void, Never>] = []

  var hasReached: Bool {
    lock.lock()
    defer { lock.unlock() }
    return reached
  }

  func wait() async {
    await withCheckedContinuation { continuation in
      lock.lock()
      reached = true
      if isOpen {
        lock.unlock()
        continuation.resume()
      } else {
        releaseWaiters.append(continuation)
        lock.unlock()
      }
    }
  }

  func open() {
    lock.lock()
    isOpen = true
    let waiters = releaseWaiters
    releaseWaiters.removeAll()
    lock.unlock()
    waiters.forEach { $0.resume() }
  }
}
