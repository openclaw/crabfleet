import CoreMedia
import Foundation
import Network
import RoyalVNCKit

enum TailnetRFBServerEvent: Equatable, Sendable {
  case listening
  case authorizing(String)
  case connected(String, count: Int)
  case streaming(TailnetStreamStats)
  case audioActive(Bool)
  case sessionSnapshot([TailnetSessionDiagnostic])
  case disconnected(count: Int, remainingPeer: String?)
  case listenerFailed(String)
  case sessionFailed(String)
  case qualityModeChanged(ShareQualityMode)
  case viewerSessionsChanged([TailnetViewerSession])
}

struct TailnetViewerSession: Equatable, Identifiable, Sendable {
  let id: UUID
  let peer: String
  let qualityMode: ShareQualityMode
}

struct TailnetSessionDiagnostic: Equatable, Sendable {
  let id: UUID
  let peer: String
  let transport: DirectRFBTransport
}

struct TailnetStreamStats: Equatable, Sendable {
  let codec: String
  let hardwareAccelerated: Bool
  let codecDetail: String
  let targetBitrate: Int
  let dirtyAreaPercent: Double
  let framesPerSecond: Double
  let megabitsPerSecond: Double

  static func codecDetail(
    codec: String,
    hardwareAccelerated: Bool,
    maximumFrameQPAvailable: Bool,
    maximumFrameQPRequested: Bool,
    chroma444Available: Bool = true,
    chroma444Requested: Bool = false
  ) -> String {
    var detail = codec + (codec == "JPEG" ? "" : hardwareAccelerated ? " hw" : " sw")
    if !maximumFrameQPAvailable, maximumFrameQPRequested {
      detail += " · QP cap unavailable"
    }
    if !chroma444Available, chroma444Requested {
      detail += " · 4:4:4 unavailable"
    }
    return detail
  }
}

protocol RFBByteStream: Sendable {
  func readExactly(_ count: Int) async throws -> Data
  func readUInt8() async throws -> UInt8
  func send(_ data: Data) async throws
  func send(_ data: Data, deadline: ContinuousClock.Instant?) async throws
}

extension RFBByteStream {
  func readUInt8() async throws -> UInt8 {
    try await readExactly(1).first!
  }

  func send(_ data: Data, timeout: Duration?) async throws {
    try await send(
      data,
      deadline: timeout.map { ContinuousClock().now.advanced(by: $0) }
    )
  }

  func send(_ data: Data, deadline: ContinuousClock.Instant) async throws {
    try await send(data, deadline: Optional(deadline))
  }
}

final class RFBHostSessionGate: @unchecked Sendable {
  private let lock = NSLock()
  private var activeClaims: Set<UUID> = []
  private var reservations: Set<UUID> = []
  private var currentWidth: Int?
  private var currentHeight: Int?
  private var resizeInProgress = false

  func configure(descriptor: CapturedDisplayDescriptor) {
    lock.lock()
    if currentWidth == nil || currentHeight == nil {
      currentWidth = descriptor.frameWidth
      currentHeight = descriptor.frameHeight
    }
    lock.unlock()
  }

  func reserve() -> UUID? {
    lock.lock()
    defer { lock.unlock() }
    guard !resizeInProgress,
      activeClaims.count + reservations.count < TailnetRFBServer.maximumSessions
    else { return nil }
    let reservation = UUID()
    reservations.insert(reservation)
    return reservation
  }

  func activate(_ reservation: UUID) -> UUID? {
    lock.lock()
    defer { lock.unlock() }
    guard !resizeInProgress, reservations.remove(reservation) != nil else { return nil }
    activeClaims.insert(reservation)
    return reservation
  }

  func acquire() -> UUID? {
    lock.lock()
    defer { lock.unlock() }
    guard !resizeInProgress,
      activeClaims.count + reservations.count < TailnetRFBServer.maximumSessions
    else { return nil }
    let claim = UUID()
    activeClaims.insert(claim)
    return claim
  }

  func release(_ claim: UUID) {
    lock.lock()
    activeClaims.remove(claim)
    reservations.remove(claim)
    lock.unlock()
  }

  var isClaimed: Bool {
    lock.lock()
    defer { lock.unlock() }
    return !activeClaims.isEmpty
  }

  var activeCount: Int {
    lock.lock()
    defer { lock.unlock() }
    return activeClaims.count
  }

  var reservedCount: Int {
    lock.lock()
    defer { lock.unlock() }
    return reservations.count
  }

  func descriptor(basedOn descriptor: CapturedDisplayDescriptor) -> CapturedDisplayDescriptor {
    lock.lock()
    defer { lock.unlock() }
    return CapturedDisplayDescriptor(
      displayID: descriptor.displayID,
      displayBounds: descriptor.displayBounds,
      frameWidth: currentWidth ?? descriptor.frameWidth,
      frameHeight: currentHeight ?? descriptor.frameHeight,
      sourcePixelWidth: descriptor.sourcePixelWidth,
      sourcePixelHeight: descriptor.sourcePixelHeight)
  }

  func beginResize() -> Bool {
    lock.lock()
    defer { lock.unlock() }
    guard !resizeInProgress, activeClaims.count == 1, reservations.isEmpty else { return false }
    resizeInProgress = true
    return true
  }

  func finishResize(width: Int?, height: Int?) {
    lock.lock()
    if let width, let height {
      currentWidth = width
      currentHeight = height
    }
    resizeInProgress = false
    lock.unlock()
  }
}

final class DirectSessionClaimingRFBByteStream: RFBByteStream, @unchecked Sendable {
  private let base: any RFBByteStream
  private let gate: RFBHostSessionGate
  private let onAcquire: @Sendable () -> Void
  private let onRelease: @Sendable () -> Void
  private let lock = NSLock()
  private var reservation: UUID?
  private var claim: UUID?

  init(
    base: any RFBByteStream,
    gate: RFBHostSessionGate,
    reservation: UUID? = nil,
    onAcquire: @escaping @Sendable () -> Void,
    onRelease: @escaping @Sendable () -> Void
  ) {
    self.base = base
    self.gate = gate
    self.onAcquire = onAcquire
    self.onRelease = onRelease
    self.reservation = reservation ?? gate.reserve()
  }

  var hasClaim: Bool { withLock { claim != nil } }

  func readExactly(_ count: Int) async throws -> Data {
    guard count >= 0 else { return try await base.readExactly(count) }
    guard count > 0 else { return Data() }
    guard !hasClaim else { return try await base.readExactly(count) }

    var result = try await base.readExactly(1)
    let acquired = withLock { () -> UUID? in
      guard let reservation,
        let acquired = gate.activate(reservation)
      else { return nil }
      claim = acquired
      self.reservation = nil
      onAcquire()
      return acquired
    }
    guard acquired != nil else {
      throw PrivateMacShareError.protocolError("the desktop viewer limit is reached")
    }
    if count > 1 {
      result.append(try await base.readExactly(count - 1))
    }
    return result
  }

  func send(_ data: Data) async throws {
    try await base.send(data)
  }

  func send(_ data: Data, deadline: ContinuousClock.Instant?) async throws {
    try await base.send(data, deadline: deadline)
  }

  func finishClaim() {
    let released = withLock { () -> UUID? in
      let value = claim ?? reservation
      if claim != nil { onRelease() }
      claim = nil
      reservation = nil
      return value
    }
    if let released { gate.release(released) }
  }

  private func withLock<T>(_ body: () -> T) -> T {
    lock.lock()
    defer { lock.unlock() }
    return body()
  }
}

final class TailnetRFBServer: @unchecked Sendable {
  typealias EventHandler = @Sendable (TailnetRFBServerEvent) -> Void
  static let maximumSessions = 4
  static let maximumPendingQUICGroups = 16

  static func canAdmitSession(currentCount: Int) -> Bool {
    currentCount >= 0 && currentCount < maximumSessions
  }

  static func resizeStatus(sessionCount: Int) -> UInt16 {
    sessionCount == 1 ? 0 : 3
  }

  private let identity: TailnetIdentity
  private let runner: any TailscaleCommandRunning
  private let capture: MacScreenCapture
  private let descriptor: CapturedDisplayDescriptor
  private let input: any RemoteInputForwarding
  private let clipboard: (any HostClipboardSyncing)?
  private let peerAuthorizer: (any TailnetPeerAuthorizing)?
  private let port: UInt16
  private let quicPort: UInt16?
  private let quicIdentity: QUICHostIdentity?
  private let handshakeTimeout: Duration
  private let sessionGate: RFBHostSessionGate
  private let queue = DispatchQueue(label: "org.openclaw.crabfleet.rfb-listener")
  private let eventQueue = DispatchQueue(label: "org.openclaw.crabfleet.rfb-events")
  private let lock = NSLock()
  private let eventHandler: EventHandler
  private var listener: NWListener?
  private var quicListener: NWListener?
  private var quicGroups: [ObjectIdentifier: NWConnectionGroup] = [:]
  private var pendingQUICTimeouts: [ObjectIdentifier: Task<Void, Never>] = [:]
  private var sessionQUICGroupIDs: [UUID: ObjectIdentifier] = [:]
  private var listenerGeneration: UUID?
  private var readyTransports: Set<DirectRFBTransport> = []
  private var sessions: [UUID: RFBHostSession] = [:]
  private var connectedPeers: [UUID: String] = [:]
  private var sessionTransports: [UUID: DirectRFBTransport] = [:]
  private var sessionStats: [UUID: TailnetStreamStats] = [:]
  private var sessionQualityModes: [UUID: ShareQualityMode] = [:]
  private var audioSessionIDs: Set<UUID> = []
  private var viewOnly = false
  private var audioEnabled = true
  private var qualityMode: ShareQualityMode = .auto

  var quicAvailable: Bool {
    withLock { quicListener != nil && readyTransports.contains(.quic) }
  }

  var pendingQUICGroupCount: Int {
    withLock { pendingQUICTimeouts.count }
  }

  init(
    identity: TailnetIdentity,
    runner: any TailscaleCommandRunning,
    capture: MacScreenCapture,
    descriptor: CapturedDisplayDescriptor,
    input: any RemoteInputForwarding,
    clipboard: (any HostClipboardSyncing)? = nil,
    peerAuthorizer: (any TailnetPeerAuthorizing)? = nil,
    port: UInt16,
    quicPort: UInt16? = nil,
    quicIdentity: QUICHostIdentity? = nil,
    handshakeTimeout: Duration = .seconds(10),
    sessionGate: RFBHostSessionGate = RFBHostSessionGate(),
    eventHandler: @escaping EventHandler
  ) {
    self.identity = identity
    self.runner = runner
    self.capture = capture
    self.descriptor = descriptor
    self.input = input
    self.clipboard = clipboard
    self.peerAuthorizer = peerAuthorizer
    self.port = port
    self.quicPort = quicPort
    self.quicIdentity = quicIdentity
    self.handshakeTimeout = handshakeTimeout
    self.sessionGate = sessionGate
    self.eventHandler = eventHandler
    sessionGate.configure(descriptor: descriptor)
  }

  func start() throws {
    // A listener with `requiredLocalEndpoint` hands out child connections
    // that re-bind that endpoint and fail with EADDRINUSE on current macOS,
    // so the port binds wide and every accepted connection must instead prove
    // it arrived on the expected local address before any protocol bytes.
    let parameters = NWParameters.tcp
    parameters.allowLocalEndpointReuse = true
    guard let listenerPort = NWEndpoint.Port(rawValue: port) else {
      throw PrivateMacShareError.listenerFailed("invalid port")
    }
    let generation = UUID()
    let listener = try NWListener(using: parameters, on: listenerPort)
    configure(listener, transport: .tcp, generation: generation)
    listener.newConnectionHandler = { [weak self] connection in
      self?.accept(connection, transport: .tcp, generation: generation)
    }

    var configuredQUICListener: NWListener?
    if let quicPort, let quicIdentity {
      if let listenerPort = NWEndpoint.Port(rawValue: quicPort) {
        do {
          let listener = try NWListener(
            using: QUICParameters.server(identity: quicIdentity.identity),
            on: listenerPort)
          configure(listener, transport: .quic, generation: generation)
          listener.newConnectionGroupHandler = { [weak self] group in
            self?.accept(group, generation: generation)
          }
          configuredQUICListener = listener
        } catch {
          configuredQUICListener = nil
        }
      }
    } else if quicPort != nil || quicIdentity != nil {
      throw PrivateMacShareError.listenerFailed("incomplete QUIC listener configuration")
    }
    withLock {
      self.listener = listener
      quicListener = configuredQUICListener
      listenerGeneration = generation
      readyTransports.removeAll()
    }
    listener.start(queue: queue)
    configuredQUICListener?.start(queue: queue)
  }

