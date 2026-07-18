import Darwin
import Foundation

struct WakeOnLan: Sendable {
  static let defaultBroadcastAddress = "255.255.255.255"
  static let ports: [UInt16] = [9, 7]

  struct Configuration: Equatable, Sendable {
    let macAddress: String
    let broadcastAddress: String?

    var effectiveBroadcastAddress: String {
      WakeOnLan.effectiveBroadcastAddress(broadcastAddress)
    }
  }

  struct ProfileSettings: Equatable, Sendable {
    let macAddress: String?
    let broadcastAddress: String?
    let automaticallyWakeOnFailure: Bool

    init(
      macAddress: String,
      broadcastAddress: String,
      automaticallyWakeOnFailure: Bool
    ) throws {
      let trimmedMAC = macAddress.trimmingCharacters(in: .whitespacesAndNewlines)
      guard !trimmedMAC.isEmpty else {
        self.macAddress = nil
        self.broadcastAddress = nil
        self.automaticallyWakeOnFailure = false
        return
      }

      self.macAddress = try WakeOnLan.canonicalMACAddress(trimmedMAC)
      let trimmedBroadcast = broadcastAddress.trimmingCharacters(in: .whitespacesAndNewlines)
      if trimmedBroadcast.isEmpty {
        self.broadcastAddress = nil
      } else {
        guard WakeOnLan.isIPv4Address(trimmedBroadcast) else {
          throw WakeError.invalidBroadcastAddress
        }
        self.broadcastAddress = trimmedBroadcast
      }
      self.automaticallyWakeOnFailure = automaticallyWakeOnFailure
    }

    var configuration: Configuration? {
      macAddress.map {
        Configuration(macAddress: $0, broadcastAddress: broadcastAddress)
      }
    }
  }

  enum WakeError: Error, Equatable, LocalizedError, Sendable {
    case invalidMACAddress
    case invalidBroadcastAddress
    case sendFailed(ports: [UInt16])

    var errorDescription: String? {
      switch self {
      case .invalidMACAddress:
        "Enter a 12-digit MAC address, with optional colons or hyphens."
      case .invalidBroadcastAddress:
        "Enter an IPv4 subnet broadcast address, such as 192.168.1.255."
      case .sendFailed(let ports):
        "The wake packet could not be sent on UDP port \(ports.map(String.init).joined(separator: ", "))."
      }
    }
  }

  static func effectiveBroadcastAddress(_ value: String?) -> String {
    guard let value else { return defaultBroadcastAddress }
    let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
    return trimmed.isEmpty ? defaultBroadcastAddress : trimmed
  }

  static func parseMACAddress(_ value: String) throws -> [UInt8] {
    let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
    let components: [Substring]
    if trimmed.contains(":") || trimmed.contains("-") {
      guard !(trimmed.contains(":") && trimmed.contains("-")) else {
        throw WakeError.invalidMACAddress
      }
      let separator: Character = trimmed.contains(":") ? ":" : "-"
      components = trimmed.split(separator: separator, omittingEmptySubsequences: false)
      guard components.count == 6, components.allSatisfy({ $0.count == 2 }) else {
        throw WakeError.invalidMACAddress
      }
    } else {
      guard trimmed.count == 12 else { throw WakeError.invalidMACAddress }
      components = stride(from: 0, to: 12, by: 2).map { offset in
        let start = trimmed.index(trimmed.startIndex, offsetBy: offset)
        let end = trimmed.index(start, offsetBy: 2)
        return trimmed[start..<end]
      }
    }

    let bytes = components.compactMap { component -> UInt8? in
      guard component.unicodeScalars.allSatisfy({ scalar in
        switch scalar.value {
        case 48...57, 65...70, 97...102: true
        default: false
        }
      }) else { return nil }
      return UInt8(component, radix: 16)
    }
    guard bytes.count == 6 else { throw WakeError.invalidMACAddress }
    return bytes
  }

  static func canonicalMACAddress(_ value: String) throws -> String {
    try parseMACAddress(value).map { String(format: "%02x", $0) }.joined(separator: ":")
  }

  static func magicPacket(for macAddress: String) throws -> Data {
    let macBytes = try parseMACAddress(macAddress)
    var packet = Data(repeating: 0xff, count: 6)
    for _ in 0..<16 {
      packet.append(contentsOf: macBytes)
    }
    return packet
  }

  func send(_ configuration: Configuration) async throws {
    let packet = try Self.magicPacket(for: configuration.macAddress)
    let broadcast = configuration.effectiveBroadcastAddress
    guard Self.isIPv4Address(broadcast) else {
      throw WakeError.invalidBroadcastAddress
    }

    let failedPorts = await Task.detached(priority: .utility) {
      Self.sendDatagrams(packet, broadcastAddress: broadcast)
    }.value

    guard failedPorts.isEmpty else {
      throw WakeError.sendFailed(ports: failedPorts)
    }
  }

  fileprivate static func isIPv4Address(_ value: String) -> Bool {
    var address = in_addr()
    return value.withCString { inet_pton(AF_INET, $0, &address) } == 1
  }

  private static func sendDatagrams(
    _ packet: Data,
    broadcastAddress: String
  ) -> [UInt16] {
    let socketDescriptor = Darwin.socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP)
    guard socketDescriptor >= 0 else { return ports }
    defer { Darwin.close(socketDescriptor) }

    var enabled: Int32 = 1
    guard
      setsockopt(
        socketDescriptor,
        SOL_SOCKET,
        SO_BROADCAST,
        &enabled,
        socklen_t(MemoryLayout.size(ofValue: enabled))) == 0,
      fcntl(socketDescriptor, F_SETFL, O_NONBLOCK) == 0
    else {
      return ports
    }

    return ports.filter { port in
      var destination = sockaddr_in()
      destination.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
      destination.sin_family = sa_family_t(AF_INET)
      destination.sin_port = port.bigEndian
      let parsed = broadcastAddress.withCString {
        inet_pton(AF_INET, $0, &destination.sin_addr)
      }
      guard parsed == 1 else { return true }

      let sent = packet.withUnsafeBytes { packetBytes in
        withUnsafePointer(to: &destination) { destinationPointer in
          destinationPointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
            Darwin.sendto(
              socketDescriptor,
              packetBytes.baseAddress,
              packetBytes.count,
              0,
              $0,
              socklen_t(MemoryLayout<sockaddr_in>.size))
          }
        }
      }
      return sent != packet.count
    }
  }
}
