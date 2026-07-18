import Foundation
import Testing

@testable import CrabfleetMac

struct RFBAuthenticationTests {
  @Test
  func shareAccessCodesAreRandomTwelveCharacterAlphanumerics() throws {
    let first = try ShareAccessCodeGenerator.generate()
    let second = try ShareAccessCodeGenerator.generate()

    #expect(first.count == 12)
    #expect(first.allSatisfy { $0.isASCII && $0.isLetter || $0.isNumber })
    #expect(first != second)
  }

  @Test
  func throttleAppliesExponentialDelayAndThirtySecondLockout() {
    let clock = TestAuthClock()
    let throttle = RFBAuthThrottle(now: { clock.value })
    let source = "100.64.0.10"

    #expect(throttle.decision(for: source).delaySeconds == 0)
    for expectedDelay in [1.0, 2.0, 4.0, 8.0] {
      throttle.recordFailure(for: source)
      #expect(throttle.decision(for: source).delaySeconds == expectedDelay)
    }
    throttle.recordFailure(for: source)
    #expect(throttle.decision(for: source).lockoutSeconds == 30)

    clock.value = 29
    #expect(throttle.decision(for: source).lockoutSeconds == 1)
    clock.value = 30
    #expect(throttle.decision(for: source) == .init(delaySeconds: 0, lockoutSeconds: 0))
  }

  @Test
  func throttleResetsOnSuccessAndKeepsBoundedSourceState() {
    let throttle = RFBAuthThrottle(capacity: 2)
    throttle.recordFailure(for: "100.64.0.1")
    throttle.recordFailure(for: "100.64.0.2")
    throttle.recordFailure(for: "100.64.0.3")
    #expect(throttle.trackedSourceCount == 2)

    throttle.recordSuccess(for: "100.64.0.3")
    #expect(throttle.decision(for: "100.64.0.3").delaySeconds == 0)
    #expect(throttle.trackedSourceCount == 1)
  }

  @Test
  func throttleBoundsConcurrentAttemptsWithoutSingleFlight() {
    let throttle = RFBAuthThrottle()
    let source = "100.64.0.19"

    for _ in 0..<RFBAuthThrottle.maximumConcurrentAttemptsPerSource {
      #expect(!throttle.beginAttempt(for: source).concurrencyLimitReached)
    }
    #expect(throttle.beginAttempt(for: source).concurrencyLimitReached)
    for _ in 0..<RFBAuthThrottle.maximumConcurrentAttemptsPerSource {
      throttle.cancelAttempt(for: source)
    }
    #expect(!throttle.beginAttempt(for: source).concurrencyLimitReached)
    throttle.cancelAttempt(for: source)
  }

  @Test
  func expiredLockoutPreservesOutstandingAttemptCount() {
    let clock = TestAuthClock()
    let throttle = RFBAuthThrottle(now: { clock.value })
    let source = "100.64.0.18"
    for _ in 0..<RFBAuthThrottle.maximumConcurrentAttemptsPerSource {
      #expect(!throttle.beginAttempt(for: source).concurrencyLimitReached)
    }
    for _ in 0..<RFBAuthThrottle.maximumFailures {
      throttle.recordFailure(for: source)
    }
    #expect(throttle.decision(for: source).lockoutSeconds == 30)

    clock.value = 30
    #expect(throttle.decision(for: source) == .init(delaySeconds: 0, lockoutSeconds: 0))
    for _ in 0..<RFBAuthThrottle.maximumFailures {
      #expect(!throttle.beginAttempt(for: source).concurrencyLimitReached)
    }
    #expect(throttle.beginAttempt(for: source).concurrencyLimitReached)
  }