  func stop() {
    let values = withLock {
      () -> (
        NWListener?, NWListener?, [(UUID, RFBHostSession)], [NWConnectionGroup],
        [Task<Void, Never>]
      ) in
      if !sessions.isEmpty {
        emit(.disconnected(count: 0, remainingPeer: nil))
      }
      defer {
        listener = nil
        quicListener = nil
        listenerGeneration = nil
        readyTransports.removeAll()
        sessions.removeAll()
        connectedPeers.removeAll()
        sessionTransports.removeAll()
        sessionStats.removeAll()
        sessionQualityModes.removeAll()
        audioSessionIDs.removeAll()
        quicGroups.removeAll()
        pendingQUICTimeouts.removeAll()
        sessionQUICGroupIDs.removeAll()
      }
      return (
        listener, quicListener, Array(sessions), Array(quicGroups.values),
        Array(pendingQUICTimeouts.values))
    }
    values.0?.cancel()
    values.1?.cancel()
    for (_, session) in values.2 { session.stop() }
    for group in values.3 { group.cancel() }
    for timeout in values.4 { timeout.cancel() }
  }

  func setViewOnly(_ enabled: Bool) {
    let activeSessions = withLock { () -> [RFBHostSession] in
      viewOnly = enabled
      return Array(sessions.values)
    }
    for session in activeSessions { session.setViewOnly(enabled) }
  }

  func setAudioEnabled(_ enabled: Bool) {
    let activeSessions = withLock { () -> [RFBHostSession] in
      audioEnabled = enabled
      return Array(sessions.values)
    }
    for session in activeSessions { session.setAudioEnabled(enabled) }
  }

  @discardableResult
  func setQualityMode(
    _ mode: ShareQualityMode,
    completion: (@Sendable (Bool) -> Void)? = nil
  ) -> Bool {
    withLock { () -> Bool in
      let activeSessions = Array(sessions.values)
      guard !activeSessions.isEmpty else {
        qualityMode = mode
        if let completion { Task { completion(true) } }
        return true
      }
      let previousMode = qualityMode
      var acceptedSessions: [(UUID, RFBHostSession, ShareQualityMode)] = []
      for (sessionID, activeSession) in sessions {
        let previousActiveMode = activeSession.activeQualityMode
        guard activeSession.setQualityMode(mode) else {
          for (acceptedID, acceptedSession, acceptedMode) in acceptedSessions {
            if !acceptedSession.setQualityMode(previousMode) {
              acceptedSession.stop()
            }
            sessionQualityModes[acceptedID] = acceptedMode
          }
          return false
        }
        sessionQualityModes[sessionID] = activeSession.activeQualityMode
        acceptedSessions.append((sessionID, activeSession, previousActiveMode))
      }
      qualityMode = mode
      if let completion { Task { completion(true) } }
      emit(.viewerSessionsChanged(viewerSessionsLocked()))
      return true
    }
  }

  private func configure(
    _ listener: NWListener,
    transport: DirectRFBTransport,
    generation: UUID
  ) {
    listener.stateUpdateHandler = { [weak self] state in
      guard let self else { return }
      switch state {
      case .ready:
        let shouldEmit = withLock { () -> Bool in
          guard self.listenerGeneration == generation else { return false }
          self.readyTransports.insert(transport)
          let expected = self.quicListener == nil ? 1 : 2
          return self.readyTransports.count == expected
        }
        if shouldEmit { emit(.listening) }
      case .failed(let error):
        if transport == .quic {
          let tcpIsReady = withLock { () -> Bool in
            guard self.listenerGeneration == generation else { return false }
            self.quicListener = nil
            self.readyTransports.remove(.quic)
            return self.readyTransports.contains(.tcp)
          }
          emit(.sessionFailed("QUIC unavailable; continuing over TCP."))
          if tcpIsReady { emit(.listening) }
        } else if withLock({ self.listenerGeneration == generation }) {
          emit(.listenerFailed("TCP: \(error.localizedDescription)"))
        }
      case .cancelled:
        break
      default:
        break
      }
    }
  }

  private func accept(_ group: NWConnectionGroup, generation: UUID) {
    let groupID = ObjectIdentifier(group)
    let timeout = Task { [weak self, weak group] in
      try? await Task.sleep(for: .seconds(2))
      guard !Task.isCancelled, let self, let group else { return }
      self.expirePendingQUICGroup(group, groupID: groupID)
    }
    let retained = withLock { () -> Bool in
      guard listenerGeneration == generation, quicListener != nil,
        pendingQUICTimeouts.count < Self.maximumPendingQUICGroups
      else { return false }
      quicGroups[groupID] = group
      pendingQUICTimeouts[groupID] = timeout
      return true
    }
    guard retained else {
      timeout.cancel()
      group.cancel()
      return
    }
    group.stateUpdateHandler = { [weak self, weak group] state in
      guard let self, let group else { return }
      switch state {
      case .failed, .cancelled:
        _ = self.releasePendingQUICGroup(group, groupID: groupID)
      default:
        break
      }
    }
    group.newConnectionHandler = { [weak self, weak group] connection in
      guard let self, let group else {
        connection.cancel()
        return
      }
      guard self.consumePendingQUICGroup(group, groupID: groupID) else {
        connection.cancel()
        return
      }
      self.accept(
        connection,
        transport: .quic,
        generation: generation,
        quicGroup: group)
    }
    group.start(queue: queue)
  }

  private func accept(
    _ connection: NWConnection,
    transport: DirectRFBTransport,
    generation: UUID,
    quicGroup: NWConnectionGroup? = nil
  ) {
    guard let sessionID = sessionGate.reserve() else {
      connection.cancel()
      if let quicGroup { discard(quicGroup) }
      return
    }
    let sessionDescriptor = sessionGate.descriptor(basedOn: descriptor)

    let stream = DirectSessionClaimingRFBByteStream(
      base: RFBConnectionIO(connection: connection),
      gate: sessionGate,
      reservation: sessionID,
      onAcquire: { [weak capture] in capture?.retainConsumer(id: sessionID) },
      onRelease: { [weak capture] in capture?.releaseConsumer(id: sessionID) }
    )
    let authorizer =
      peerAuthorizer
      ?? TailnetPeerAuthorizer(
        runner: runner,
        expectedIdentity: identity
      )
    let newSession = RFBHostSession(
      byteStream: stream,
      connection: connection,
      authorizer: authorizer,
      capture: capture,
      descriptor: sessionDescriptor,
      input: input,
      clipboard: clipboard,
      desktopSizeProvider: { [sessionGate, descriptor] in
        sessionGate.descriptor(basedOn: descriptor)
      },
      requiredLocalAddress: identity.ipv4Address,
      desktopName: "Crabfleet — \(identity.hostName)",
      handshakeTimeout: handshakeTimeout,
      viewOnly: false,
      audioEnabled: false,
      qualityMode: .auto,
      sessionID: sessionID,
      beginResize: { [weak self] in self?.beginResize(sessionID: sessionID) == true },
      finishResize: { [sessionGate] width, height in
        sessionGate.finishResize(width: width, height: height)
      },
      didAuthorize: {},
      eventHandler: { [weak self] event in
        self?.handleSessionEvent(event, sessionID: sessionID)
      },
      didFinish: { [weak self] finishedSession in
        stream.finishClaim()
        self?.clear(finishedSession, sessionID: sessionID)
      }
    )
    let admitted = withLock { () -> Bool in
      let transportListenerExists = transport == .tcp ? listener != nil : quicListener != nil
      guard listenerGeneration == generation, transportListenerExists,
        sessions[sessionID] == nil
      else {
        return false
      }
      sessions[sessionID] = newSession
      sessionQualityModes[sessionID] = qualityMode
      sessionTransports[sessionID] = transport
      if let quicGroup { sessionQUICGroupIDs[sessionID] = ObjectIdentifier(quicGroup) }
      newSession.setViewOnly(viewOnly)
      newSession.setAudioEnabled(audioEnabled)
      newSession.setQualityMode(qualityMode)
      newSession.start()
      return true
    }
    guard admitted else {
      stream.finishClaim()
      connection.cancel()
      if let quicGroup { discard(quicGroup) }
      return
    }
  }

  private func clear(_ finishedSession: RFBHostSession, sessionID: UUID) {
    let group = withLock { () -> NWConnectionGroup? in
      guard sessions[sessionID] === finishedSession else { return nil }
      sessions.removeValue(forKey: sessionID)
      connectedPeers.removeValue(forKey: sessionID)
      sessionTransports.removeValue(forKey: sessionID)
      sessionStats.removeValue(forKey: sessionID)
      sessionQualityModes.removeValue(forKey: sessionID)
      audioSessionIDs.remove(sessionID)
      let group = sessionQUICGroupIDs.removeValue(forKey: sessionID)
        .flatMap { quicGroups.removeValue(forKey: $0) }
      emit(
        .disconnected(
          count: connectedPeers.count,
          remainingPeer: connectedPeers.values.first))
      emit(.viewerSessionsChanged(viewerSessionsLocked()))
      emitSessionSnapshot()
      return group
    }
    group?.cancel()
  }

  private func discard(_ group: NWConnectionGroup) {
    let timeout = withLock {
      let timeout = pendingQUICTimeouts.removeValue(forKey: ObjectIdentifier(group))
      quicGroups.removeValue(forKey: ObjectIdentifier(group))
      return timeout
    }
    timeout?.cancel()
    group.cancel()
  }

  private func consumePendingQUICGroup(
    _ group: NWConnectionGroup,
    groupID: ObjectIdentifier
  ) -> Bool {
    let timeout = withLock { () -> Task<Void, Never>? in
      guard quicGroups[groupID] === group else { return nil }
      return pendingQUICTimeouts.removeValue(forKey: groupID)
    }
    timeout?.cancel()
    return timeout != nil
  }

  private func releasePendingQUICGroup(
    _ group: NWConnectionGroup,
    groupID: ObjectIdentifier
  ) -> Bool {
    let timeout = withLock { () -> Task<Void, Never>? in
      guard quicGroups[groupID] === group,
        let timeout = pendingQUICTimeouts.removeValue(forKey: groupID)
      else { return nil }
      quicGroups.removeValue(forKey: groupID)
      return timeout
    }
    guard let timeout else { return false }
    timeout.cancel()
    return true
  }

  private func expirePendingQUICGroup(
    _ group: NWConnectionGroup,
    groupID: ObjectIdentifier
  ) {
    if releasePendingQUICGroup(group, groupID: groupID) {
      group.cancel()
    }
  }

  private func handleSessionEvent(_ event: TailnetRFBServerEvent, sessionID: UUID) {
    switch event {
    case .connected(let peer, _):
      withLock {
        guard sessions[sessionID] != nil else { return }
        connectedPeers[sessionID] = peer
        emit(.connected(peer, count: connectedPeers.count))
        emit(.viewerSessionsChanged(viewerSessionsLocked()))
        emitSessionSnapshot()
      }
    case .qualityModeChanged(let mode):
      withLock {
        guard sessions[sessionID] != nil else { return }
        sessionQualityModes[sessionID] = mode
        emit(.viewerSessionsChanged(viewerSessionsLocked()))
      }
    case .viewerSessionsChanged:
      break
    case .streaming(let stats):
      withLock {
        guard sessions[sessionID] != nil else { return }
        sessionStats[sessionID] = stats
        let busiest = sessionStats.values.max { $0.megabitsPerSecond < $1.megabitsPerSecond } ?? stats
        emit(
          .streaming(
            TailnetStreamStats(
              codec: busiest.codec,
              hardwareAccelerated: busiest.hardwareAccelerated,
              codecDetail: busiest.codecDetail,
              targetBitrate: sessionStats.values.reduce(0) { $0 + $1.targetBitrate },
              dirtyAreaPercent: busiest.dirtyAreaPercent,
              framesPerSecond: sessionStats.values.reduce(0) { $0 + $1.framesPerSecond },
              megabitsPerSecond: sessionStats.values.reduce(0) { $0 + $1.megabitsPerSecond })))
      }
    case .audioActive(let active):
      withLock {
        guard sessions[sessionID] != nil else { return }
        if active { audioSessionIDs.insert(sessionID) } else { audioSessionIDs.remove(sessionID) }
        emit(.audioActive(!audioSessionIDs.isEmpty))
      }
    case .disconnected:
      break
    case .authorizing(let peer):
      withLock {
        guard sessions[sessionID] != nil, connectedPeers.isEmpty else { return }
        emit(.authorizing(peer))
      }
    default:
      withLock {
        guard sessions[sessionID] != nil else { return }
        emit(event)
      }
    }
  }

