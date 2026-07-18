import Foundation
import RoyalVNCKit
import Security

enum ShareAccessCodeGenerator {
  static let length = 12
  private static let alphabet = Array("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789".utf8)
  private static let unbiasedLimit = UInt8.max - (UInt8.max % UInt8(alphabet.count))

  static func generate() throws -> String {
    var result = [UInt8]()
    result.reserveCapacity(length)
    while result.count < length {
      var random = [UInt8](repeating: 0, count: 32)
      let generated = random.withUnsafeMutableBytes { bytes in
        guard let address = bytes.baseAddress else { return false }
        return SecRandomCopyBytes(kSecRandomDefault, bytes.count, address) == errSecSuccess
      }
      guard generated else {
        throw ShareAccessCodeError.randomGenerationFailed
      }
      for byte in random where byte < unbiasedLimit {
        result.append(alphabet[Int(byte) % alphabet.count])
        if result.count == length { break }
      }
    }
    return String(decoding: result, as: UTF8.self)
  }
}

enum ShareAccessCodeError: LocalizedError {
  case randomGenerationFailed

  var errorDescription: String? {
    "Crabfleet could not generate a secure sharing password."
  }
}

actor RFBARDPrewarmer {
  static let shared = RFBARDPrewarmer()

  private var preparation: Task<Void, any Error>?

  func prepare() async throws {
    if let preparation {
      return try await preparation.value
    }
    let preparation = Task {
      try await withCheckedThrowingContinuation { continuation in
        DispatchQueue.global(qos: .userInitiated).async {
          do {
            try VNCARDHostAuthentication.prewarm()
            continuation.resume()
          } catch {
            continuation.resume(throwing: error)
          }
        }
      }
    }
    self.preparation = preparation
    do {
      try await preparation.value
    } catch {
      self.preparation = nil
      throw error
    }
  }
}

final class ShareAccessState: @unchecked Sendable {
  private let lock = NSLock()
  private var value = ""

  func replace(with value: String) {
    lock.lock()
    self.value = value
    lock.unlock()
  }

  func clear() {
    replace(with: "")
  }

  var current: String {
    lock.lock()
    defer { lock.unlock() }
    return value
  }
}

struct RFBAuthThrottleDecision: Equatable, Sendable {
  let delaySeconds: TimeInterval
  let lockoutSeconds: TimeInterval
  var concurrencyLimitReached = false

  var isLocked: Bool { lockoutSeconds > 0 }
}

final class RFBAuthThrottle: @unchecked Sendable {
  private struct Entry {
    var failures: Int
    var lockedUntil: TimeInterval?
    var inFlight: Int
  }

  static let defaultCapacity = 1_024
  static let maximumConcurrentAttemptsPerSource = 16
  static let maximumFailures = 5
  static let lockoutDuration: TimeInterval = 30

  private let capacity: Int
  private let now: @Sendable () -> TimeInterval
  private let lock = NSLock()
  private var entries: [String: Entry] = [:]
  private var order: [String] = []

  init(
    capacity: Int = defaultCapacity,
    now: @escaping @Sendable () -> TimeInterval = {
      Date.timeIntervalSinceReferenceDate
    }
  ) {
    precondition(capacity > 0)
    self.capacity = capacity
    self.now = now
  }

  func decision(for source: String) -> RFBAuthThrottleDecision {
    lock.lock()
    defer { lock.unlock() }
    guard var entry = entries[source] else {
      return RFBAuthThrottleDecision(delaySeconds: 0, lockoutSeconds: 0)
    }
    let timestamp = now()
    if let lockedUntil = entry.lockedUntil {
      let remaining = lockedUntil - timestamp
      if remaining > 0 {
        touch(source)
        return RFBAuthThrottleDecision(delaySeconds: 0, lockoutSeconds: remaining)
      }
      entry.failures = 0
      entry.lockedUntil = nil
      if entry.inFlight == 0 {
        remove(source)
      } else {
        entries[source] = entry
        touch(source)
      }
      return RFBAuthThrottleDecision(delaySeconds: 0, lockoutSeconds: 0)
    }
    touch(source)
    let delay = pow(2, Double(max(0, entry.failures - 1)))
    return RFBAuthThrottleDecision(delaySeconds: delay, lockoutSeconds: 0)
  }

