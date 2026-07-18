import Foundation

struct TailscaleCommandResult: Equatable, Sendable {
  let standardOutput: String
  let standardError: String
}

protocol TailscaleCommandRunning: Sendable {
  func run(arguments: [String]) async throws -> TailscaleCommandResult
}

struct SystemTailscaleCommandRunner: TailscaleCommandRunning {
  private static let maximumOutputBytes = 4 * 1_024 * 1_024
  private static let defaultTimeout: TimeInterval = 15
  static let executableCandidates = [
    "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
  ]

  let executableURL: URL
  let timeout: TimeInterval

  init(
    fileManager: FileManager = .default,
    timeout: TimeInterval = Self.defaultTimeout
  ) throws {
    guard
      let path = Self.executableCandidates.first(where: {
        Self.isTrustedExecutable(atPath: $0, fileManager: fileManager)
      })
    else {
      throw PrivateMacShareError.tailscaleNotInstalled
    }
    executableURL = URL(fileURLWithPath: path)
    self.timeout = timeout
  }

  init(executableURL: URL, timeout: TimeInterval = Self.defaultTimeout) {
    self.executableURL = executableURL
    self.timeout = timeout
  }

  func run(arguments: [String]) async throws -> TailscaleCommandResult {
    let execution = TailscaleCommandExecution(
      executableURL: executableURL,
      arguments: arguments,
      environment: Self.commandEnvironment(from: ProcessInfo.processInfo.environment),
      timeout: timeout,
      maximumOutputBytes: Self.maximumOutputBytes
    )
    return try await withTaskCancellationHandler {
      let result = try await withCheckedThrowingContinuation { continuation in
        DispatchQueue.global(qos: .userInitiated).async {
          continuation.resume(with: Result { try execution.run() })
        }
      }
      try Task.checkCancellation()
      return result
    } onCancel: {
      execution.cancel()
    }
  }

  static func commandEnvironment(from source: [String: String]) -> [String: String] {
    SubprocessEnvironment.minimal(
      from: source,
      overrides: ["TAILSCALE_BE_CLI": "1"]
    )
  }

  static func isTrustedExecutable(
    atPath path: String,
    fileManager: FileManager
  ) -> Bool {
    guard
      fileManager.isExecutableFile(atPath: path),
      let attributes = try? fileManager.attributesOfItem(atPath: path)
    else { return false }
    return isTrustedExecutable(attributes: attributes)
  }

  static func isTrustedExecutable(attributes: [FileAttributeKey: Any]) -> Bool {
    guard
      let ownerID = (attributes[.ownerAccountID] as? NSNumber)?.uint32Value,
      let permissions = (attributes[.posixPermissions] as? NSNumber)?.uint16Value
    else { return false }
    return ownerID == 0 && permissions & 0o022 == 0
  }
}

private final class TailscaleCommandExecution: @unchecked Sendable {
  private static let processDrainTimeout: DispatchTimeInterval = .milliseconds(250)
  private static let terminationGracePeriod: TimeInterval = 0.5

  private enum StopReason {
    case cancelled
    case outputTooLarge
    case timedOut
  }

  private let lock = NSLock()
  private let outputPipe = Pipe()
  private let errorPipe = Pipe()
  private let readGroup = DispatchGroup()
  private let executableURL: URL
  private let arguments: [String]
  private let environment: [String: String]
  private let timeout: TimeInterval
  private let maximumOutputBytes: Int
  private var processID: pid_t?
  private var stopReason: StopReason?
  private var captureShouldStop = false
  private var standardOutput = Data()
  private var standardError = Data()

  init(
    executableURL: URL,
    arguments: [String],
    environment: [String: String],
    timeout: TimeInterval,
    maximumOutputBytes: Int
  ) {
    self.executableURL = executableURL
    self.arguments = arguments
    self.environment = environment
    self.timeout = max(0.1, timeout)
    self.maximumOutputBytes = maximumOutputBytes
  }