  @Test
  func tailnetAuthenticationOffersARDThenVNCAndRejectsNone() async {
    let stream = AuthenticationTestStream(incoming: Data([1]))
    let authentication = RFBListenerAuthentication(
      credentialProvider: { "test-auth-token" },
      throttle: RFBAuthThrottle())

    await #expect(throws: (any Error).self) {
      try await authentication.authenticate(
        version: .v3Point8,
        source: "100.64.0.4",
        io: stream)
    }
    #expect(stream.outgoing == Data([2, 30, 2]))
  }

  @Test
  func tailnetVNCAuthenticationMatchesForkVectorInBothDirections() async throws {
    let challenge = Data(0..<16)
    let response = Data([
      0x8A, 0x5F, 0xA9, 0x58, 0xF0, 0xD8, 0x19, 0xBD,
      0xCB, 0x98, 0x1C, 0x9B, 0x47, 0x63, 0x6E, 0xD0,
    ])
    let stream = AuthenticationTestStream(incoming: Data([2]) + response)
    let authentication = RFBListenerAuthentication(
      credentialProvider: { "test-auth-token" },
      throttle: RFBAuthThrottle(),
      challengeProvider: { challenge })

    try await authentication.authenticate(
      version: .v3Point8,
      source: "100.64.0.5",
      io: stream)

    #expect(stream.outgoing == Data([2, 30, 2]) + challenge + Data([0, 0, 0, 0]))
  }

  @Test
  func failedAuthenticationFeedsThrottleAndReturnsRFB38Reason() async {
    let challenge = Data(0..<16)
    let throttle = RFBAuthThrottle()
    let stream = AuthenticationTestStream(
      incoming: Data([2]) + Data(repeating: 0, count: 16))
    let authentication = RFBListenerAuthentication(
      credentialProvider: { "test-auth-token" },
      throttle: throttle,
      challengeProvider: { challenge })

    await #expect(throws: (any Error).self) {
      try await authentication.authenticate(
        version: .v3Point8,
        source: "100.64.0.6",
        io: stream)
    }
    #expect(throttle.decision(for: "100.64.0.6").delaySeconds == 1)
    #expect(stream.outgoing.starts(with: Data([2, 30, 2]) + challenge + Data([0, 0, 0, 1])))
  }

  @Test(.timeLimit(.minutes(1)))
  func concurrentAuthenticationsFromOneSourceBothCheckCredentials() async throws {
    let challenge = Data(0..<16)
    let response = Data([
      0x8A, 0x5F, 0xA9, 0x58, 0xF0, 0xD8, 0x19, 0xBD,
      0xCB, 0x98, 0x1C, 0x9B, 0x47, 0x63, 0x6E, 0xD0,
    ])
    let gate = AuthenticationReadGate()
    let probe = AuthenticationCredentialProbe()
    let authentication = RFBListenerAuthentication(
      credentialProvider: { probe.credential() },
      throttle: RFBAuthThrottle(),
      challengeProvider: { challenge })
    let firstStream = AuthenticationTestStream(
      incoming: Data([2]) + response,
      responseGate: gate)
    let first = Task {
      try await authentication.authenticate(
        version: .v3Point8,
        source: "100.64.0.20",
        io: firstStream)
    }
    defer {
      gate.open()
      first.cancel()
    }

    let clock = ContinuousClock()
    let deadline = clock.now.advanced(by: .seconds(2))
    while !gate.hasReached, clock.now < deadline {
      try await Task.sleep(for: .milliseconds(10))
    }
    #expect(gate.hasReached)
    guard gate.hasReached else { return }
    let secondStream = AuthenticationTestStream(incoming: Data([2]) + response)
    try await authentication.authenticate(
      version: .v3Point8,
      source: "100.64.0.20",
      io: secondStream)
    #expect(probe.count == 1)

    gate.open()
    try await first.value
    #expect(probe.count == 2)
  }

  @Test
  func fiveFailuresLockOutTheSixthAuthentication() async {
    let source = "100.64.0.21"
    let throttle = RFBAuthThrottle()
    for _ in 0..<RFBAuthThrottle.maximumFailures {
      throttle.recordFailure(for: source)
    }
    let probe = AuthenticationCredentialProbe()
    let stream = AuthenticationTestStream(incoming: Data())
    let authentication = RFBListenerAuthentication(
      credentialProvider: { probe.credential() },
      throttle: throttle)

    await #expect(throws: (any Error).self) {
      try await authentication.authenticate(
        version: .v3Point8,
        source: source,
        io: stream)
    }
    let reason = "Too many authentication attempts; retry later."
    #expect(stream.outgoing.first == 0)
    #expect(stream.outgoing.suffix(reason.utf8.count) == Data(reason.utf8))
    #expect(probe.count == 0)
  }
}

private final class TestAuthClock: @unchecked Sendable {
  private let lock = NSLock()
  private var timestamp: TimeInterval = 0

  var value: TimeInterval {
    get {
      lock.lock()
      defer { lock.unlock() }
      return timestamp
    }
    set {
      lock.lock()
      timestamp = newValue
      lock.unlock()
    }
  }
}

private final class AuthenticationTestStream: RFBByteStream, @unchecked Sendable {
  private let lock = NSLock()
  private let responseGate: AuthenticationReadGate?
  private var incoming: Data
  private var sent = Data()

  init(incoming: Data, responseGate: AuthenticationReadGate? = nil) {
    self.incoming = incoming
    self.responseGate = responseGate
  }

  var outgoing: Data {
    lock.lock()
    defer { lock.unlock() }
    return sent
  }

  func readExactly(_ count: Int) async throws -> Data {
    if count == 16 {
      await responseGate?.wait()
    }
    return try withLock {
      guard count >= 0, incoming.count >= count else {
        throw PrivateMacShareError.protocolError("test stream ended")
      }
      let result = Data(incoming.prefix(count))
      incoming.removeFirst(count)
      return result
    }
  }

  func send(_ data: Data) async throws {
    withLock { sent.append(data) }
  }

  func send(_ data: Data, deadline: ContinuousClock.Instant?) async throws {
    try await send(data)
  }

  private func withLock<T>(_ body: () throws -> T) rethrows -> T {
    lock.lock()
    defer { lock.unlock() }
    return try body()
  }
}

private final class AuthenticationCredentialProbe: @unchecked Sendable {
  private let lock = NSLock()
  private var checks = 0

  var count: Int {
    lock.lock()
    defer { lock.unlock() }
    return checks
  }

  func credential() -> String {
    lock.lock()
    checks += 1
    lock.unlock()
    return "test-auth-token"
  }
}

private final class AuthenticationReadGate: @unchecked Sendable {
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