  func beginAttempt(for source: String) -> RFBAuthThrottleDecision {
    lock.lock()
    defer { lock.unlock() }
    let timestamp = now()
    if var entry = entries[source] {
      if let lockedUntil = entry.lockedUntil {
        let remaining = lockedUntil - timestamp
        if remaining > 0 {
          touch(source)
          return RFBAuthThrottleDecision(delaySeconds: 0, lockoutSeconds: remaining)
        }
        entry.failures = 0
        entry.lockedUntil = nil
        if entry.inFlight >= Self.maximumConcurrentAttemptsPerSource {
          entries[source] = entry
          touch(source)
          return RFBAuthThrottleDecision(
            delaySeconds: 0,
            lockoutSeconds: 0,
            concurrencyLimitReached: true)
        }
        entry.inFlight += 1
        entries[source] = entry
        touch(source)
        return RFBAuthThrottleDecision(delaySeconds: 0, lockoutSeconds: 0)
      } else if entry.inFlight >= Self.maximumConcurrentAttemptsPerSource {
        touch(source)
        return RFBAuthThrottleDecision(
          delaySeconds: 0,
          lockoutSeconds: 0,
          concurrencyLimitReached: true)
      } else {
        entry.inFlight += 1
        entries[source] = entry
        touch(source)
        let delay = pow(2, Double(max(0, entry.failures - 1)))
        return RFBAuthThrottleDecision(delaySeconds: delay, lockoutSeconds: 0)
      }
    }

    while entries.count >= capacity,
      let evictable = order.first(where: { entries[$0]?.inFlight == 0 })
    {
      remove(evictable)
    }
    guard entries.count < capacity else {
      return RFBAuthThrottleDecision(
        delaySeconds: 0,
        lockoutSeconds: 0,
        concurrencyLimitReached: true)
    }
    entries[source] = Entry(failures: 0, lockedUntil: nil, inFlight: 1)
    touch(source)
    return RFBAuthThrottleDecision(delaySeconds: 0, lockoutSeconds: 0)
  }

  func recordFailure(for source: String) {
    lock.lock()
    defer { lock.unlock() }
    var entry = entries[source] ?? Entry(failures: 0, lockedUntil: nil, inFlight: 0)
    entry.inFlight = max(0, entry.inFlight - 1)
    entry.failures += 1
    if entry.failures >= Self.maximumFailures {
      entry.lockedUntil = now() + Self.lockoutDuration
    }
    entries[source] = entry
    touch(source)
    while entries.count > capacity, let oldest = order.first {
      remove(oldest)
    }
  }

  func recordSuccess(for source: String) {
    lock.lock()
    guard var entry = entries[source] else {
      lock.unlock()
      return
    }
    entry.inFlight = max(0, entry.inFlight - 1)
    entry.failures = 0
    entry.lockedUntil = nil
    if entry.inFlight == 0 {
      remove(source)
    } else {
      entries[source] = entry
      touch(source)
    }
    lock.unlock()
  }

  func cancelAttempt(for source: String) {
    lock.lock()
    guard var entry = entries[source], entry.inFlight > 0 else {
      lock.unlock()
      return
    }
    entry.inFlight -= 1
    if entry.inFlight == 0, entry.failures == 0, entry.lockedUntil == nil {
      remove(source)
    } else {
      entries[source] = entry
      touch(source)
    }
    lock.unlock()
  }

  func reset() {
    lock.lock()
    entries = entries.compactMapValues { entry in
      entry.inFlight > 0
        ? Entry(failures: 0, lockedUntil: nil, inFlight: entry.inFlight)
        : nil
    }
    order.removeAll { entries[$0] == nil }
    lock.unlock()
  }

  var trackedSourceCount: Int {
    lock.lock()
    defer { lock.unlock() }
    return entries.count
  }

  private func touch(_ source: String) {
    order.removeAll { $0 == source }
    order.append(source)
  }

  private func remove(_ source: String) {
    entries.removeValue(forKey: source)
    order.removeAll { $0 == source }
  }
}

protocol RFBListenerAuthenticating: Sendable {
  func authenticate(
    version: RFBVersion,
    source: String,
    io: any RFBByteStream
  ) async throws
}

enum RFBSessionSecurity: Sendable {
  case listener(any RFBListenerAuthenticating)
  case relay(AuthenticatedRelayRFBBypass)
}