  private func viewerSessionsLocked() -> [TailnetViewerSession] {
    connectedPeers.compactMap { sessionID, peer in
      guard let mode = sessionQualityModes[sessionID] else { return nil }
      return TailnetViewerSession(id: sessionID, peer: peer, qualityMode: mode)
    }.sorted { $0.id.uuidString < $1.id.uuidString }
  }

  private func emitSessionSnapshot() {
    let snapshot = connectedPeers.compactMap { sessionID, peer in
      sessionTransports[sessionID].map {
        TailnetSessionDiagnostic(id: sessionID, peer: peer, transport: $0)
      }
    }.sorted {
      if $0.transport != $1.transport { return $0.transport.rawValue < $1.transport.rawValue }
      return $0.peer < $1.peer
    }
    emit(.sessionSnapshot(snapshot))
  }

  private func beginResize(sessionID: UUID) -> Bool {
    guard withLock({ sessions[sessionID] != nil }) else { return false }
    return sessionGate.beginResize()
  }

  private func withLock<T>(_ body: () -> T) -> T {
    lock.lock()
    defer { lock.unlock() }
    return body()
  }

  private func emit(_ event: TailnetRFBServerEvent) {
    eventQueue.async { [eventHandler] in eventHandler(event) }
  }
}

final class RFBHostSession: @unchecked Sendable {
  private let sessionID: UUID
  private let byteStream: any RFBByteStream
  private let connection: NWConnection?
  private let authorizer: (any TailnetPeerAuthorizing)?
  private let capture: MacScreenCapture
  private let cursorSnapshotProvider: @Sendable () -> SystemCursorSnapshot?
  private let captureOutputSizeUpdater: @Sendable (Int, Int) async throws -> Void
  private let descriptor: CapturedDisplayDescriptor
  private let input: any RemoteInputForwarding
  private let inputGate: RemoteInputSessionGate
  private let clipboard: (any HostClipboardSyncing)?
  private let desktopSizeProvider: @Sendable () -> CapturedDisplayDescriptor?
  private let requiredLocalAddress: String?
  private let remoteAddressOverride: String?
  private let skipTailnetCheck: Bool
  private let desktopName: String
  private let handshakeTimeout: Duration?
  private let didAuthorize: @Sendable () -> Void
  private let beginResize: @Sendable () -> Bool
  private let finishResize: @Sendable (Int?, Int?) -> Void
  private let queue = DispatchQueue(label: "org.openclaw.crabfleet.rfb-session")
  private let eventHandler: TailnetRFBServer.EventHandler
  private let didFinish: @Sendable (RFBHostSession) -> Void
  private let lock = NSLock()
  private var started = false
  private var finished = false
  private var handshakeFinished = false
  private var handshakeTimedOut = false
  private var task: Task<Void, Never>?
  private var pushIO: (any RFBByteStream)?

  // Negotiated per-connection state; only the protocol task mutates it.
  private var supportsTightEncoding = false
  private var supportsCrabfleetHEVC = false
  private var supportsCrabfleetChroma444 = false
  private var supportsOpenH264 = false
  private var cursorEncoding: RFBWire.CursorEncodingSelection?
  private var supportsPointerPosition = false
  private var supportsExtendedDesktopSize = false
  private var supportsExtendedClipboard = false
  private var supportsCrabfleetAudio = false
  private var supportsCrabfleetQualityControl = false
  private var sentServerClipboardCaps = false
  private var needsDesktopSizeAnnounce = false
  private var clientClipboardCaps: VNCExtendedClipboardCaps?
  private var currentWidth: Int
  private var currentHeight: Int
  private var cursorFrameWidth: Int
  private var cursorFrameHeight: Int
  private var videoEncoder: MacVideoEncoder?
  private var videoFrameMailbox: VideoMailbox<MacVideoEncoderOutput>?
  private var videoPixelMailbox: VideoMailbox<VideoPixelSource>?
  private var videoFrameConsumer: Task<Void, Never>?
  private var hevcPathBroken = false
  private var chroma444Unavailable = false
  private var h264PathBroken = false
  private var needsContextReset = false
  private var forceNextKeyframe = false
  private var rateController = VideoRateController()
  private var lastStatsTimestamp = ProcessInfo.processInfo.systemUptime
  private let audioPipelineGate = AudioPipelineGate()
  private var audioEnabled: Bool
  private var audioEncoder: MacAudioEncoder?
  private var audioConsumer: Task<Void, Never>?
  private var audioGeneration: UInt64 = 0
  private var audioIsActive = false
  private var audioPathBroken = false
  private var qualityMode: ShareQualityMode
  private var defaultQualityMode: ShareQualityMode
  private var viewerQualityMode: ShareQualityMode?
  private var frameIntervalGeneration: UInt64 = 0
  private var qualityModeRefreshRequested = false
  private var idleRefreshPolicy = VideoIdleRefreshPolicy(
    timestamp: ProcessInfo.processInfo.systemUptime)
  private var cursorSessionRegistered = false
  private var latestCursorSnapshot: SystemCursorSnapshot?
  private var lastCursorImageHash: Data?
  private var lastCursorPosition: (x: UInt16, y: UInt16)?
  private var cursorIsVisible: Bool?
  private var lastLocalPointerInput: TimeInterval?
  private var cursorStateGeneration: UInt64 = 0
  private var preferCursorPosition = false
  private let framebufferUpdateArbiter = FramebufferUpdateArbiter<VideoPixelSource>()
  private var cursorEchoWakeTask: Task<Void, Never>?

  init(
    byteStream: any RFBByteStream,
    connection: NWConnection? = nil,
    authorizer: (any TailnetPeerAuthorizing)? = nil,
    capture: MacScreenCapture,
    descriptor: CapturedDisplayDescriptor,
    input: any RemoteInputForwarding,
    clipboard: (any HostClipboardSyncing)?,
    desktopSizeProvider: @escaping @Sendable () -> CapturedDisplayDescriptor? = { nil },
    requiredLocalAddress: String? = nil,
    remoteAddressOverride: String? = nil,
    skipTailnetCheck: Bool = false,
    desktopName: String,
    handshakeTimeout: Duration?,
    viewOnly: Bool,
    audioEnabled: Bool,
    qualityMode: ShareQualityMode,
    sessionID: UUID = UUID(),
    cursorSnapshotProvider: (@Sendable () -> SystemCursorSnapshot?)? = nil,
    captureOutputSizeUpdater: (@Sendable (Int, Int) async throws -> Void)? = nil,
    beginResize: @escaping @Sendable () -> Bool = { true },
    finishResize: @escaping @Sendable (Int?, Int?) -> Void = { _, _ in },
    didAuthorize: @escaping @Sendable () -> Void,
    eventHandler: @escaping TailnetRFBServer.EventHandler,
    didFinish: @escaping @Sendable (RFBHostSession) -> Void
  ) {
    self.sessionID = sessionID
    self.byteStream = byteStream
    self.connection = connection
    self.authorizer = authorizer
    self.capture = capture
    self.cursorSnapshotProvider = cursorSnapshotProvider ?? { capture.currentCursorSnapshot() }
    self.captureOutputSizeUpdater = captureOutputSizeUpdater ?? { width, height in
      try await capture.updateOutputSize(width: width, height: height)
    }
    self.descriptor = descriptor
    self.input = input
    inputGate = RemoteInputSessionGate(input: input, viewOnly: viewOnly)
    self.audioEnabled = audioEnabled
    self.clipboard = clipboard
    self.desktopSizeProvider = desktopSizeProvider
    self.requiredLocalAddress = requiredLocalAddress
    self.remoteAddressOverride = remoteAddressOverride
    self.skipTailnetCheck = skipTailnetCheck
    self.desktopName = desktopName
    self.handshakeTimeout = handshakeTimeout
    self.qualityMode = qualityMode
    defaultQualityMode = qualityMode
    self.beginResize = beginResize
    self.finishResize = finishResize
    self.didAuthorize = didAuthorize
    self.eventHandler = eventHandler
    self.didFinish = didFinish
    currentWidth = descriptor.frameWidth
    currentHeight = descriptor.frameHeight
    cursorFrameWidth = descriptor.frameWidth
    cursorFrameHeight = descriptor.frameHeight
  }

  func start() {
    guard let connection else {
      beginProtocolIfNeeded()
      return
    }
    connection.stateUpdateHandler = { [weak self] state in
      guard let self else { return }
      switch state {
      case .ready:
        beginProtocolIfNeeded()
      case .failed(let error):
        finish(event: .sessionFailed(error.localizedDescription))
      case .cancelled:
        finish(event: .disconnected(count: 0, remainingPeer: nil))
      default:
        break
      }
    }
    connection.start(queue: queue)
  }

  func stop() {
    task?.cancel()
    finish(event: .disconnected(count: 0, remainingPeer: nil))
  }

  func setViewOnly(_ enabled: Bool) {
    inputGate.setViewOnly(enabled)
  }

  func setAudioEnabled(_ enabled: Bool) {
    let io = withLock { () -> (any RFBByteStream)? in
      audioEnabled = enabled
      if enabled { audioPathBroken = false }
      return pushIO
    }
    guard let io else { return }
    Task { [weak self] in
      await self?.reconcileAudioPath(io: io)
    }
  }

  @discardableResult
  func setQualityMode(
    _ mode: ShareQualityMode,
    completion: (@Sendable (Bool) -> Void)? = nil
  ) -> Bool {
    let accepted = withLock { () -> Bool in
      let previousDefaultMode = defaultQualityMode
      defaultQualityMode = mode
      guard viewerQualityMode == nil else { return true }
      guard applyQualityModeLocked(mode) else {
        defaultQualityMode = previousDefaultMode
        return false
      }
      return true
    }
    if let completion { Task { completion(accepted) } }
    return accepted
  }

  var activeQualityMode: ShareQualityMode { withLock { qualityMode } }
  var isFinished: Bool { withLock { finished } }

  var activeRateControllerBounds: ClosedRange<Int> {
    withLock {
      let lowerBound = qualityMode.bitrateFloor(chroma: rateController.chroma)
      let upperBound = qualityMode.bitrateCeiling(chroma: rateController.chroma)
      return lowerBound...upperBound
    }
  }

  private func setViewerQualityMode(_ mode: ShareQualityMode?) -> Bool {
    let accepted = withLock { () -> Bool in
      let previousViewerMode = viewerQualityMode
      viewerQualityMode = mode
      guard applyQualityModeLocked(mode ?? defaultQualityMode) else {
        viewerQualityMode = previousViewerMode
        return false
      }
      return true
    }
    if accepted { eventHandler(.qualityModeChanged(activeQualityMode)) }
    return accepted
  }

  private func applyQualityModeLocked(_ mode: ShareQualityMode) -> Bool {
      let previousMaximumFrameQP = qualityMode.maximumFrameQP
      let previousRateController = rateController
      let previousMode = qualityMode
      qualityMode = mode
      let bitrate = rateController.setMode(mode, chroma: videoEncoder?.activeChroma)
      guard let videoEncoder else {
        return true
      }
      videoEncoder.setAverageBitrate(bitrate)
      if previousMaximumFrameQP != mode.maximumFrameQP,
        videoEncoder.setMaximumFrameQP(mode.maximumFrameQP) != noErr
      {
        qualityMode = previousMode
        rateController = previousRateController
        videoEncoder.setAverageBitrate(previousRateController.targetBitrate)
        return false
      }
      qualityModeRefreshRequested = true
      return true
  }

  private func beginProtocolIfNeeded() {
    lock.lock()
    guard !started else {
      lock.unlock()
      return
    }
    started = true
    lock.unlock()

    task = Task { [weak self] in
      guard let self else { return }
      do {
        try await runProtocol()
        finish(event: .disconnected(count: 0, remainingPeer: nil))
      } catch is CancellationError {
        finish(event: .disconnected(count: 0, remainingPeer: nil))
      } catch {
        finish(event: .sessionFailed(error.localizedDescription))
      }
    }
  }

