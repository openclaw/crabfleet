import Foundation

protocol RelayWebSocketTasking: AnyObject, Sendable {
  func resume()
  func receive() async throws -> URLSessionWebSocketTask.Message
  func send(_ message: URLSessionWebSocketTask.Message) async throws
  func cancel(with closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?)
}

extension URLSessionWebSocketTask: RelayWebSocketTasking {}

final class RelayWebSocketByteStream: RFBByteStream, @unchecked Sendable {
  nonisolated static let sendChunkBytes = 256 * 1_024
  nonisolated static let maximumMessageBytes = 512 * 1_024

  private let task: any RelayWebSocketTasking
  private let sendQueue: RFBSendQueue
  private let lock = NSLock()
  private var buffered = Data()

  init(task: any RelayWebSocketTasking) {
    self.task = task
    sendQueue = RFBSendQueue { data in
      var offset = 0
      while offset < data.count {
        let end = min(offset + Self.sendChunkBytes, data.count)
        try await task.send(.data(data.subdata(in: offset..<end)))
        offset = end
      }
    }
  }

  func readExactly(_ count: Int) async throws -> Data {
    guard count >= 0 else {
      throw PrivateMacShareError.protocolError("invalid read size")
    }
    guard count > 0 else { return Data() }

    while bufferedCount < count {
      try await receiveBinaryMessage()
    }
    return consume(count)
  }

  func waitForIncomingData() async throws {
    while bufferedCount == 0 {
      try await receiveBinaryMessage()
    }
  }

  func send(_ data: Data) async throws {
    try await sendQueue.send(data, deadline: nil)
  }

  func send(_ data: Data, deadline: ContinuousClock.Instant?) async throws {
    try await sendQueue.send(data, deadline: deadline)
  }

  func cancel() {
    task.cancel(with: .goingAway, reason: nil)
  }

  private var bufferedCount: Int {
    withLock { buffered.count }
  }

  private func append(_ data: Data) {
    withLock { buffered.append(data) }
  }

  private func receiveBinaryMessage() async throws {
    let message = try await task.receive()
    guard case .data(let data) = message, data.count <= Self.maximumMessageBytes else {
      throw PrivateMacShareError.protocolError("relay requires bounded binary messages")
    }
    append(data)
  }

  private func consume(_ count: Int) -> Data {
    withLock {
      let result = buffered.prefix(count)
      buffered.removeFirst(count)
      return Data(result)
    }
  }

  private func withLock<T>(_ body: () -> T) -> T {
    lock.lock()
    defer { lock.unlock() }
    return body()
  }
}

final class RelayHostPublisher: @unchecked Sendable {
  typealias EventHandler = @Sendable (TailnetRFBServerEvent) -> Void
  typealias TaskFactory = @Sendable (URLRequest) -> any RelayWebSocketTasking

  private let endpoint: URL
  private let relayAccess: String
  private let capture: MacScreenCapture
  private let descriptor: CapturedDisplayDescriptor
  private let input: any RemoteInputForwarding
  private let clipboard: (any HostClipboardSyncing)?
  private let sessionGate: RFBHostSessionGate
  private let eventHandler: EventHandler
  private let taskFactory: TaskFactory
  private let lock = NSLock()
  private var active = false
  private var viewOnly = false
  private var audioEnabled = true
  private var qualityMode: ShareQualityMode = .auto
  private var publisherTask: Task<Void, Never>?
  private var webSocketTask: (any RelayWebSocketTasking)?
  private var session: RFBHostSession?

  init(
    endpoint: URL,
    relayAccess: String,
    capture: MacScreenCapture,
    descriptor: CapturedDisplayDescriptor,
    input: any RemoteInputForwarding,
    clipboard: (any HostClipboardSyncing)?,
    sessionGate: RFBHostSessionGate,
    eventHandler: @escaping EventHandler,
    taskFactory: @escaping TaskFactory = { URLSession.shared.webSocketTask(with: $0) }
  ) {
    self.endpoint = endpoint
    self.relayAccess = relayAccess
    self.capture = capture
    self.descriptor = descriptor
    self.input = input
    self.clipboard = clipboard
    self.sessionGate = sessionGate
    self.eventHandler = eventHandler
    self.taskFactory = taskFactory
  }

  func start() {
    let shouldStart = withLock { () -> Bool in
      guard !active else { return false }
      active = true
      return true
    }
    guard shouldStart else { return }
    let task = Task { [weak self] in
      guard let self else { return }
      await self.run()
    }
    withLock { publisherTask = task }
  }

