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
  private static let executableCandidates = [
    "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
    "/usr/local/bin/tailscale",
    "/opt/homebrew/bin/tailscale",
  ]

  let executableURL: URL

  init(fileManager: FileManager = .default) throws {
    guard
      let path = Self.executableCandidates.first(where: {
        fileManager.isExecutableFile(atPath: $0)
      })
    else {
      throw PrivateMacShareError.tailscaleNotInstalled
    }
    executableURL = URL(fileURLWithPath: path)
  }

  init(executableURL: URL) {
    self.executableURL = executableURL
  }

  func run(arguments: [String]) async throws -> TailscaleCommandResult {
    try await withCheckedThrowingContinuation { continuation in
      DispatchQueue.global(qos: .userInitiated).async {
        let process = Process()
        let outputPipe = Pipe()
        let errorPipe = Pipe()
        let readGroup = DispatchGroup()
        let capture = CommandCapture()

        process.executableURL = executableURL
        process.arguments = arguments
        process.standardOutput = outputPipe
        process.standardError = errorPipe
        process.qualityOfService = .userInitiated

        var environment = ProcessInfo.processInfo.environment
        for key in environment.keys
        where key.hasPrefix("TS_") || key.hasPrefix("TAILSCALE_") {
          environment.removeValue(forKey: key)
        }
        process.environment = environment

        readGroup.enter()
        DispatchQueue.global(qos: .userInitiated).async {
          capture.setStandardOutput(outputPipe.fileHandleForReading.readDataToEndOfFile())
          readGroup.leave()
        }

        readGroup.enter()
        DispatchQueue.global(qos: .userInitiated).async {
          capture.setStandardError(errorPipe.fileHandleForReading.readDataToEndOfFile())
          readGroup.leave()
        }

        do {
          try process.run()
          process.waitUntilExit()
          readGroup.wait()

          let (outputData, errorData) = capture.values()
          guard
            outputData.count <= Self.maximumOutputBytes,
            errorData.count <= Self.maximumOutputBytes
          else {
            continuation.resume(throwing: PrivateMacShareError.commandOutputTooLarge)
            return
          }

          let result = TailscaleCommandResult(
            standardOutput: String(decoding: outputData, as: UTF8.self),
            standardError: String(decoding: errorData, as: UTF8.self)
          )
          guard process.terminationStatus == 0 else {
            let message = result.standardError.trimmingCharacters(in: .whitespacesAndNewlines)
            continuation.resume(
              throwing: PrivateMacShareError.commandFailed(
                status: process.terminationStatus,
                message: String(message.prefix(500))
              ))
            return
          }
          continuation.resume(returning: result)
        } catch {
          outputPipe.fileHandleForWriting.closeFile()
          errorPipe.fileHandleForWriting.closeFile()
          readGroup.wait()
          continuation.resume(throwing: error)
        }
      }
    }
  }
}

private final class CommandCapture: @unchecked Sendable {
  private let lock = NSLock()
  private var standardOutput = Data()
  private var standardError = Data()

  func setStandardOutput(_ data: Data) {
    lock.lock()
    standardOutput = data
    lock.unlock()
  }

  func setStandardError(_ data: Data) {
    lock.lock()
    standardError = data
    lock.unlock()
  }

  func values() -> (Data, Data) {
    lock.lock()
    defer { lock.unlock() }
    return (standardOutput, standardError)
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

  let backendState: String
  let currentTailnet: Tailnet?
  let selfNode: Node?
  let users: [String: User]

  enum CodingKeys: String, CodingKey {
    case backendState = "BackendState"
    case currentTailnet = "CurrentTailnet"
    case selfNode = "Self"
    case users = "User"
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

struct TailnetPeerAuthorizer: Sendable {
  let runner: any TailscaleCommandRunning
  let expectedIdentity: TailnetIdentity

  func authorize(remoteAddress: String) async -> Bool {
    guard TailnetIdentityPolicy.isTailscaleIPv4(remoteAddress) else { return false }
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
    case .captureUnavailable:
      "Crabfleet could not capture the main display."
    case .listenerFailed(let message):
      "The private desktop listener failed: \(message)"
    case .protocolError(let message):
      "The remote desktop connection was rejected: \(message)"
    }
  }
}