  func run() throws -> TailscaleCommandResult {
    if currentStopReason() != nil { throw CancellationError() }
    startCapture(pipe: outputPipe, isStandardOutput: true)
    startCapture(pipe: errorPipe, isStandardOutput: false)

    let pid: pid_t
    do {
      pid = try spawn()
    } catch {
      outputPipe.fileHandleForWriting.closeFile()
      errorPipe.fileHandleForWriting.closeFile()
      readGroup.wait()
      throw error
    }

    setProcessID(pid)
    outputPipe.fileHandleForWriting.closeFile()
    errorPipe.fileHandleForWriting.closeFile()
    if currentStopReason() != nil { signalProcessGroup(pid, signal: SIGTERM) }

    let clock = ContinuousClock()
    let deadline = clock.now.advanced(by: .seconds(timeout))
    var terminationDeadline: ContinuousClock.Instant?
    var waitStatus: Int32 = 0
    while true {
      let waitResult = Darwin.waitpid(pid, &waitStatus, WNOHANG)
      if waitResult == pid { break }
      if waitResult == -1 {
        if errno == EINTR { continue }
        throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .ECHILD)
      }

      if currentStopReason() != nil {
        if terminationDeadline == nil {
          signalProcessGroup(pid, signal: SIGTERM)
          terminationDeadline = clock.now.advanced(by: .seconds(Self.terminationGracePeriod))
        } else if clock.now >= terminationDeadline! {
          signalProcessGroup(pid, signal: SIGKILL)
        }
      } else if clock.now >= deadline {
        stop(.timedOut)
      }
      Thread.sleep(forTimeInterval: 0.01)
    }

    if currentStopReason() != nil {
      signalProcessGroup(pid, signal: SIGKILL)
    }
    clearProcessID(pid)
    finishCapture()

    switch currentStopReason() {
    case .cancelled:
      throw CancellationError()
    case .outputTooLarge:
      throw PrivateMacShareError.commandOutputTooLarge
    case .timedOut:
      throw PrivateMacShareError.commandTimedOut
    case nil:
      break
    }