  func stop() {
    let values = withLock { () -> (Task<Void, Never>?, RFBHostSession?, (any RelayWebSocketTasking)?) in
      active = false
      defer {
        publisherTask = nil
        session = nil
        webSocketTask = nil
      }
      return (publisherTask, session, webSocketTask)
    }
    values.0?.cancel()
    values.1?.stop()
    values.2?.cancel(with: .goingAway, reason: nil)
  }

  func setViewOnly(_ enabled: Bool) {
    let activeSession = withLock { () -> RFBHostSession? in
      viewOnly = enabled
      return session
    }
    activeSession?.setViewOnly(enabled)
  }

  func setAudioEnabled(_ enabled: Bool) {
    let activeSession = withLock { () -> RFBHostSession? in
      audioEnabled = enabled
      return session
    }
    activeSession?.setAudioEnabled(enabled)
  }

  @discardableResult
  func setQualityMode(
    _ mode: ShareQualityMode,
    completion: (@Sendable (Bool) -> Void)? = nil
  ) -> Bool {
    withLock {
      guard let activeSession = session else {
        qualityMode = mode
        if let completion { Task { completion(true) } }
        return true
      }
      let previousMode = qualityMode
      let accepted = activeSession.setQualityMode(
        mode,
        completion: { [weak self, weak activeSession] accepted in
          guard let self else {
            completion?(true)
            return
          }
          var resolved = accepted
          if !accepted {
            self.withLock {
              guard self.session === activeSession else {
                resolved = true
                return
              }
              if self.qualityMode == mode {
                self.qualityMode = previousMode
              }
            }
          }
          completion?(resolved)
        })
      guard accepted else { return false }
      qualityMode = mode
      return true
    }
  }

  private func run() async {
    var delay = Duration.seconds(1)
    while isActive, !Task.isCancelled {
      let connected = await runConnection()
      guard isActive, !Task.isCancelled else { return }
      if connected { delay = .seconds(1) }
      do {
        try await Task.sleep(for: delay)
      } catch {
        return
      }
      if !connected { delay = min(delay * 2, .seconds(30)) }
    }
  }

  private func runConnection() async -> Bool {
    var request = URLRequest(url: endpoint)
    request.timeoutInterval = 30
    request.setValue(relayAccess, forHTTPHeaderField: "X-Crabfleet-Ownership-Token")
    let socket = taskFactory(request)
    let shouldRun = withLock { () -> Bool in
      guard active, !Task.isCancelled else { return false }
      webSocketTask = socket
      socket.resume()
      return true
    }
    guard shouldRun else {
      socket.cancel(with: .goingAway, reason: nil)
      return false
    }

    let baseStream = RelayWebSocketByteStream(task: socket)
    let sessionID = UUID()
    let stream = SessionClaimingRFBByteStream(
      base: baseStream,
      gate: sessionGate,
      onAcquire: { [weak capture] in capture?.retainConsumer(id: sessionID) },
      onRelease: { [weak capture] in capture?.releaseConsumer(id: sessionID) }
    )
    let connected = ThreadSafeRelayConnectionState()

    await withCheckedContinuation { continuation in
      let hostSession = RFBHostSession(
        byteStream: stream,
        capture: capture,
        descriptor: descriptor,
        input: input,
        clipboard: clipboard,
        desktopSizeProvider: { [sessionGate, descriptor] in
          sessionGate.descriptor(basedOn: descriptor)
        },
        remoteAddressOverride: "Crabfleet browser",
        skipTailnetCheck: true,
        desktopName: "Crabfleet — \(Host.current().localizedName ?? "Mac")",
        handshakeTimeout: nil,
        viewOnly: true,
        audioEnabled: false,
        qualityMode: .auto,
        sessionID: sessionID,
        beginResize: { [sessionGate] in sessionGate.beginResize() },
        finishResize: { [sessionGate] width, height in
          sessionGate.finishResize(width: width, height: height)
        },
        didAuthorize: {},
        eventHandler: { [eventHandler] event in
          if case .connected = event {
            stream.finishHandshake()
            connected.markConnected()
          }
          if !connected.value {
            if case .disconnected = event { return }
            if case .sessionFailed(let message) = event,
              message.contains("RFB handshake timed out")
            {
              return
            }
          }
          if case .disconnected = event { connected.markDisconnected() }
          eventHandler(event)
        },
        didFinish: { [weak self, eventHandler] finishedSession in
          stream.finishClaim()
          if connected.consumeSyntheticDisconnect() {
            eventHandler(.disconnected(count: 0, remainingPeer: nil))
          }
          socket.cancel(with: .normalClosure, reason: nil)
          self?.clear(finishedSession, socket: socket)
          continuation.resume()
        }
      )
      let shouldRun = withLock { () -> Bool in
        guard active, !Task.isCancelled else { return false }
        session = hostSession
        hostSession.setViewOnly(viewOnly)
        hostSession.setAudioEnabled(audioEnabled)
        hostSession.setQualityMode(qualityMode)
        return true
      }
      if shouldRun {
        hostSession.start()
      } else {
        hostSession.stop()
      }
    }
    return connected.value
  }