  private func runProtocol() async throws {
    guard
      let remoteAddress = remoteAddressOverride ?? Self.address(from: connection?.endpoint),
      !remoteAddress.isEmpty
    else {
      throw PrivateMacShareError.protocolError("missing peer address")
    }

    if !skipTailnetCheck {
      guard let connection, let requiredLocalAddress, let authorizer else {
        throw PrivateMacShareError.protocolError("missing tailnet authorization context")
      }
      // The wide port bind accepts connections from any interface; only the
      // shared address may proceed, checked before any protocol bytes go out.
      guard let localAddress = Self.address(from: connection.currentPath?.localEndpoint),
        localAddress == requiredLocalAddress
      else {
        throw PrivateMacShareError.protocolError(
          "connection did not arrive on the shared tailnet address")
      }

      eventHandler(.authorizing(remoteAddress))
      let isAuthorized = await authorizer.authorize(remoteAddress: remoteAddress)
      try Task.checkCancellation()
      guard isAuthorized else {
        throw PrivateMacShareError.protocolError(
          "peer is not another device for this Tailscale user")
      }
    }
    try activateIfRunning()

    let io = byteStream
    try await handshakeBeforeDeadline(io: io)
    try await capture.addCursorSession(id: sessionID)
    let registered = withLock { () -> Bool in
      guard !finished, !Task.isCancelled else { return false }
      cursorSessionRegistered = true
      pushIO = io
      return true
    }
    guard registered else {
      try? await capture.removeCursorSession(id: sessionID)
      throw CancellationError()
    }
    startCursorPath()
    attachClipboard()
    eventHandler(.connected(remoteAddress, count: 0))
    eventHandler(.qualityModeChanged(activeQualityMode))
    resetRateController()
    lastStatsTimestamp = ProcessInfo.processInfo.systemUptime
    try await messageLoop(io: io)
  }

  private func activateIfRunning() throws {
    lock.lock()
    guard !finished, !Task.isCancelled else {
      lock.unlock()
      throw CancellationError()
    }
    didAuthorize()
    lock.unlock()
  }

  private func handshake(io: any RFBByteStream) async throws {
    try await io.send(RFBVersion.serverBanner)
    let clientBanner = try await io.readExactly(12)
    guard let version = RFBVersion(banner: clientBanner) else {
      throw PrivateMacShareError.protocolError("unsupported RFB version")
    }

    if version == .v3Point3 {
      var security = Data()
      security.appendBigEndian(UInt32(1))
      try await io.send(security)
    } else {
      try await io.send(Data([1, 1]))
      guard try await io.readUInt8() == 1 else {
        throw PrivateMacShareError.protocolError("unsupported security selection")
      }
      if version >= .v3Point8 {
        var securityResult = Data()
        securityResult.appendBigEndian(UInt32(0))
        try await io.send(securityResult)
      }
    }

    _ = try await io.readUInt8()  // ClientInit shared flag
    if let latestDescriptor = desktopSizeProvider() {
      currentWidth = latestDescriptor.frameWidth
      currentHeight = latestDescriptor.frameHeight
      input.updateFrameSize(width: currentWidth, height: currentHeight)
    }
    try await io.send(
      try RFBWire.serverInit(
        width: currentWidth,
        height: currentHeight,
        name: desktopName
      ))
    commitCursorFrameSize(width: currentWidth, height: currentHeight)
  }

  private func handshakeBeforeDeadline(io: any RFBByteStream) async throws {
    guard let handshakeTimeout else {
      try await handshake(io: io)
      withLock { handshakeFinished = true }
      return
    }
    let deadlineTask = Task { [weak self, handshakeTimeout] in
      do {
        try await Task.sleep(for: handshakeTimeout)
      } catch {
        return
      }
      self?.expireHandshake()
    }
    do {
      try await handshake(io: io)
      deadlineTask.cancel()
      let timedOut = withLock { () -> Bool in
        handshakeFinished = true
        return handshakeTimedOut
      }
      guard !timedOut else {
        throw PrivateMacShareError.protocolError("RFB handshake timed out")
      }
    } catch {
      deadlineTask.cancel()
      if withLock({ handshakeTimedOut }) {
        throw PrivateMacShareError.protocolError("RFB handshake timed out")
      }
      throw error
    }
  }

  private func expireHandshake() {
    let shouldCancel = withLock { () -> Bool in
      guard !finished, !handshakeFinished else { return false }
      handshakeTimedOut = true
      return true
    }
    if shouldCancel {
      finish(event: .sessionFailed("RFB handshake timed out"))
    }
  }

  private func messageLoop(io: any RFBByteStream) async throws {
    var hasSentJPEGFrame = false
    var lastSentJPEGSequence: UInt64 = 0

    protocolLoop: while !Task.isCancelled {
      let messageType = try await io.readUInt8()
      switch messageType {
      case 0:  // SetPixelFormat
        let payload = try await io.readExactly(19)
        let format = RFBPixelFormat(data: Data(payload[3..<19]))
        guard format == .bgra8888 else {
          throw PrivateMacShareError.protocolError("only 24-bit true-color pixels are supported")
        }

      case 2:  // SetEncodings
        let header = try await io.readExactly(3)
        let count = Int(header.readUInt16(at: 1))
        guard count <= 256 else {
          throw PrivateMacShareError.protocolError("too many requested encodings")
        }
        let encodingData = try await io.readExactly(count * 4)
        let encodings = (0..<count).map { encodingData.readInt32(at: $0 * 4) }
        supportsTightEncoding = encodings.contains(RFBWire.tightEncoding)
        supportsCrabfleetHEVC = encodings.contains(RFBWire.crabfleetHEVCEncoding)
        supportsCrabfleetChroma444 = encodings.contains(RFBWire.crabfleetChroma444Encoding)
        supportsOpenH264 = encodings.contains(RFBWire.openH264Encoding)
        let nextSupportsQualityControl = encodings.contains(
          RFBWire.crabfleetQualityControlEncoding)
        let shouldAcknowledgeQualityControl =
          nextSupportsQualityControl && !supportsCrabfleetQualityControl
        if supportsCrabfleetQualityControl, !nextSupportsQualityControl,
          !setViewerQualityMode(nil)
        {
          throw PrivateMacShareError.protocolError("quality reconfiguration failed")
        }
        supportsCrabfleetQualityControl = nextSupportsQualityControl
        let nextCursorEncoding = RFBWire.preferredCursorEncoding(from: encodings)
        let nextSupportsPointerPosition = encodings.contains(RFBWire.pointerPositionEncoding)
        if encodings.contains(RFBWire.extendedDesktopSizeEncoding),
          !supportsExtendedDesktopSize
        {
          supportsExtendedDesktopSize = true
          needsDesktopSizeAnnounce = true
        }
        withLock {
          supportsExtendedClipboard = encodings.contains(RFBWire.extendedClipboardEncoding)
          supportsCrabfleetAudio = encodings.contains(RFBWire.crabfleetAudioEncoding)
        }
        do {
          try await capture.updateCursorSession(
            id: sessionID,
            negotiated: nextCursorEncoding != nil)
          withLock {
            let cursorStateChanged =
              cursorEncoding != nextCursorEncoding
              || supportsPointerPosition != nextSupportsPointerPosition
            if cursorEncoding != nextCursorEncoding {
              lastCursorImageHash = nil
              cursorIsVisible = nil
            }
            if supportsPointerPosition != nextSupportsPointerPosition {
              lastCursorPosition = nil
            }
            cursorEncoding = nextCursorEncoding
            supportsPointerPosition = nextSupportsPointerPosition
            if cursorStateChanged {
              cursorStateGeneration &+= 1
            }
          }
          if let snapshot = cursorSnapshotProvider() {
            receiveCursorSnapshot(snapshot, force: true)
          }
        } catch {
          throw PrivateMacShareError.protocolError("cursor capture reconfiguration failed")
        }
        if let activeEncoder = activeVideoEncoder,
          activeEncoder.codec != selectedVideoCodec
            || activeEncoder.activeChroma != selectedVideoChroma
        {
          await stopVideoPath(markBroken: nil)
        }
        if !supportsCrabfleetHEVC, !supportsOpenH264 {
          if supportsTightEncoding { try await prepareTightFallback(io: io) }
        }
        if shouldAcknowledgeQualityControl {
          try await io.send(RFBWire.qualityControlCapability())
        }
        try await sendServerClipboardCapsIfNeeded(io: io)
        await reconcileAudioPath(io: io)

      case 201:  // Crabfleet per-viewer quality control
        let payload = try await io.readExactly(3)
        guard supportsCrabfleetQualityControl else {
          throw PrivateMacShareError.protocolError("quality control was not negotiated")
        }
        guard payload[1] == 0, payload[2] == 0 else {
          throw PrivateMacShareError.protocolError("invalid quality control padding")
        }
        guard let mode = ShareQualityMode(wireValue: payload[0]) else {
          throw PrivateMacShareError.protocolError("unknown quality control mode")
        }
        guard setViewerQualityMode(mode) else {
          throw PrivateMacShareError.protocolError("quality reconfiguration failed")
        }

      case 3:  // FramebufferUpdateRequest
        let payload = try await io.readExactly(9)
        let incremental = payload[0] != 0
        guard selectedFrameEncoding != nil else {
          throw PrivateMacShareError.protocolError("the client did not offer a supported encoding")
        }
        if needsDesktopSizeAnnounce {
          needsDesktopSizeAnnounce = false
          try await io.send(
            try RFBWire.extendedDesktopSizeUpdate(
              reason: 0,
              status: 0,
              width: currentWidth,
              height: currentHeight
            ))
          commitCursorFrameSize(width: currentWidth, height: currentHeight)
          framebufferUpdateArbiter.recordVideoResponse()
          continue protocolLoop
        }
        var videoReady = withLock { videoPixelMailbox?.hasPendingElement == true }
        // The pixel mailbox only backs the HEVC/H.264 path; on Tight/JPEG
        // fallback an undelivered frame-store frame must also count as
        // pending video, or continuous cursor traffic starves the stream.
        if !videoReady, selectedVideoCodec == nil, selectedFrameEncoding == .tight,
          let frame = await capture.frameStore.latest(),
          frame.sequence != lastSentJPEGSequence
        {
          videoReady = true
        }
        var attemptedCursorForRequest = false
        if let snapshot = framebufferUpdateArbiter.takeCursorIfAllowed(
          videoReady: videoReady,
          force: !incremental)
        {
          attemptedCursorForRequest = true
          do {
            if try await sendCursorSnapshot(snapshot, io: io) {
              framebufferUpdateArbiter.recordCursorResponse()
              if incremental {
                continue protocolLoop
              }
            }
          } catch is RFBSendExpiredError {
            // Preserve the latest cursor for a future request, then satisfy
            // this request with video or an idle response.
            reofferCursorSnapshotIfCurrent(snapshot)
          }
        }
        videoResponseLoop: while let codec = selectedVideoCodec {
          if let encoder = activeVideoEncoder, encoder.activeChroma != selectedVideoChroma {
            await stopVideoPath(markBroken: nil)
          }
          if activeVideoEncoder == nil {
            do {
              try await startVideoPath(codec: codec)
            } catch {
              await stopVideoPath(markBroken: codec)
              continue
            }
          }
          if let encoder = activeVideoEncoder {
            if !incremental { requestKeyframe() }
            switch await nextVideoUpdate(
              encoder: encoder,
              allowCursor: !attemptedCursorForRequest)
            {
            case .cursor(let snapshot):
              attemptedCursorForRequest = true
              do {
                if try await sendCursorSnapshot(snapshot, io: io) {
                  framebufferUpdateArbiter.recordCursorResponse()
                  if incremental { continue protocolLoop }
                }
              } catch is RFBSendExpiredError {
                reofferCursorSnapshotIfCurrent(snapshot)
              }
              continue videoResponseLoop
            case .frame(let frame, let dirtyAreaFraction):
              guard !needsContextReset || frame.isKeyframe else {
                requestKeyframe()
                try await io.send(RFBWire.emptyUpdate())
                framebufferUpdateArbiter.recordVideoResponse()
                continue protocolLoop
              }
              let flags: UInt32 = (needsContextReset ? 0x2 : 0)
                | (encoder.activeChroma == .chroma444 ? 0x4 : 0)
              let update = try videoUpdate(frame: frame, codec: codec, flags: flags)
              let sendSeconds = try await timedSend(update, io: io)
              needsContextReset = false
              recordFrameStats(
                byteCount: frame.data.count,
                sendSeconds: sendSeconds,
                codec: videoCodecDescription(codec: codec, encoder: encoder),
                hardwareAccelerated: encoder.isHardwareAccelerated,
                encoder: encoder,
                dirtyAreaFraction: dirtyAreaFraction)
              framebufferUpdateArbiter.recordVideoResponse()
              continue protocolLoop
            case .idle:
              // Nothing changed on screen; answer the request anyway so the
              // client's request loop and input keep flowing.
              try await io.send(RFBWire.emptyUpdate())
              framebufferUpdateArbiter.recordVideoResponse()
              emitStatsIfDue(
                codec: videoCodecDescription(codec: codec, encoder: encoder),
                hardwareAccelerated: encoder.isHardwareAccelerated,
                maximumFrameQPAvailable: encoder.isMaximumFrameQPAvailable,
                chroma444Available: !chroma444Unavailable)
              continue protocolLoop
            case .chromaFallback:
              chroma444Unavailable = true
              await stopVideoPath(markBroken: nil)
            case .failed:
              await stopVideoPath(markBroken: codec)
            }
          }
        }

        if supportsTightEncoding { try await prepareTightFallback(io: io) }

        guard selectedFrameEncoding == .tight else {
          throw PrivateMacShareError.protocolError(
            "the HEVC and Open H.264 encoders failed and Tight was not offered")
        }
        if hasSentJPEGFrame { try await Task.sleep(for: .milliseconds(66)) }
        let frame = try await waitForMatchingFrame()
        // Deduplicate only incremental requests: a non-incremental request is
        // an explicit ask for the full framebuffer contents.
        if incremental, frame.sequence == lastSentJPEGSequence {
          try await io.send(RFBWire.emptyUpdate())
          framebufferUpdateArbiter.recordVideoResponse()
          emitStatsIfDue(codec: "JPEG", hardwareAccelerated: false)
          continue
        }
        let update = try RFBWire.tightJPEGUpdate(frame: frame)
        let sendSeconds = try await timedSend(update, io: io)
      recordFrameStats(
        byteCount: frame.jpegData.count,
        sendSeconds: sendSeconds,
        codec: "JPEG",
        hardwareAccelerated: false,
        encoder: nil,
        dirtyAreaFraction: 1)
        lastSentJPEGSequence = frame.sequence
        hasSentJPEGFrame = true
        framebufferUpdateArbiter.recordVideoResponse()

      case 4:  // KeyEvent
        let payload = try await io.readExactly(7)
        inputGate.keyEvent(down: payload[0] != 0, keysym: payload.readUInt32(at: 3))

      case 5:  // PointerEvent
        let payload = try await io.readExactly(5)
        let accepted = inputGate.pointerEvent(
          buttonMask: payload[0],
          x: payload.readUInt16(at: 1),
          y: payload.readUInt16(at: 3)
        )
        withLock {
          // The viewer renders its local event optimistically. Force a later
          // authoritative PointerPos even when view-only input rejects it.
          lastCursorPosition = nil
          if accepted {
            lastLocalPointerInput = ProcessInfo.processInfo.systemUptime
          }
        }
        scheduleCursorEchoWake(after: accepted ? .milliseconds(250) : .zero)

      case 6:  // ClientCutText
        try await receiveClientCutText(io: io)

      case 251:  // SetDesktopSize
        try await receiveSetDesktopSize(io: io)

      default:
        throw PrivateMacShareError.protocolError("unsupported client message \(messageType)")
      }
    }
  }