    let result = values()
    let terminationStatus = Self.terminationStatus(from: waitStatus)
    guard terminationStatus == 0 else {
      let message = result.standardError.trimmingCharacters(in: .whitespacesAndNewlines)
      throw PrivateMacShareError.commandFailed(
        status: terminationStatus,
        message: String(message.prefix(500))
      )
    }
    return result
  }

  func cancel() {
    stop(.cancelled)
  }

  private func startCapture(pipe: Pipe, isStandardOutput: Bool) {
    readGroup.enter()
    DispatchQueue.global(qos: .userInitiated).async { [self] in
      defer { readGroup.leave() }
      let fileDescriptor = pipe.fileHandleForReading.fileDescriptor
      var data = Data()
      var buffer = [UInt8](repeating: 0, count: 64 * 1_024)
      while !shouldStopCapture() {
        var descriptor = pollfd(fd: fileDescriptor, events: Int16(POLLIN | POLLHUP), revents: 0)
        let pollResult = Darwin.poll(&descriptor, 1, 50)
        if pollResult == 0 { continue }
        if pollResult < 0 {
          if errno == EINTR { continue }
          break
        }

        let bytesRead = buffer.withUnsafeMutableBytes {
          Darwin.read(fileDescriptor, $0.baseAddress, $0.count)
        }
        if bytesRead == 0 { break }
        if bytesRead < 0 {
          if errno == EINTR || errno == EAGAIN { continue }
          break
        }
        guard bytesRead <= maximumOutputBytes - data.count else {
          stop(.outputTooLarge)
          break
        }
        data.append(buffer, count: bytesRead)
      }
      setCaptured(data, isStandardOutput: isStandardOutput)
    }
  }

  private func setCaptured(_ data: Data, isStandardOutput: Bool) {
    lock.lock()
    if isStandardOutput {
      standardOutput = data
    } else {
      standardError = data
    }
    lock.unlock()
  }

  private func values() -> TailscaleCommandResult {
    lock.lock()
    defer { lock.unlock() }
    return TailscaleCommandResult(
      standardOutput: String(decoding: standardOutput, as: UTF8.self),
      standardError: String(decoding: standardError, as: UTF8.self)
    )
  }

  private func currentStopReason() -> StopReason? {
    lock.lock()
    defer { lock.unlock() }
    return stopReason
  }

  private func shouldStopCapture() -> Bool {
    lock.lock()
    defer { lock.unlock() }
    return captureShouldStop
  }

  private func stopCapture() {
    lock.lock()
    captureShouldStop = true
    lock.unlock()
  }

  private func stop(_ reason: StopReason) {
    lock.lock()
    if stopReason == nil { stopReason = reason }
    let pid = processID
    lock.unlock()
    if let pid {
      signalProcessGroup(pid, signal: SIGTERM)
    }
  }

  private func spawn() throws -> pid_t {
    var fileActions: posix_spawn_file_actions_t?
    var attributes: posix_spawnattr_t?
    guard posix_spawn_file_actions_init(&fileActions) == 0 else {
      throw POSIXError(.ENOMEM)
    }
    defer { posix_spawn_file_actions_destroy(&fileActions) }
    guard posix_spawnattr_init(&attributes) == 0 else {
      throw POSIXError(.ENOMEM)
    }
    defer { posix_spawnattr_destroy(&attributes) }

    let outputRead = outputPipe.fileHandleForReading.fileDescriptor
    let outputWrite = outputPipe.fileHandleForWriting.fileDescriptor
    let errorRead = errorPipe.fileHandleForReading.fileDescriptor
    let errorWrite = errorPipe.fileHandleForWriting.fileDescriptor
    posix_spawn_file_actions_addclose(&fileActions, outputRead)
    posix_spawn_file_actions_addclose(&fileActions, errorRead)
    posix_spawn_file_actions_adddup2(&fileActions, outputWrite, STDOUT_FILENO)
    posix_spawn_file_actions_adddup2(&fileActions, errorWrite, STDERR_FILENO)
    posix_spawn_file_actions_addclose(&fileActions, outputWrite)
    posix_spawn_file_actions_addclose(&fileActions, errorWrite)

    let flags = Int16(POSIX_SPAWN_SETPGROUP)
    posix_spawnattr_setflags(&attributes, flags)
    posix_spawnattr_setpgroup(&attributes, 0)

    let argv = [executableURL.path] + arguments
    let env = environment.map { "\($0.key)=\($0.value)" }
    return try withCStringArray(argv) { argumentPointers in
      try withCStringArray(env) { environmentPointers in
        var pid: pid_t = 0
        let result = posix_spawn(
          &pid,
          executableURL.path,
          &fileActions,
          &attributes,
          argumentPointers,
          environmentPointers
        )
        guard result == 0 else {
          throw POSIXError(POSIXErrorCode(rawValue: result) ?? .EINVAL)
        }
        return pid
      }
    }
  }

  private func withCStringArray<Result>(
    _ strings: [String],
    body: ([UnsafeMutablePointer<CChar>?]) throws -> Result
  ) rethrows -> Result {
    let pointers = strings.map { strdup($0) }
    defer { pointers.forEach { free($0) } }
    return try body(pointers + [nil])
  }

  private func setProcessID(_ pid: pid_t) {
    lock.lock()
    processID = pid
    lock.unlock()
  }

  private func clearProcessID(_ pid: pid_t) {
    lock.lock()
    if processID == pid { processID = nil }
    lock.unlock()
  }

  private func signalProcessGroup(_ pid: pid_t, signal: Int32) {
    guard pid > 0 else { return }
    if Darwin.kill(-pid, signal) != 0, errno != ESRCH {
      return
    }
  }

  private static func terminationStatus(from waitStatus: Int32) -> Int32 {
    let signal = waitStatus & 0x7f
    if signal == 0 {
      return (waitStatus >> 8) & 0xff
    }
    return 128 + signal
  }

  private func finishCapture() {
    guard readGroup.wait(timeout: .now() + Self.processDrainTimeout) == .timedOut else {
      return
    }
    stopCapture()
    _ = readGroup.wait(timeout: .now() + Self.processDrainTimeout)
  }
}

struct TailscaleStatusDocument: Decodable, Sendable {
  struct Node: Decodable, Sendable {
    let dnsName: String
    let hostName: String
    let online: Bool
    let tailscaleIPs: [String]
    let userID: Int64

    enum CodingKeys: String, CodingKey {
      case dnsName = "DNSName"
      case hostName = "HostName"
      case online = "Online"
      case tailscaleIPs = "TailscaleIPs"
      case userID = "UserID"
    }
  }

  struct Tailnet: Decodable, Sendable {
    let name: String

    enum CodingKeys: String, CodingKey {
      case name = "Name"
    }
  }

  struct User: Decodable, Sendable {
    let loginName: String

    enum CodingKeys: String, CodingKey {
      case loginName = "LoginName"
    }
  }

  struct PeerNode: Decodable, Sendable {
    let hostName: String?

    enum CodingKeys: String, CodingKey {
      case hostName = "HostName"
    }
  }

