import Foundation
import Testing

@testable import CrabfleetMac

@Suite("Wake on LAN")
struct WakeOnLanTests {
  @Test
  func buildsExactMagicPacket() throws {
    let packet = try WakeOnLan.magicPacket(for: "00:11:22:33:44:55")
    let mac: [UInt8] = [0x00, 0x11, 0x22, 0x33, 0x44, 0x55]
    let expected = Data(
      Array(repeating: UInt8(0xff), count: 6)
        + (0..<16).flatMap { _ in mac })

    #expect(packet.count == 102)
    #expect(packet == expected)
  }

  @Test(
    arguments: [
      "aa:bb:cc:dd:ee:ff",
      "AA-BB-CC-DD-EE-FF",
      "aabbccddeeff",
    ])
  func parsesSupportedMACFormats(_ input: String) throws {
    #expect(try WakeOnLan.parseMACAddress(input) == [0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff])
    #expect(try WakeOnLan.canonicalMACAddress(input) == "aa:bb:cc:dd:ee:ff")
  }

  @Test(
    arguments: [
      "",
      "aa:bb:cc:dd:ee",
      "aa:bb:cc:dd:ee:ff:00",
      "aa-bb:cc-dd:ee-ff",
      "aabbccddeef",
      "gg:bb:cc:dd:ee:ff",
      "aa::cc:dd:ee:ff",
    ])
  func rejectsMalformedMACAddresses(_ input: String) {
    #expect(throws: WakeOnLan.WakeError.invalidMACAddress) {
      try WakeOnLan.parseMACAddress(input)
    }
  }

  @Test
  func profileCodableRoundTripsWakeSettings() throws {
    let profile = VNCConnectionProfile(
      id: "saved-wake-profile",
      name: "Sleeping workstation",
      host: "192.0.2.40",
      port: 5900,
      username: "tester",
      favorite: true,
      prefersPasswordOnlyARD: false,
      macAddress: "aa:bb:cc:dd:ee:ff",
      wakeOnLanBroadcast: "192.0.2.255",
      wakeOnLanAutomatically: true,
      createdAt: Date(timeIntervalSinceReferenceDate: 1_000),
      lastConnectedAt: Date(timeIntervalSinceReferenceDate: 2_000))

    let decoded = try JSONDecoder().decode(
      VNCConnectionProfile.self,
      from: JSONEncoder().encode(profile))

    #expect(decoded == profile)
    #expect(decoded.effectiveWakeOnLanBroadcast == "192.0.2.255")
    #expect(decoded.wakesAutomatically)
  }

  @Test
  func profileCodableRoundTripsWithoutWakeSettings() throws {
    let profile = VNCConnectionProfile(
      id: "saved-plain-profile",
      name: "Always-on workstation",
      host: "198.51.100.20",
      port: 5901,
      createdAt: Date(timeIntervalSinceReferenceDate: 3_000))

    let decoded = try JSONDecoder().decode(
      VNCConnectionProfile.self,
      from: JSONEncoder().encode(profile))

    #expect(decoded == profile)
    #expect(decoded.macAddress == nil)
    #expect(decoded.wakeOnLanBroadcast == nil)
    #expect(!decoded.wakesAutomatically)
  }

  @Test
  func decodesLegacyProfileWithoutWakeFields() throws {
    let legacy = Data(
      """
      {
        "id": "legacy-profile",
        "name": "Legacy workstation",
        "host": "203.0.113.12",
        "port": 5900,
        "username": "",
        "favorite": false,
        "createdAt": 0
      }
      """.utf8)

    let profile = try JSONDecoder().decode(VNCConnectionProfile.self, from: legacy)

    #expect(profile.macAddress == nil)
    #expect(profile.wakeOnLanBroadcast == nil)
    #expect(profile.wakeOnLanAutomatically == nil)
    #expect(!profile.wakesAutomatically)
  }

  @Test
  func defaultsBroadcastAddress() {
    let profile = VNCConnectionProfile(
      name: "Default broadcast",
      host: "192.0.2.50",
      port: 5900,
      macAddress: "00:11:22:33:44:55")

    #expect(profile.effectiveWakeOnLanBroadcast == "255.255.255.255")
    #expect(WakeOnLan.effectiveBroadcastAddress(nil) == "255.255.255.255")
    #expect(WakeOnLan.effectiveBroadcastAddress("   ") == "255.255.255.255")
  }
}
