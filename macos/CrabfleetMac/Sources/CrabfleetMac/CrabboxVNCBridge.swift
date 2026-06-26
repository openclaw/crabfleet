import Darwin
import Foundation

enum CrabboxVNCBridgeError: LocalizedError, Equatable {
  case executableNotFound
  case invalidLeaseID
  case launchFailed(String)
  case timedOut
  case invalidHandoff
  case commandFailed(String)

  var errorDescription: String? {
    switch self {
    case .executableNotFound:
      "Install the latest Crabbox CLI to connect this desktop."
    case .invalidLeaseID:
      "Crabfleet returned an invalid Crabbox lease identifier."
    case .launchFailed(let message):
      "Could not launch Crabbox: \(message)"
    case .timedOut:
      "Crabbox timed out while opening the desktop tunnel."
    case .invalidHandoff:
      "Crabbox returned an invalid native VNC handoff."
    case .commandFailed(let message):
      message.isEmpty ? "Crabbox could not open the desktop tunnel." : message
    }
  }
}

private struct CrabboxVNCHandoff: Decodable {
  let schema: String
  let host: String
  let port: Int
  let username: String
  let password: String
}

final class CrabboxVNCBridge: @unchecked Sendable {
  let request: VNCConnectionRequest

  private let process: Process
  private let stdout: Pipe
  private let stderr: Pipe
  private let lock = NSLock()
  private var stopped = false

  private init(
    process: Process,
    stdout: Pipe,
    stderr: Pipe,
    request: VNCConnectionRequest
  ) {
    self.process = process
    self.stdout = stdout
    self.stderr = stderr
    self.request = request
  }

  static func start(
    leaseID: String,
    executableURL: URL? = nil,
    timeout: TimeInterval = 20
  ) async throws -> CrabboxVNCBridge {
    let worker = Task.detached(priority: .userInitiated) {
      try startSynchronously(
        leaseID: leaseID,
        executableURL: executableURL,
        timeout: timeout
      )
    }
    return try await withTaskCancellationHandler {
      try await worker.value
    } onCancel: {
      worker.cancel()
    }
  }