  let backendState: String
  let currentTailnet: Tailnet?
  let selfNode: Node?
  let peerNodes: [String: PeerNode]
  let users: [String: User]

  enum CodingKeys: String, CodingKey {
    case backendState = "BackendState"
    case currentTailnet = "CurrentTailnet"
    case selfNode = "Self"
    case peerNodes = "Peer"
    case users = "User"
  }

  init(from decoder: any Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    backendState = try container.decode(String.self, forKey: .backendState)
    currentTailnet = try container.decodeIfPresent(Tailnet.self, forKey: .currentTailnet)
    selfNode = try container.decodeIfPresent(Node.self, forKey: .selfNode)
    users = try container.decode([String: User].self, forKey: .users)
    peerNodes = (try? container.decode([String: PeerNode].self, forKey: .peerNodes)) ?? [:]
  }
}

enum TailnetRegistrationHealth: Equatable, Sendable {
  case ok
  case duplicateHostname(
    advertised: String?,
    hostName: String,
    matchingPeerPresent: Bool
  )
}

enum TailnetRegistrationHealthPolicy {
  static func health(from document: TailscaleStatusDocument) -> TailnetRegistrationHealth {
    guard let node = document.selfNode else { return .ok }
    var dnsName = node.dnsName
    while dnsName.last == "." { dnsName.removeLast() }
    guard
      let firstLabel = dnsName.split(separator: ".", omittingEmptySubsequences: false).first,
      !firstLabel.isEmpty,
      let suffixSeparator = firstLabel.lastIndex(of: "-")
    else { return .ok }

    let base = firstLabel[..<suffixSeparator]
    let suffix = firstLabel[firstLabel.index(after: suffixSeparator)...]
    guard
      !base.isEmpty,
      !suffix.isEmpty,
      suffix.utf8.allSatisfy({ (48...57).contains($0) }),
      String(base).caseInsensitiveCompare(node.hostName) == .orderedSame
    else { return .ok }

    let advertised = node.tailscaleIPs.first(where: TailnetIdentityPolicy.isTailscaleIPv4)
    let matchingPeerPresent = document.peerNodes.values.contains { peer in
      guard let peerHostName = peer.hostName else { return false }
      return peerHostName.caseInsensitiveCompare(String(base)) == .orderedSame
    }
    return .duplicateHostname(
      advertised: advertised,
      hostName: node.hostName,
      matchingPeerPresent: matchingPeerPresent
    )
  }
}

struct TailnetIdentity: Equatable, Sendable {
  let tailnetName: String
  let loginName: String
  let dnsName: String
  let hostName: String
  let ipv4Address: String
  let userID: Int64

  func vncAddress(port: Int) -> String {
    "vnc://\(ipv4Address):\(port)"
  }
}

enum TailnetIdentityPolicy {
  static func identity(from document: TailscaleStatusDocument) throws
    -> TailnetIdentity
  {
    guard document.backendState == "Running" else {
      throw PrivateMacShareError.tailscaleNotRunning
    }
    guard
      let rawTailnetName = document.currentTailnet?.name,
      isValidTailnetName(rawTailnetName)
    else {
      throw PrivateMacShareError.invalidTailnetIdentity
    }
    let tailnetName = rawTailnetName.trimmingCharacters(in: .whitespacesAndNewlines)
    guard let node = document.selfNode, node.online else {
      throw PrivateMacShareError.tailscaleOffline
    }
    guard
      let user = document.users[String(node.userID)],
      isValidLogin(user.loginName)
    else {
      throw PrivateMacShareError.invalidTailnetUser
    }
    guard let ipv4Address = node.tailscaleIPs.first(where: isTailscaleIPv4) else {
      throw PrivateMacShareError.missingTailnetAddress
    }

    return TailnetIdentity(
      tailnetName: tailnetName,
      loginName: user.loginName.trimmingCharacters(in: .whitespacesAndNewlines),
      dnsName: node.dnsName.trimmingCharacters(in: CharacterSet(charactersIn: ".")),
      hostName: node.hostName,
      ipv4Address: ipv4Address,
      userID: node.userID
    )
  }

  static func isValidTailnetName(_ value: String) -> Bool {
    isValidIdentityField(value, maximumUTF8Bytes: 253)
  }

  static func isValidLogin(_ value: String) -> Bool {
    isValidIdentityField(value, maximumUTF8Bytes: 320)
  }