  // MARK: - Clipboard

  private func attachClipboard() {
    clipboard?.attach(id: sessionID) { [weak self] text in
      self?.pushHostClipboard(text)
    }
  }

  private func sendServerClipboardCapsIfNeeded(io: any RFBByteStream) async throws {
    let clipboardNegotiated = withLock { supportsExtendedClipboard }
    guard clipboardNegotiated, clipboard != nil, !sentServerClipboardCaps else { return }
    sentServerClipboardCaps = true
    let body = VNCExtendedClipboard.encodeCaps(
      maximumUnsolicitedTextBytes: UInt32(RFBWire.maximumClipboardBytes)
    )
    try await io.send(VNCExtendedClipboard.frame(messageType: 3, body: body))
  }

  private func receiveClientCutText(io: any RFBByteStream) async throws {
    let header = try await io.readExactly(7)
    let length = Int(header.readInt32(at: 3))

    if length >= 0 {
      guard length <= RFBWire.maximumClipboardBytes else {
        throw PrivateMacShareError.protocolError("clipboard payload is too large")
      }
      let payload = try await io.readExactly(length)
      guard let clipboard else { return }
      guard let text = String(data: payload, encoding: .isoLatin1) else { return }
      clipboard.receiveClientText(id: sessionID, text: text)
      return
    }

    let bodyLength = -length
    guard bodyLength <= RFBWire.maximumExtendedClipboardBodyBytes else {
      throw PrivateMacShareError.protocolError("extended clipboard payload is too large")
    }
    let body = try await io.readExactly(bodyLength)
    let clipboardNegotiated = withLock { supportsExtendedClipboard }
    guard let clipboard, clipboardNegotiated else { return }

    // The body is fully consumed, so malformed messages are dropped without
    // desynchronizing the connection.
    guard let message = try? VNCExtendedClipboard.decode(body: body) else { return }

    switch message {
    case .caps(let caps):
      withLock { clientClipboardCaps = caps }

    case .notify(let hasText):
      guard hasText else { return }
      try await io.send(
        VNCExtendedClipboard.frame(
          messageType: 3,
          body: VNCExtendedClipboard.encodeRequestText()
        ))

    case .provide(let text):
      guard let text else { return }
      clipboard.receiveClientText(id: sessionID, text: text)

    case .request(let wantsText):
      guard wantsText else { return }
      let text = clipboard.currentText() ?? ""
      guard let body = try? VNCExtendedClipboard.encodeProvide(text: text) else { return }
      try await io.send(VNCExtendedClipboard.frame(messageType: 3, body: body))

    case .peek:
      try await io.send(
        VNCExtendedClipboard.frame(
          messageType: 3,
          body: VNCExtendedClipboard.encodeNotify(hasText: clipboard.currentText() != nil)
        ))
    }
  }

  private func pushHostClipboard(_ text: String) {
    let (io, extendedNegotiated, caps) = withLock {
      (pushIO, supportsExtendedClipboard, clientClipboardCaps)
    }
    guard let io else { return }

    let payload = RFBWire.hostClipboardPayload(
      text: text,
      extendedNegotiated: extendedNegotiated,
      caps: caps
    )
    guard let payload else { return }
    Task {
      try? await io.send(payload)
    }
  }

  // MARK: - Desktop resize

  private func receiveSetDesktopSize(io: any RFBByteStream) async throws {
    let header = try await io.readExactly(7)
    let requestedWidth = Int(header.readUInt16(at: 1))
    let requestedHeight = Int(header.readUInt16(at: 3))
    let screenCount = Int(header[5])
    guard screenCount <= 16 else {
      throw PrivateMacShareError.protocolError("too many screens in resize request")
    }
    _ = try await io.readExactly(screenCount * 16)

    guard supportsExtendedDesktopSize else {
      throw PrivateMacShareError.protocolError("resize requested without ExtendedDesktopSize")
    }

    guard beginResize() else {
      try await io.send(
        try RFBWire.extendedDesktopSizeUpdate(
          reason: 1,
          status: TailnetRFBServer.resizeStatus(sessionCount: 2),
          width: currentWidth,
          height: currentHeight
        ))
      return
    }
    var committedWidth: Int?
    var committedHeight: Int?
    defer { finishResize(committedWidth, committedHeight) }

    let videoWasActive = activeVideoEncoder != nil
    let isUsingVideo = selectedVideoCodec != nil
    let target = MacScreenCapture.resizedDimensions(
      requestedWidth: requestedWidth,
      requestedHeight: requestedHeight,
      sourcePixelWidth: descriptor.sourcePixelWidth,
      sourcePixelHeight: descriptor.sourcePixelHeight,
      maximumWidth: isUsingVideo ? 4_096 : 2_560,
      maximumHeight: isUsingVideo ? 2_304 : 1_600
    )

    if target.width == currentWidth, target.height == currentHeight {
      try await io.send(
        try RFBWire.extendedDesktopSizeUpdate(
          reason: 1,
          status: 0,
          width: currentWidth,
          height: currentHeight
        ))
      return
    }

    do {
      try await captureOutputSizeUpdater(target.width, target.height)
    } catch {
      // Status 2 = out of resources; the rectangle echoes the attempted layout.
      try await io.send(
        try RFBWire.extendedDesktopSizeUpdate(
          reason: 1,
          status: 2,
          width: requestedWidth,
          height: requestedHeight
        ))
      return
    }

    committedWidth = target.width
    committedHeight = target.height
    currentWidth = target.width
    currentHeight = target.height
    input.updateFrameSize(width: target.width, height: target.height)
    if videoWasActive {
      do {
        guard let codec = selectedVideoCodec else {
          throw PrivateMacShareError.protocolError("video encoding is unavailable")
        }
        try await restartVideoPath(codec: codec)
      } catch {
        let failedCodec = activeVideoEncoder?.codec ?? selectedVideoCodec
        await stopVideoPath(markBroken: failedCodec)
        if let fallbackCodec = selectedVideoCodec {
          do {
            try await startVideoPath(codec: fallbackCodec)
          } catch {
            await stopVideoPath(markBroken: fallbackCodec)
          }
        }
        if activeVideoEncoder == nil {
          guard supportsTightEncoding else {
            throw PrivateMacShareError.protocolError(
              "the video encoder failed after resize and Tight was not offered")
          }
          let tightTarget = MacScreenCapture.resizedDimensions(
            requestedWidth: requestedWidth,
            requestedHeight: requestedHeight,
            sourcePixelWidth: descriptor.sourcePixelWidth,
            sourcePixelHeight: descriptor.sourcePixelHeight)
          if tightTarget.width != currentWidth || tightTarget.height != currentHeight {
            try await captureOutputSizeUpdater(tightTarget.width, tightTarget.height)
            committedWidth = tightTarget.width
            committedHeight = tightTarget.height
            currentWidth = tightTarget.width
            currentHeight = tightTarget.height
            input.updateFrameSize(width: currentWidth, height: currentHeight)
          }
        }
      }
    }
    try await io.send(
      try RFBWire.extendedDesktopSizeUpdate(
        reason: 1,
        status: 0,
        width: currentWidth,
        height: currentHeight
      ))
    commitCursorFrameSize(width: currentWidth, height: currentHeight)
    committedWidth = currentWidth
    committedHeight = currentHeight
  }

  // MARK: - Cursor

  private func startCursorPath() {
    capture.addCursorHandler(id: sessionID) { [weak self] snapshot in
      self?.receiveCursorSnapshot(snapshot)
    }
    if withLock({ finished }) {
      stopCursorPath()
    }
  }

  private func receiveCursorSnapshot(_ snapshot: SystemCursorSnapshot, force: Bool = false) {
    withLock {
      guard !finished else { return }
      let changed = latestCursorSnapshot != snapshot
      latestCursorSnapshot = snapshot
      if force || changed {
        framebufferUpdateArbiter.offerCursor(snapshot)
      }
    }
  }

  private func reofferCursorSnapshotIfCurrent(_ snapshot: SystemCursorSnapshot) {
    withLock {
      guard !finished, latestCursorSnapshot == snapshot else { return }
      framebufferUpdateArbiter.offerCursor(snapshot)
    }
  }

  private func scheduleCursorEchoWake(after delay: Duration) {
    let task = Task { [weak self] in
      if delay > .zero {
        do {
          try await Task.sleep(for: delay)
        } catch {
          return
        }
      }
      guard !Task.isCancelled, let self else { return }
      self.withLock {
        guard !self.finished, let snapshot = self.latestCursorSnapshot else { return }
        self.framebufferUpdateArbiter.offerCursor(snapshot)
      }
    }
    let previous = withLock { () -> Task<Void, Never>? in
      defer { cursorEchoWakeTask = task }
      return cursorEchoWakeTask
    }
    previous?.cancel()
  }