final class RFBListenerAuthentication: RFBListenerAuthenticating, @unchecked Sendable {
  typealias ChallengeProvider = @Sendable () throws -> Data
  typealias ARDProvider = @Sendable () throws -> VNCARDHostAuthentication

  private let credentialProvider: @Sendable () -> String
  private let throttle: RFBAuthThrottle
  private let challengeProvider: ChallengeProvider
  private let ardProvider: ARDProvider

  init(
    credentialProvider: @escaping @Sendable () -> String,
    throttle: RFBAuthThrottle,
    challengeProvider: @escaping ChallengeProvider = {
      try VNCHostAuthentication.makeChallenge()
    },
    ardProvider: @escaping ARDProvider = {
      try VNCARDHostAuthentication()
    }
  ) {
    self.credentialProvider = credentialProvider
    self.throttle = throttle
    self.challengeProvider = challengeProvider
    self.ardProvider = ardProvider
  }

  func authenticate(
    version: RFBVersion,
    source: String,
    io: any RFBByteStream
  ) async throws {
    let decision = throttle.beginAttempt(for: source)
    if decision.isLocked || decision.concurrencyLimitReached {
      try await sendNegotiationFailure(
        version: version,
        reason: decision.isLocked
          ? "Too many authentication attempts; retry later."
          : "Too many concurrent authentication attempts; retry later.",
        io: io)
      throw PrivateMacShareError.protocolError("RFB authentication attempt was throttled")
    }
    var completed = false
    defer {
      if !completed { throttle.cancelAttempt(for: source) }
    }
    if decision.delaySeconds > 0 {
      try await Task.sleep(for: .seconds(decision.delaySeconds))
    }

    let selected: UInt8
    if version == .v3Point3 {
      selected = 2
      var security = Data()
      security.appendBigEndian(UInt32(selected))
      try await io.send(security)
    } else {
      try await io.send(Data([2, 30, 2]))
      selected = try await io.readUInt8()
      guard selected == 30 || selected == 2 else {
        throw PrivateMacShareError.protocolError("unsupported RFB security selection")
      }
    }

    let accepted: Bool
    switch selected {
    case 30:
      let ard = try ardProvider()
      try await io.send(ard.challenge)
      let response = try await io.readExactly(VNCARDHostAuthentication.responseLength)
      accepted = ard.verifies(response: response, candidate: credentialProvider())
    case 2:
      let challenge = try challengeProvider()
      guard challenge.count == VNCHostAuthentication.challengeLength else {
        throw PrivateMacShareError.protocolError("invalid VNC authentication challenge")
      }
      try await io.send(challenge)
      let response = try await io.readExactly(VNCHostAuthentication.challengeLength)
      accepted = VNCHostAuthentication.verifies(
        response: response,
        challenge: challenge,
        candidate: credentialProvider())
    default:
      throw PrivateMacShareError.protocolError("unsupported RFB security selection")
    }

    if accepted {
      completed = true
      throttle.recordSuccess(for: source)
      try await sendSecurityResult(status: 0, version: version, reason: nil, io: io)
      return
    }

    completed = true
    throttle.recordFailure(for: source)
    try await sendSecurityResult(
      status: 1,
      version: version,
      reason: "Authentication failed.",
      io: io)
    throw PrivateMacShareError.protocolError("RFB authentication failed")
  }

  private func sendNegotiationFailure(
    version: RFBVersion,
    reason: String,
    io: any RFBByteStream
  ) async throws {
    var failure = Data()
    if version == .v3Point3 {
      failure.appendBigEndian(UInt32(0))
    } else {
      failure.append(0)
    }
    let encoded = Data(reason.utf8)
    failure.appendBigEndian(UInt32(encoded.count))
    failure.append(encoded)
    try await io.send(failure)
  }

  private func sendSecurityResult(
    status: UInt32,
    version: RFBVersion,
    reason: String?,
    io: any RFBByteStream
  ) async throws {
    var result = Data()
    result.appendBigEndian(status)
    if status != 0, version >= .v3Point8, let reason {
      let encoded = Data(reason.utf8)
      result.appendBigEndian(UInt32(encoded.count))
      result.append(encoded)
    }
    try await io.send(result)
  }
}