  private func clear(_ finishedSession: RFBHostSession, socket: any RelayWebSocketTasking) {
    withLock {
      if session === finishedSession { session = nil }
      if sameTask(webSocketTask, socket) { webSocketTask = nil }
    }
  }

  private var isActive: Bool { withLock { active } }

  private func sameTask(
    _ lhs: (any RelayWebSocketTasking)?,
    _ rhs: any RelayWebSocketTasking
  ) -> Bool {
    guard let lhs else { return false }
    return (lhs as AnyObject) === (rhs as AnyObject)
  }

  private func withLock<T>(_ body: () -> T) -> T {
    lock.lock()
    defer { lock.unlock() }
    return body()
  }
}

final class SessionClaimingRFBByteStream: RFBByteStream, @unchecked Sendable {
  private let base: RelayWebSocketByteStream
  private let gate: RFBHostSessionGate
  private let onAcquire: @Sendable () -> Void
  private let onRelease: @Sendable () -> Void
  private let lock = NSLock()
  private var claim: UUID?
  private var finished = false
  private var handshakeDeadline: ContinuousClock.Instant?

  init(
    base: RelayWebSocketByteStream,
    gate: RFBHostSessionGate,
    onAcquire: @escaping @Sendable () -> Void,
    onRelease: @escaping @Sendable () -> Void
  ) {
    self.base = base
    self.gate = gate
    self.onAcquire = onAcquire
    self.onRelease = onRelease
  }

  func readExactly(_ count: Int) async throws -> Data {
    let needsClaim = try withLock { () throws -> Bool in
      guard !finished else { throw CancellationError() }
      return claim == nil
    }
    if needsClaim {
      try await base.waitForIncomingData()
      try acquireIfNeeded()
    }
    guard let deadline = withLock({ handshakeDeadline }) else {
      return try await base.readExactly(count)
    }
    return try await readExactly(count, before: deadline)
  }

  func send(_ data: Data) async throws {
    try await base.send(data)
  }

  func send(_ data: Data, deadline: ContinuousClock.Instant?) async throws {
    try await base.send(data, deadline: deadline)
  }

  func finishClaim() {
    let released = withLock { () -> UUID? in
      if claim != nil { onRelease() }
      let value = claim
      claim = nil
      finished = true
      handshakeDeadline = nil
      return value
    }
    if let released {
      gate.release(released)
    }
  }

  func finishHandshake() {
    withLock { handshakeDeadline = nil }
  }

  private func readExactly(_ count: Int, before deadline: ContinuousClock.Instant) async throws
    -> Data
  {
    try await withThrowingTaskGroup(of: Data.self) { group in
      group.addTask { try await self.base.readExactly(count) }
      group.addTask {
        try await Task.sleep(until: deadline, clock: .continuous)
        self.base.cancel()
        throw PrivateMacShareError.protocolError("RFB handshake timed out")
      }
      defer { group.cancelAll() }
      guard let data = try await group.next() else { throw CancellationError() }
      return data
    }
  }

  private func acquireIfNeeded() throws {
    try withLock {
      guard !finished else { throw CancellationError() }
      if claim != nil { return }
      guard let next = gate.acquire() else {
        throw PrivateMacShareError.protocolError("the desktop viewer limit is reached")
      }
      claim = next
      handshakeDeadline = .now.advanced(by: .seconds(30))
      onAcquire()
    }
  }

  private func withLock<T>(_ body: () throws -> T) rethrows -> T {
    lock.lock()
    defer { lock.unlock() }
    return try body()
  }
}

private final class ThreadSafeRelayConnectionState: @unchecked Sendable {
  private let lock = NSLock()
  private var connected = false
  private var disconnected = false

  var value: Bool {
    lock.lock()
    defer { lock.unlock() }
    return connected
  }

  func markConnected() {
    lock.lock()
    connected = true
    lock.unlock()
  }

  func markDisconnected() {
    lock.lock()
    disconnected = true
    lock.unlock()
  }

  func consumeSyntheticDisconnect() -> Bool {
    lock.lock()
    defer { lock.unlock() }
    guard connected, !disconnected else { return false }
    disconnected = true
    return true
  }
}