  private func sendCursorSnapshot(
    _ snapshot: SystemCursorSnapshot,
    io: any RFBByteStream
  ) async throws -> Bool {
    let state = withLock {
      (
        cursorEncoding,
        supportsPointerPosition,
        cursorFrameWidth,
        cursorFrameHeight,
        lastCursorImageHash,
        lastCursorPosition,
        lastLocalPointerInput,
        finished,
        cursorIsVisible,
        cursorStateGeneration,
        preferCursorPosition
      )
    }
    guard !state.7 else { return false }

    guard let position = CursorCoordinateMapper.pointerPosition(
      snapshot.position,
      descriptor: descriptor,
      frameWidth: state.2,
      frameHeight: state.3)
    else {
      guard let encoding = state.0, state.8 != false else { return false }
      // Shape updates continue during mixed baked/client-cursor periods by
      // contract; hiding prevents an off-display cursor pinning to an edge.
      try await io.send(RFBWire.hiddenCursorUpdate(encoding: encoding), timeout: .milliseconds(100))
      withLock {
        guard cursorStateGeneration == state.9 else { return }
        cursorIsVisible = false
        lastCursorImageHash = nil
        lastCursorPosition = nil
      }
      return true
    }

    if snapshot.image == nil, let encoding = state.0, state.8 != false {
      try await io.send(
        RFBWire.hiddenCursorUpdate(encoding: encoding),
        timeout: .milliseconds(100))
      withLock {
        guard cursorStateGeneration == state.9 else { return }
        cursorIsVisible = false
        lastCursorImageHash = nil
        // Viewers drop their overlay on an empty shape; keeping the last
        // position would suppress the PointerPos resend when the cursor
        // reappears at the same coordinates, stranding the overlay hidden.
        lastCursorPosition = nil
      }
      return true
    }

    let mappedImage = snapshot.image.flatMap {
      CursorCoordinateMapper.cursorImage(
        $0,
        descriptor: descriptor,
        frameWidth: state.2,
        frameHeight: state.3)
    }
    let imageChanged = mappedImage.map { $0.contentHash != state.4 } ?? false
    let positionChanged = state.5?.x != position.x || state.5?.y != position.y
    let now = ProcessInfo.processInfo.systemUptime
    let latestLocalInput = withLock { lastLocalPointerInput }
    let canSendPosition = state.1 && CursorEchoPolicy.shouldSendPointerPosition(
      positionChanged: positionChanged,
      lastLocalInput: latestLocalInput,
      now: now)

    if canSendPosition && (state.10 || !imageChanged) {
      try await io.send(
        RFBWire.pointerPositionUpdate(x: position.x, y: position.y),
        timeout: .milliseconds(100))
      withLock {
        guard cursorStateGeneration == state.9 else { return }
        lastCursorPosition = position
        preferCursorPosition = false
      }
      // Mirror of the shape branch's requeue: when position wins while the
      // image also changed, the snapshot already left the arbiter and a
      // stationary pointer would dedup every later poll, stranding the old
      // shape. Reoffer so the next request delivers the new image.
      if imageChanged {
        reofferCursorSnapshotIfCurrent(snapshot)
      }
      return true
    }

    if let encoding = state.0,
      let image = mappedImage,
      image.contentHash != state.4
    {
      let update: Data
      switch encoding {
      case .cursorWithAlpha:
        update = try RFBWire.cursorWithAlphaUpdate(image: image)
      case .cursor:
        update = try RFBWire.cursorUpdate(image: image)
      }
      try await io.send(update, timeout: .milliseconds(100))
      withLock {
        guard cursorStateGeneration == state.9 else { return }
        lastCursorImageHash = image.contentHash
        cursorIsVisible = true
        preferCursorPosition = true
      }
      if canSendPosition {
        reofferCursorSnapshotIfCurrent(snapshot)
      }
      return true
    }

    guard withLock({ cursorStateGeneration == state.9 }) else { return false }
    guard canSendPosition else { return false }
    try await io.send(
      RFBWire.pointerPositionUpdate(x: position.x, y: position.y),
      timeout: .milliseconds(100))
    withLock {
      guard cursorStateGeneration == state.9 else { return }
      lastCursorPosition = position
      preferCursorPosition = false
    }
    return true
  }

  private func stopCursorPath() {
    capture.removeCursorHandler(id: sessionID)
    withLock { latestCursorSnapshot = nil }
  }

  // MARK: - Audio

  private func reconcileAudioPath(io: any RFBByteStream) async {
    await audioPipelineGate.run { [weak self] in
      guard let self else { return }
      let shouldStream = self.withLock {
        self.audioEnabled && self.supportsCrabfleetAudio && !self.audioPathBroken
          && !self.finished
      }
      if shouldStream {
        if self.withLock({ self.audioEncoder == nil }) {
          await self.startAudioPath(io: io)
        }
      } else {
        await self.stopAudioPathNow(sendStop: true, io: io)
      }
    }
  }

  private func startAudioPath(io: any RFBByteStream) async {
    let encoder = MacAudioEncoder()
    let generation = withLock { () -> UInt64 in
      audioGeneration &+= 1
      audioEncoder = encoder
      audioIsActive = true
      return audioGeneration
    }
    let consumer = Task { [weak self] in
      var sentConfiguration: AudioStreamConfiguration?
      for await event in encoder.events {
        guard let self, isCurrentAudioGeneration(generation) else { return }
        do {
          switch event {
          case .config(let configuration):
            try await io.send(
              RFBWire.audioConfig(
                channels: configuration.channels,
                sampleRate: configuration.sampleRate,
                magicCookie: configuration.magicCookie),
              timeout: .milliseconds(250))
            sentConfiguration = configuration

          case .packet(let packet):
            guard Self.audioSendDeadline(createdAt: packet.createdAt) != nil else { continue }
            if sentConfiguration != packet.configuration {
              try await io.send(
                RFBWire.audioConfig(
                  channels: packet.configuration.channels,
                  sampleRate: packet.configuration.sampleRate,
                  magicCookie: packet.configuration.magicCookie),
                timeout: .milliseconds(250))
              sentConfiguration = packet.configuration
            }
            guard isCurrentAudioGeneration(generation) else { return }
            guard let deadline = Self.audioSendDeadline(createdAt: packet.createdAt) else { continue }
            try await io.send(
              RFBWire.audioPacket(timestampMs: packet.timestampMs, payload: packet.data),
              deadline: deadline)

          case .failed:
            handleAudioFailure(generation: generation)
            return
          }
        } catch is RFBSendExpiredError {
          continue
        } catch {
          handleAudioFailure(generation: generation)
          return
        }
      }
    }
    withLock { audioConsumer = consumer }
    capture.addAudioSampleHandler(id: sessionID) { sampleBuffer in
      encoder.submit(sampleBuffer)
    }
    do {
      try await capture.retainAudioConsumer(id: sessionID)
      eventHandler(.audioActive(true))
    } catch {
      withLock { audioPathBroken = true }
      await stopAudioPathNow(sendStop: false, io: io)
    }
  }

  private func stopAudioPath(sendStop: Bool) async {
    await audioPipelineGate.run { [weak self] in
      guard let self else { return }
      await self.stopAudioPathNow(
        sendStop: sendStop,
        io: self.withLock { self.pushIO })
    }
  }

  private func stopAudioPathNow(sendStop: Bool, io: (any RFBByteStream)?) async {
    let previous = withLock { () -> (MacAudioEncoder?, Task<Void, Never>?, Bool) in
      defer {
        audioEncoder = nil
        audioConsumer = nil
        audioIsActive = false
        audioGeneration &+= 1
      }
      return (audioEncoder, audioConsumer, audioIsActive)
    }
    guard previous.0 != nil || previous.2 else { return }
    capture.removeAudioSampleHandler(id: sessionID)
    previous.1?.cancel()
    previous.0?.invalidate()
    await previous.1?.value
    if sendStop, let io {
      try? await io.send(RFBWire.audioStop(), timeout: .milliseconds(250))
    }
    try? await capture.releaseAudioConsumer(id: sessionID)
    eventHandler(.audioActive(false))
  }

  private func isCurrentAudioGeneration(_ generation: UInt64) -> Bool {
    withLock { audioGeneration == generation && !finished }
  }

  private static func audioSendDeadline(createdAt: TimeInterval) -> ContinuousClock.Instant? {
    let remaining = 0.2 - (ProcessInfo.processInfo.systemUptime - createdAt)
    guard remaining > 0 else { return nil }
    let duration = Duration.nanoseconds(max(1, Int64(remaining * 1_000_000_000)))
    return ContinuousClock().now.advanced(by: duration)
  }

  private func handleAudioFailure(generation: UInt64) {
    Task { [weak self] in
      guard let self else { return }
      await self.audioPipelineGate.run { [weak self] in
        guard let self, self.isCurrentAudioGeneration(generation) else { return }
        self.withLock { self.audioPathBroken = true }
        await self.stopAudioPathNow(sendStop: true, io: self.withLock { self.pushIO })
      }
    }
  }

  // MARK: - Video

  /// Captured pixel buffers flow into a latest-wins mailbox and are encoded
  /// one at a time as the connection drains: every encoded frame is sent, so
  /// the inter-frame reference chain stays intact and stale frames are dropped
  /// before they cost encoder time.
  private func startVideoPath(codec: MacVideoCodec) async throws {
    let configuration = withLock { (qualityMode.maximumFrameQP, selectedVideoChroma) }
    let encoder = try MacVideoEncoder(
      width: currentWidth,
      height: currentHeight,
      codec: codec,
      chroma: configuration.1,
      maximumFrameQP: configuration.0)
    if configuration.1 == .chroma444, encoder.activeChroma != .chroma444 {
      chroma444Unavailable = true
    }
    let pixelMailbox = VideoMailbox<VideoPixelSource>()
    _ = replaceVideoEncoder(with: encoder)
    withLock { videoPixelMailbox = pixelMailbox }
    startVideoFrameConsumer(for: encoder)
    let frameInterval = try beginVideoFrameInterval(for: encoder)
    lastStatsTimestamp = ProcessInfo.processInfo.systemUptime
    idleRefreshPolicy = VideoIdleRefreshPolicy(timestamp: lastStatsTimestamp)
    needsContextReset = true
    requestKeyframe()
    capture.addVideoFrameHandler(id: sessionID) { [weak self] source in
      guard let self,
        MacScreenCapture.shouldOfferVideoFrame(
          dirtyRects: source.dirtyRects,
          keyframeOwed: pendingKeyframeRequested())
      else { return }
      pixelMailbox.offer(source)
      self.framebufferUpdateArbiter.signalVideo()
    }
    do {
      try await capture.updateFrameIntervalRequirement(
        id: sessionID,
        // A negotiated inter-frame codec always keeps shared capture at 60 fps.
        framesPerSecond: 60,
        shouldApply: { [weak self] in
          self?.isFrameIntervalGenerationCurrent(frameInterval.generation) == true
        })
    } catch {
      capture.removeVideoFrameHandler(id: sessionID)
      stopVideoFrameConsumer()
      finishPixelMailbox()
      encoder.invalidate()
      _ = replaceVideoEncoder(with: nil)
      throw error
    }
  }

  private func restartVideoPath(codec: MacVideoCodec) async throws {
    capture.removeVideoFrameHandler(id: sessionID)
    stopVideoFrameConsumer()
    finishPixelMailbox()
    replaceVideoEncoder(with: nil)?.invalidate()
    try await startVideoPath(codec: codec)
  }

  private func stopVideoPath(markBroken codec: MacVideoCodec?) async {
    switch codec {
    case .hevc: hevcPathBroken = true
    case .h264: h264PathBroken = true
    case nil: break
    }
    capture.removeVideoFrameHandler(id: sessionID)
    stopVideoFrameConsumer()
    finishPixelMailbox()
    replaceVideoEncoder(with: nil)?.invalidate()
    needsContextReset = false
    withLock { forceNextKeyframe = false }
    resetRateController()
    lastStatsTimestamp = ProcessInfo.processInfo.systemUptime
    invalidateFrameIntervalUpdates()
    try? await capture.removeFrameIntervalRequirement(id: sessionID)
  }