  func stop() {
    lock.lock()
    guard !stopped else {
      lock.unlock()
      return
    }
    stopped = true
    lock.unlock()

    if process.isRunning {
      process.terminate()
      let pid = process.processIdentifier
      DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + 1) { [weak process] in
        guard let process, process.isRunning else { return }
        _ = Darwin.kill(pid, SIGKILL)
      }
    }
    stdout.fileHandleForReading.closeFile()
    stderr.fileHandleForReading.closeFile()
  }

  deinit {
    stop()
  }

  private static func startSynchronously(
    leaseID: String,
    executableURL: URL?,
    timeout: TimeInterval
  ) throws -> CrabboxVNCBridge {
    guard validLeaseID(leaseID) else { throw CrabboxVNCBridgeError.invalidLeaseID }
    guard let executable = executableURL ?? resolveExecutable() else {
      throw CrabboxVNCBridgeError.executableNotFound
    }

    let process = Process()
    let stdout = Pipe()
    let stderr = Pipe()
    process.executableURL = executable
    process.arguments = ["vnc", "--id", leaseID, "--native-handoff"]
    process.standardInput = FileHandle.nullDevice
    process.standardOutput = stdout
    process.standardError = stderr

    do {
      try process.run()
    } catch {
      throw CrabboxVNCBridgeError.launchFailed(error.localizedDescription)
    }

    do {
      let line = try readLine(
        fileDescriptor: stdout.fileHandleForReading.fileDescriptor,
        process: process,
        timeout: timeout
      )
      let handoff = try JSONDecoder().decode(CrabboxVNCHandoff.self, from: line)
      guard
        handoff.schema == "crabbox/vnc-handoff/v1",
        handoff.host == "127.0.0.1",
        (1...65_535).contains(handoff.port),
        handoff.username.utf8.count <= 256,
        handoff.password.utf8.count <= 4_096
      else {
        throw CrabboxVNCBridgeError.invalidHandoff
      }
      return CrabboxVNCBridge(
        process: process,
        stdout: stdout,
        stderr: stderr,
        request: .init(
          host: handoff.host,
          port: handoff.port,
          username: handoff.username,
          password: handoff.password,
          clipboardEnabled: true
        )
      )
    } catch {
      terminate(process)
      if error is CancellationError { throw error }
      if let bridgeError = error as? CrabboxVNCBridgeError,
        bridgeError != .commandFailed("")
      {
        throw bridgeError
      }
      let message = boundedError(stderr.fileHandleForReading.availableData)
      throw message.isEmpty
        ? CrabboxVNCBridgeError.invalidHandoff
        : CrabboxVNCBridgeError.commandFailed(message)
    }
  }

  private static func readLine(
    fileDescriptor: Int32,
    process: Process,
    timeout: TimeInterval
  ) throws -> Data {
    let deadline = Date().addingTimeInterval(timeout)
    var data = Data()
    var buffer = [UInt8](repeating: 0, count: 512)
    while Date() < deadline {
      if Task.isCancelled { throw CancellationError() }
      var descriptor = pollfd(fd: fileDescriptor, events: Int16(POLLIN | POLLHUP), revents: 0)
      let remaining = max(1, min(250, Int(deadline.timeIntervalSinceNow * 1_000)))
      let result = Darwin.poll(&descriptor, 1, Int32(remaining))
      if result < 0 {
        if errno == EINTR { continue }
        throw CrabboxVNCBridgeError.invalidHandoff
      }
      if result == 0 { continue }
      let count = Darwin.read(fileDescriptor, &buffer, buffer.count)
      if count <= 0 {
        if !process.isRunning { throw CrabboxVNCBridgeError.commandFailed("") }
        continue
      }
      data.append(contentsOf: buffer.prefix(Int(count)))
      guard data.count <= 4_096 else { throw CrabboxVNCBridgeError.invalidHandoff }
      if let newline = data.firstIndex(of: 0x0A) {
        guard newline == data.index(before: data.endIndex) else {
          throw CrabboxVNCBridgeError.invalidHandoff
        }
        return data.prefix(upTo: newline)
      }
    }
    throw CrabboxVNCBridgeError.timedOut
  }

  private static func resolveExecutable() -> URL? {
    let environment = ProcessInfo.processInfo.environment
    var candidates: [String] = []
    if let override = environment["CRABFLEET_CRABBOX_BIN"], override.hasPrefix("/") {
      candidates.append(override)
    }
    let home = FileManager.default.homeDirectoryForCurrentUser.path
    candidates.append(contentsOf: [
      "\(home)/bin/crabbox",
      "/opt/homebrew/bin/crabbox",
      "/usr/local/bin/crabbox",
    ])
    candidates.append(contentsOf: (environment["PATH"] ?? "").split(separator: ":").map {
      "\($0)/crabbox"
    })
    return candidates.first { $0.hasPrefix("/") && FileManager.default.isExecutableFile(atPath: $0) }.map {
      URL(fileURLWithPath: $0)
    }
  }

  private static func validLeaseID(_ value: String) -> Bool {
    !value.isEmpty && value.utf8.count <= 200 && value.utf8.allSatisfy {
      (0x30...0x39).contains($0) || (0x41...0x5A).contains($0) ||
        (0x61...0x7A).contains($0) || [0x2E, 0x5F, 0x2D].contains($0)
    }
  }

  private static func terminate(_ process: Process) {
    guard process.isRunning else { return }
    process.terminate()
    let deadline = Date().addingTimeInterval(1)
    while process.isRunning && Date() < deadline {
      Thread.sleep(forTimeInterval: 0.01)
    }
    if process.isRunning {
      _ = Darwin.kill(process.processIdentifier, SIGKILL)
    }
  }

  private static func boundedError(_ data: Data) -> String {
    String(decoding: data.prefix(2_048), as: UTF8.self)
      .replacingOccurrences(of: "[\\x00-\\x1F\\x7F]+", with: " ", options: .regularExpression)
      .trimmingCharacters(in: .whitespacesAndNewlines)
  }
}