  static func isTailscaleIPv4(_ value: String) -> Bool {
    let parts = value.split(separator: ".", omittingEmptySubsequences: false)
    guard parts.count == 4 else { return false }
    let octets = parts.compactMap { UInt8($0) }
    return octets.count == 4 && octets[0] == 100 && (64...127).contains(octets[1])
  }

  private static func isValidIdentityField(_ value: String, maximumUTF8Bytes: Int) -> Bool {
    guard
      !value.isEmpty,
      value.utf8.count <= maximumUTF8Bytes,
      value == value.trimmingCharacters(in: .whitespacesAndNewlines)
    else { return false }
    return value.unicodeScalars.allSatisfy {
      !CharacterSet.controlCharacters.contains($0)
    }
  }
}

struct TailscaleWhoisDocument: Decodable, Sendable {
  struct Node: Decodable, Sendable {
    let addresses: [String]
    let machineAuthorized: Bool
    let userID: Int64

    enum CodingKeys: String, CodingKey {
      case addresses = "Addresses"
      case machineAuthorized = "MachineAuthorized"
      case userID = "User"
    }
  }

  struct UserProfile: Decodable, Sendable {
    let loginName: String

    enum CodingKeys: String, CodingKey {
      case loginName = "LoginName"
    }
  }

  let node: Node
  let userProfile: UserProfile

  enum CodingKeys: String, CodingKey {
    case node = "Node"
    case userProfile = "UserProfile"
  }
}

protocol TailnetPeerAuthorizing: Sendable {
  func authorize(remoteAddress: String) async -> Bool
}

struct TailnetPeerAuthorizer: TailnetPeerAuthorizing, Sendable {
  let runner: any TailscaleCommandRunning
  let expectedIdentity: TailnetIdentity

  func authorize(remoteAddress: String) async -> Bool {
    guard
      TailnetIdentityPolicy.isTailscaleIPv4(remoteAddress),
      remoteAddress != expectedIdentity.ipv4Address
    else { return false }
    do {
      let result = try await runner.run(arguments: ["whois", "--json", remoteAddress])
      let document = try JSONDecoder().decode(
        TailscaleWhoisDocument.self,
        from: Data(result.standardOutput.utf8)
      )
      let addressMatches = document.node.addresses.contains("\(remoteAddress)/32")
      let userMatches =
        document.node.userID == expectedIdentity.userID
        && document.userProfile.loginName.caseInsensitiveCompare(expectedIdentity.loginName)
          == .orderedSame
      return document.node.machineAuthorized && addressMatches && userMatches
    } catch {
      return false
    }
  }
}

enum PrivateMacShareError: LocalizedError, Equatable {
  case tailscaleNotInstalled
  case tailscaleNotRunning
  case tailscaleOffline
  case invalidTailnetIdentity
  case invalidTailnetUser
  case missingTailnetAddress
  case screenRecordingDenied
  case accessibilityDenied
  case commandFailed(status: Int32, message: String)
  case commandOutputTooLarge
  case commandTimedOut
  case captureUnavailable
  case listenerFailed(String)
  case protocolError(String)

  var errorDescription: String? {
    switch self {
    case .tailscaleNotInstalled:
      "Tailscale is not installed. Install Tailscale first."
    case .tailscaleNotRunning:
      "Tailscale is not running."
    case .tailscaleOffline:
      "This Mac is offline in Tailscale."
    case .invalidTailnetIdentity:
      "Tailscale did not report a valid active tailnet."
    case .invalidTailnetUser:
      "Tailscale did not report a valid signed-in user."
    case .missingTailnetAddress:
      "Tailscale did not provide a private 100.64.0.0/10 address for this Mac."
    case .screenRecordingDenied:
      "Crabfleet needs Screen Recording permission to stream this display."
    case .accessibilityDenied:
      "Crabfleet needs Accessibility permission to forward keyboard and pointer input."
    case .commandFailed(let status, let message):
      message.isEmpty
        ? "Tailscale exited with status \(status)."
        : "Tailscale exited with status \(status): \(message)"
    case .commandOutputTooLarge:
      "Tailscale returned more status data than Crabfleet will accept."
    case .commandTimedOut:
      "Tailscale did not respond before the command deadline."
    case .captureUnavailable:
      "Crabfleet could not capture the main display."
    case .listenerFailed(let message):
      "The private desktop listener failed: \(message)"
    case .protocolError(let message):
      "The remote desktop connection was rejected: \(message)"
    }
  }
}