  private func finishPixelMailbox() {
    let mailbox = withLock { () -> VideoMailbox<VideoPixelSource>? in
      defer { videoPixelMailbox = nil }
      return videoPixelMailbox
    }
    mailbox?.finish()
  }

  private func prepareTightFallback(io: any RFBByteStream) async throws {
    guard currentWidth > 2_560 || currentHeight > 1_600 else { return }
    let target = MacScreenCapture.resizedDimensions(
      requestedWidth: currentWidth,
      requestedHeight: currentHeight,
      sourcePixelWidth: descriptor.sourcePixelWidth,
      sourcePixelHeight: descriptor.sourcePixelHeight)
    guard target.width != currentWidth || target.height != currentHeight else { return }
    try await captureOutputSizeUpdater(target.width, target.height)
    currentWidth = target.width
    currentHeight = target.height
    input.updateFrameSize(width: currentWidth, height: currentHeight)
    if supportsExtendedDesktopSize {
      try await io.send(
        try RFBWire.extendedDesktopSizeUpdate(
          reason: 0,
          status: 0,
          width: currentWidth,
          height: currentHeight))
      commitCursorFrameSize(width: currentWidth, height: currentHeight)
    }
  }

  private var selectedFrameEncoding: RFBWire.FrameEncodingSelection? {
    var encodings: [Int32] = []
    if supportsCrabfleetHEVC { encodings.append(RFBWire.crabfleetHEVCEncoding) }
    if supportsOpenH264 { encodings.append(RFBWire.openH264Encoding) }
    if supportsTightEncoding { encodings.append(RFBWire.tightEncoding) }
    return RFBWire.preferredFrameEncoding(
      from: encodings,
      hevcPathBroken: hevcPathBroken,
      h264PathBroken: h264PathBroken)
  }

  private var selectedVideoCodec: MacVideoCodec? {
    switch selectedFrameEncoding {
    case .crabfleetHEVC: .hevc
    case .openH264: .h264
    case .tight, nil: nil
    }
  }

  private var selectedVideoChroma: MacVideoChroma {
    guard let codec = selectedVideoCodec else { return .chroma420 }
    var encodings: [Int32] = []
    if supportsCrabfleetChroma444 { encodings.append(RFBWire.crabfleetChroma444Encoding) }
    return RFBWire.preferredChroma(
      codec: codec,
      qualityMode: qualityMode,
      encodings: encodings,
      chroma444Unavailable: chroma444Unavailable)
  }

  private func videoUpdate(
    frame: EncodedVideoFrame,
    codec: MacVideoCodec,
    flags: UInt32
  ) throws -> Data {
    switch codec {
    case .h264:
      try RFBWire.openH264Update(
        width: currentWidth, height: currentHeight, payload: frame.data, flags: flags)
    case .hevc:
      try RFBWire.crabfleetHEVCUpdate(
        width: currentWidth, height: currentHeight, payload: frame.data, flags: flags)
    }
  }

  private var activeVideoEncoder: MacVideoEncoder? {
    withLock { videoEncoder }
  }

  @discardableResult
  private func replaceVideoEncoder(with encoder: MacVideoEncoder?) -> MacVideoEncoder? {
    withLock {
      defer { videoEncoder = encoder }
      return videoEncoder
    }
  }

  private func requestKeyframe() {
    withLock { forceNextKeyframe = true }
  }

  @discardableResult
  private func resetRateController() -> ShareQualityMode {
    withLock {
      rateController = VideoRateController(
        mode: qualityMode,
        chroma: videoEncoder?.activeChroma ?? selectedVideoChroma)
      return qualityMode
    }
  }

  private func beginVideoFrameInterval(for encoder: MacVideoEncoder) throws -> (
    mode: ShareQualityMode,
    targetBitrate: Int,
    generation: UInt64
  ) {
    let result = withLock { () -> (
      mode: ShareQualityMode,
      targetBitrate: Int,
      generation: UInt64,
      qpStatus: OSStatus
    ) in
      rateController = VideoRateController(mode: qualityMode, chroma: encoder.activeChroma)
      frameIntervalGeneration &+= 1
      var qpStatus = noErr
      if videoEncoder === encoder {
        encoder.setAverageBitrate(rateController.targetBitrate)
        qpStatus = encoder.setMaximumFrameQP(qualityMode.maximumFrameQP)
      }
      return (
        qualityMode,
        rateController.targetBitrate,
        frameIntervalGeneration,
        qpStatus)
    }
    guard result.qpStatus == noErr else {
      throw MacVideoEncoderError.propertyRejected(result.qpStatus)
    }
    return (result.mode, result.targetBitrate, result.generation)
  }

  private func applyCurrentTargetBitrate(
    to encoder: MacVideoEncoder,
    multiplier: Int = 1,
    requiresIdleRefreshMode: Bool = false
  ) {
    withLock {
      guard videoEncoder === encoder,
        !requiresIdleRefreshMode || qualityMode != .smooth
      else { return }
      encoder.setAverageBitrate(rateController.targetBitrate * multiplier)
    }
  }

  private func shouldSendIdleRefresh(
    now: Double = ProcessInfo.processInfo.systemUptime
  ) -> Bool {
    idleRefreshPolicy.shouldRefresh(mode: withLock { qualityMode }, timestamp: now)
  }

  private func isFrameIntervalGenerationCurrent(_ generation: UInt64) -> Bool {
    withLock { frameIntervalGeneration == generation }
  }

  private func invalidateFrameIntervalUpdates() {
    withLock { frameIntervalGeneration &+= 1 }
  }

  private func startVideoFrameConsumer(for encoder: MacVideoEncoder) {
    let mailbox = VideoMailbox<MacVideoEncoderOutput>()
    let consumer = Task { [weak self] in
      for await output in encoder.frames {
        // Mailbox overflow is distinct from VideoToolbox's explicit dropped
        // output: either way the next encoded frame must resynchronize.
        mailbox.offer(output, onDrop: { self?.requestKeyframe() })
      }
      mailbox.finish()
    }
    let previous = withLock { () -> (Task<Void, Never>?, VideoMailbox<MacVideoEncoderOutput>?) in
      defer {
        videoFrameConsumer = consumer
        videoFrameMailbox = mailbox
      }
      return (videoFrameConsumer, videoFrameMailbox)
    }
    previous.0?.cancel()
    previous.1?.finish()
  }

  private func stopVideoFrameConsumer() {
    let previous = withLock { () -> (Task<Void, Never>?, VideoMailbox<MacVideoEncoderOutput>?) in
      defer {
        videoFrameConsumer = nil
        videoFrameMailbox = nil
      }
      return (videoFrameConsumer, videoFrameMailbox)
    }
    previous.0?.cancel()
    previous.1?.finish()
  }

  private func consumeForceNextKeyframe() -> Bool {
    withLock {
      defer { forceNextKeyframe = false }
      return forceNextKeyframe
    }
  }

  private func pendingKeyframeRequested() -> Bool {
    withLock { forceNextKeyframe }
  }

  private func consumeQualityModeRefreshRequest() -> Bool {
    withLock {
      defer { qualityModeRefreshRequested = false }
      return qualityModeRefreshRequested
    }
  }

  private enum VideoUpdateOutcome {
    case cursor(SystemCursorSnapshot)
    case frame(EncodedVideoFrame, dirtyAreaFraction: Double)
    case idle
    case chromaFallback
    case failed
  }

  /// Encodes at most one captured frame for this update request. `.idle`
  /// means the screen has not changed (and no keyframe is owed), `.failed`
  /// means the encoder produced no output for a submitted frame.
  private func nextVideoUpdate(
    encoder: MacVideoEncoder,
    allowCursor: Bool
  ) async -> VideoUpdateOutcome {
    if consumeQualityModeRefreshRequest() {
      idleRefreshPolicy.rearmImmediately(timestamp: ProcessInfo.processInfo.systemUptime)
      requestKeyframe()
    }
    let mailboxes = withLock { (videoPixelMailbox, videoFrameMailbox) }
    guard let pixelMailbox = mailboxes.0, let encodedMailbox = mailboxes.1,
      !encodedMailbox.isFinished
    else {
      return .failed
    }

    let ready = await framebufferUpdateArbiter.next(
      videoMailbox: pixelMailbox,
      timeout: .milliseconds(100),
      allowCursor: allowCursor)
    var source: VideoPixelSource?
    switch ready {
    case .cursor(let snapshot): return .cursor(snapshot)
    case .video(let value): source = value
    case .idle: source = nil
    }
    if let candidate = source, !matchesCurrentSize(candidate.pixelBuffer) {
      source = nil  // stale capture output from before a resize
    }
    if let source, source.dirtyAreaFraction > 0 {
      idleRefreshPolicy.recordDirtyArea(
        source.dirtyAreaFraction,
        timestamp: ProcessInfo.processInfo.systemUptime)
    }
    var isIdleRefresh = false
    if source == nil {
      isIdleRefresh = shouldSendIdleRefresh()
      if isIdleRefresh { requestKeyframe() }
    }
    if source == nil, needsContextReset || pendingKeyframeRequested() {
      source = await keyframeSource(idleRefresh: isIdleRefresh)
    }
    guard let source else {
      if isIdleRefresh { idleRefreshPolicy.refreshFailed() }
      return .idle
    }

    let forceKeyframe = consumeForceNextKeyframe() || needsContextReset
    if isIdleRefresh {
      applyCurrentTargetBitrate(to: encoder, multiplier: 2, requiresIdleRefreshMode: true)
    }
    guard
      encoder.encode(
        source.pixelBuffer,
        presentationTime: source.presentationTime,
        forceKeyframe: forceKeyframe)
    else {
      if isIdleRefresh {
        applyCurrentTargetBitrate(to: encoder)
        idleRefreshPolicy.refreshFailed()
      }
      // Rejected input (for example a timestamp raced behind a synthetic
      // keyframe stamp) produces no output; try again on the next request.
      if forceKeyframe { requestKeyframe() }
      return .idle
    }

    while let output = await encodedMailbox.next(timeout: .seconds(1)) {
      if case .chromaFallbackRequired = output {
        return .chromaFallback
      }
      guard case .frame(let frame) = output else {
        requestKeyframe()
        if isIdleRefresh {
          applyCurrentTargetBitrate(to: encoder)
          idleRefreshPolicy.refreshFailed()
        }
        return .idle
      }
      guard frame.width >= currentWidth, frame.height >= currentHeight,
        frame.width <= currentWidth + 15, frame.height <= currentHeight + 15
      else { continue }
      if isIdleRefresh {
        applyCurrentTargetBitrate(to: encoder)
      }
      return .frame(frame, dirtyAreaFraction: source.dirtyAreaFraction)
    }
    if isIdleRefresh {
      applyCurrentTargetBitrate(to: encoder)
      idleRefreshPolicy.refreshFailed()
    }
    return .failed
  }

  /// A source for keyframes owed while the screen is idle: the last streamed
  /// buffer if it still matches, otherwise a one-shot screenshot. Re-encoded
  /// buffers get a fresh host-clock stamp to stay monotonic.
  private func keyframeSource(idleRefresh: Bool) async -> VideoPixelSource? {
    if let cached = capture.latestVideoFrame(), matchesCurrentSize(cached.pixelBuffer) {
      return VideoPixelSource(
        pixelBuffer: cached.pixelBuffer,
        presentationTime: CMClockGetTime(CMClockGetHostTimeClock()),
        dirtyRects: idleRefresh ? [] : nil,
        contentRect: cached.contentRect)
    }
    guard let snapshot = await capture.snapshotVideoFrame(),
      matchesCurrentSize(snapshot.pixelBuffer)
    else {
      return nil
    }
    return VideoPixelSource(
      pixelBuffer: snapshot.pixelBuffer,
      presentationTime: CMClockGetTime(CMClockGetHostTimeClock()),
      dirtyRects: idleRefresh ? [] : nil,
      contentRect: snapshot.contentRect)
  }

  private func matchesCurrentSize(_ pixelBuffer: CVPixelBuffer) -> Bool {
    CVPixelBufferGetWidth(pixelBuffer) == currentWidth
      && CVPixelBufferGetHeight(pixelBuffer) == currentHeight
  }

  private func timedSend(_ data: Data, io: any RFBByteStream) async throws -> Double {
    let clock = ContinuousClock()
    let start = clock.now
    try await io.send(data)
    let duration = start.duration(to: clock.now)
    let components = duration.components
    return Double(components.seconds) + Double(components.attoseconds) / 1e18
  }

  private func recordFrameStats(
    byteCount: Int,
    sendSeconds: Double,
    codec: String,
    hardwareAccelerated: Bool,
    encoder: MacVideoEncoder?,
    dirtyAreaFraction: Double
  ) {
    let now = ProcessInfo.processInfo.systemUptime
    withLock {
      let bitrate = rateController.recordFrame(
        byteCount: byteCount,
        sendSeconds: sendSeconds,
        dirtyAreaFraction: dirtyAreaFraction,
        timestamp: now)
      if let bitrate, let encoder, videoEncoder === encoder {
        encoder.setAverageBitrate(bitrate)
      }
    }
    emitStatsIfDue(
      codec: codec,
      hardwareAccelerated: hardwareAccelerated,
      maximumFrameQPAvailable: encoder?.isMaximumFrameQPAvailable ?? true,
      chroma444Available: !chroma444Unavailable,
      now: now)
  }

  private func emitStatsIfDue(
    codec: String,
    hardwareAccelerated: Bool,
    maximumFrameQPAvailable: Bool = true,
    chroma444Available: Bool = true,
    now: Double = ProcessInfo.processInfo.systemUptime
  ) {
    guard now - lastStatsTimestamp >= 2 else { return }
    lastStatsTimestamp = now
    let (snapshot, targetBitrate) = withLock {
      (rateController.statsSnapshot(now: now), rateController.targetBitrate)
    }
    let codecDetail = TailnetStreamStats.codecDetail(
      codec: codec,
      hardwareAccelerated: hardwareAccelerated,
      maximumFrameQPAvailable: maximumFrameQPAvailable,
      maximumFrameQPRequested: withLock { qualityMode.maximumFrameQP != nil },
      chroma444Available: chroma444Available,
      chroma444Requested: withLock {
        supportsCrabfleetChroma444 && qualityMode != .smooth && supportsCrabfleetHEVC
      })
    eventHandler(
      .streaming(
        TailnetStreamStats(
          codec: codec,
          hardwareAccelerated: hardwareAccelerated,
          codecDetail: codecDetail,
          targetBitrate: targetBitrate,
          dirtyAreaPercent: snapshot.dirtyAreaPercent,
          framesPerSecond: snapshot.fps,
          megabitsPerSecond: snapshot.megabitsPerSecond)))
  }

  private func videoCodecDescription(codec: MacVideoCodec, encoder: MacVideoEncoder) -> String {
    codec == .hevc && encoder.activeChroma == .chroma444 ? "HEVC 4:4:4" : codec == .hevc
      ? "HEVC" : "H.264"
  }

  /// Waits for a frame matching the announced framebuffer size, discarding
  /// stale frames captured before a resize took effect. The store can be
  /// stale after an H.264 fallback on a static screen, so one snapshot
  /// refresh is attempted before giving up.
  private func waitForMatchingFrame() async throws -> CapturedDesktopFrame {
    var didRequestSnapshot = false
    for iteration in 0..<150 {
      if let frame = await capture.frameStore.latest(),
        frame.width == currentWidth,
        frame.height == currentHeight
      {
        return frame
      }
      if iteration >= 25, !didRequestSnapshot {
        didRequestSnapshot = true
        _ = await capture.refreshJPEGFrame()
        continue
      }
      try await Task.sleep(for: .milliseconds(20))
    }
    throw PrivateMacShareError.captureUnavailable
  }

  private func finish(event: TailnetRFBServerEvent) {
    lock.lock()
    guard !finished else {
      lock.unlock()
      return
    }
    finished = true
    let audioIO = pushIO
    let shouldRemoveCursorSession = cursorSessionRegistered
    cursorSessionRegistered = false
    pushIO = nil
    cursorEchoWakeTask?.cancel()
    cursorEchoWakeTask = nil
    lock.unlock()
    framebufferUpdateArbiter.finish()
    stopCursorPath()
    capture.removeVideoFrameHandler(id: sessionID)
    invalidateFrameIntervalUpdates()
    stopVideoFrameConsumer()
    finishPixelMailbox()
    let encoder = replaceVideoEncoder(with: nil)
    encoder?.invalidate()
    inputGate.finish()
    clipboard?.detach(id: sessionID)
    Task { [self] in
      if shouldRemoveCursorSession {
        try? await capture.removeCursorSession(id: sessionID)
      }
      await audioPipelineGate.run { [self] in
        await stopAudioPathNow(sendStop: true, io: audioIO)
      }
      connection?.cancel()
      try? await capture.removeFrameIntervalRequirement(id: sessionID)
      completeFinish(event: event)
    }
  }

  private func completeFinish(event: TailnetRFBServerEvent) {
    eventHandler(event)
    didFinish(self)
  }

  private func withLock<T>(_ body: () -> T) -> T {
    lock.lock()
    defer { lock.unlock() }
    return body()
  }

  private func commitCursorFrameSize(width: Int, height: Int) {
    withLock {
      cursorFrameWidth = width
      cursorFrameHeight = height
      lastCursorImageHash = nil
      lastCursorPosition = nil
      preferCursorPosition = false
      cursorStateGeneration &+= 1
      // Resizing does not change the system cursor, so the 60 Hz monitor's
      // dedup would strand the client on old-geometry cursor state forever;
      // re-offer the unchanged snapshot so it is re-sent with new mapping.
      if let snapshot = latestCursorSnapshot {
        framebufferUpdateArbiter.offerCursor(snapshot)
      }
    }
  }

  private static func address(from endpoint: NWEndpoint?) -> String? {
    guard case .hostPort(let host, _) = endpoint else { return nil }
    let value = String(describing: host)
    return value.split(separator: "%", maxSplits: 1).first.map(String.init)
  }
}

extension RFBWire {
  static func hostClipboardPayload(
    text: String,
    extendedNegotiated: Bool,
    caps: VNCExtendedClipboardCaps?
  ) -> Data? {
    guard extendedNegotiated, let caps, caps.supportsText else {
      // Legacy path: silently skip text that cannot survive Latin-1.
      return legacyServerCutText(text: text)
    }

    let wireByteCount = VNCExtendedClipboard.wireTextByteCount(text)
    switch VNCExtendedClipboard.textRoute(wireByteCount: wireByteCount, caps: caps) {
    case .provide:
      return (try? VNCExtendedClipboard.encodeProvide(text: text)).map {
        VNCExtendedClipboard.frame(messageType: 3, body: $0)
      }
    case .notify:
      return VNCExtendedClipboard.frame(
        messageType: 3,
        body: VNCExtendedClipboard.encodeNotify(hasText: true)
      )
    case .legacy:
      return legacyServerCutText(text: text)
    }
  }
}

struct RFBConnectionIO: RFBByteStream {
  let connection: NWConnection
  private let sendQueue: RFBSendQueue

  init(connection: NWConnection) {
    self.connection = connection
    sendQueue = RFBSendQueue(connection: connection)
  }

  func readExactly(_ count: Int) async throws -> Data {
    guard count >= 0 else {
      throw PrivateMacShareError.protocolError("invalid read size")
    }
    guard count > 0 else { return Data() }

    var result = Data(capacity: count)
    while result.count < count {
      let remaining = count - result.count
      let chunk = try await receive(maximumLength: remaining)
      guard !chunk.isEmpty else {
        throw PrivateMacShareError.protocolError("peer closed the connection")
      }
      result.append(chunk)
    }
    return result
  }

  func send(_ data: Data) async throws {
    try await sendQueue.send(data, deadline: nil)
  }

  func send(_ data: Data, deadline: ContinuousClock.Instant?) async throws {
    try await sendQueue.send(data, deadline: deadline)
  }

  private func receive(maximumLength: Int) async throws -> Data {
    try await withCheckedThrowingContinuation { continuation in
      connection.receive(minimumIncompleteLength: 1, maximumLength: maximumLength) {
        data, _, isComplete, error in
        if let error {
          continuation.resume(throwing: error)
        } else if let data, !data.isEmpty {
          continuation.resume(returning: data)
        } else if isComplete {
          continuation.resume(
            throwing: PrivateMacShareError.protocolError("peer closed the connection")
          )
        } else {
          continuation.resume(returning: Data())
        }
      }
    }
  }
}

actor RFBSendQueue {
  private static let maximumPendingDeadlineSends = 2
  private let sendData: @Sendable (Data) async throws -> Void
  private var tail = Task<Result<Void, Error>, Never> { .success(()) }
  private(set) var pendingDeadlineSendCount = 0

  init(connection: NWConnection) {
    sendData = { data in try await Self.send(data, connection: connection) }
  }

  init(sendData: @escaping @Sendable (Data) async throws -> Void) {
    self.sendData = sendData
  }

  func send(_ data: Data, deadline: ContinuousClock.Instant?) async throws {
    if deadline != nil {
      guard pendingDeadlineSendCount < Self.maximumPendingDeadlineSends else {
        throw RFBSendExpiredError()
      }
      pendingDeadlineSendCount += 1
    }
    let predecessor = tail
    let sendData = sendData
    let waiter = deadline.map { QueuedSendWaiter(deadline: $0) }
    let operation = Task<Result<Void, Error>, Never> {
      defer {
        if waiter != nil {
          pendingDeadlineSendCount -= 1
        }
      }
      _ = await predecessor.value
      guard waiter?.beginSending() != false else { return .success(()) }
      let result: Result<Void, Error>
      do {
        try await sendData(data)
        result = .success(())
      } catch {
        result = .failure(error)
      }
      waiter?.complete(result)
      return result
    }
    tail = operation
    guard let waiter else {
      try await operation.value.get()
      return
    }
    try await waiter.wait()
  }

  private static func send(_ data: Data, connection: NWConnection) async throws {
    try await withCheckedThrowingContinuation {
      (continuation: CheckedContinuation<Void, Error>) in
      connection.send(content: data, completion: .contentProcessed { error in
        if let error {
          continuation.resume(throwing: error)
        } else {
          continuation.resume()
        }
      })
    }
  }
}

final class QueuedSendWaiter: @unchecked Sendable {
  private let lock = NSLock()
  private let deadline: ContinuousClock.Instant
  private let now: @Sendable () -> ContinuousClock.Instant
  private var continuation: CheckedContinuation<Void, Error>?
  private var resolution: Result<Void, Error>?

  init(
    deadline: ContinuousClock.Instant,
    now: @escaping @Sendable () -> ContinuousClock.Instant = { ContinuousClock().now }
  ) {
    self.deadline = deadline
    self.now = now
  }

  func wait() async throws {
    try await withCheckedThrowingContinuation {
      (continuation: CheckedContinuation<Void, Error>) in
      if install(continuation) {
        Task { [self] in
          try? await ContinuousClock().sleep(until: deadline)
          expire()
        }
      }
    }
  }

  func beginSending() -> Bool {
    lock.lock()
    guard resolution == nil else {
      lock.unlock()
      return false
    }
    if now() >= deadline {
      resolution = .failure(RFBSendExpiredError())
      let continuation = continuation
      self.continuation = nil
      lock.unlock()
      continuation?.resume(throwing: RFBSendExpiredError())
      return false
    }
    lock.unlock()
    return true
  }

  func complete(_ result: Result<Void, Error>) {
    lock.lock()
    guard resolution == nil else {
      lock.unlock()
      return
    }
    resolution = result
    let continuation = continuation
    self.continuation = nil
    lock.unlock()
    continuation?.resume(with: result)
  }

  private func install(_ continuation: CheckedContinuation<Void, Error>) -> Bool {
    lock.lock()
    if let resolution {
      lock.unlock()
      continuation.resume(with: resolution)
      return false
    }
    self.continuation = continuation
    lock.unlock()
    return true
  }

  func expire() {
    lock.lock()
    guard resolution == nil else {
      lock.unlock()
      return
    }
    let error = RFBSendExpiredError()
    resolution = .failure(error)
    let continuation = continuation
    self.continuation = nil
    lock.unlock()
    continuation?.resume(throwing: error)
  }
}

struct RFBSendExpiredError: LocalizedError {
  var errorDescription: String? { "RFB send expired before transmission" }
}

private actor AudioPipelineGate {
  private var tail = Task<Void, Never> {}

  func run(_ operation: @escaping @Sendable () async -> Void) async {
    let predecessor = tail
    let task = Task {
      await predecessor.value
      await operation()
    }
    tail = task
    await task.value
  }
}
