import Foundation
import Testing

@testable import RoyalVNCKit

struct SecurityAndInputTests {
  typealias ARDKeyAgreement = VNCProtocol.ARDAuthentication.DiffieHellmanKeyAgreement
  typealias UltraVNCKeyAgreement =
    VNCProtocol.UltraVNCMSLogonIIAuthentication.DiffieHellmanKeyAgreement
  typealias UltraVNCBigNum =
    UltraVNCKeyAgreement.UltraVNCBigNum

  @Test
  func rejectsWeakAppleRemoteDesktopModuli() {
    for prime in [
      Data(repeating: 0, count: 128),
      Data(repeating: 1, count: 128),
      Data([0]) + Data(repeating: 0xFF, count: 127),
      Data([0x80]) + Data(repeating: 0, count: 127),
      appleRemoteDesktopUnsafePrime,
    ] {
      let agreement = ARDKeyAgreement(
        prime: prime,
        generator: Data([2]),
        peerKey: paddedARDValue(2),
        keyLength: 128
      )

      #expect(agreement.map { _ in true } == nil)
    }
  }

  @Test
  func rejectsAppleRemoteDesktopElementsOutsideTheSafeRange() {
    let prime = appleRemoteDesktopSafePrime
    let primeMinusOne = prime.dropLast() + Data([0xFE])

    for generator in [
      Data([0]),
      Data([1]),
      primeMinusOne,
      prime,
    ] {
      #expect(
        ARDKeyAgreement(
          prime: prime,
          generator: generator,
          peerKey: paddedARDValue(2),
          keyLength: 128
        ) == nil
      )
    }

    for peerKey in [
      paddedARDValue(0),
      paddedARDValue(1),
      primeMinusOne,
      prime,
    ] {
      #expect(
        ARDKeyAgreement(
          prime: prime,
          generator: Data([2]),
          peerKey: peerKey,
          keyLength: 128
        ) == nil
      )
    }
  }

  @Test
  func acceptsSafeAppleRemoteDesktopKeyMaterial() {
    let agreement = ARDKeyAgreement(
      prime: appleRemoteDesktopSafePrime,
      generator: Data([2]),
      peerKey: paddedARDValue(2),
      keyLength: 128
    )

    #expect(agreement?.publicKey.count == 128)
    #expect(agreement?.publicKey.contains { $0 != 0 } == true)
    #expect(agreement?.secretKey.count == 128)
    #expect(agreement?.secretKey.contains { $0 != 0 } == true)
  }

  @Test
  func evictsValidatedAppleRemoteDesktopSafePrimesInInsertionOrder() {
    var cache = ARDKeyAgreement.ValidatedSafePrimeCache(capacity: 3)
    let values = (0..<5).map { Data([$0]) }

    for value in values.prefix(3) {
      cache.insert(value)
    }
    cache.insert(values[0])
    cache.insert(values[3])

    #expect(cache.count == 3)
    #expect(!cache.contains(values[0]))
    #expect(cache.contains(values[1]))
    #expect(cache.contains(values[2]))
    #expect(cache.contains(values[3]))

    cache.insert(values[4])

    #expect(cache.count == 3)
    #expect(!cache.contains(values[1]))
    #expect(cache.contains(values[2]))
    #expect(cache.contains(values[3]))
    #expect(cache.contains(values[4]))
  }

  @Test
  func computesUltraVNCModularArithmeticKnownAnswers() {
    #expect(
      UltraVNCBigNum.addM64(
        x: 0xffff_ffff_ffff_fffe,
        y: 0xffff_ffff_ffff_fffd,
        m: 0x61
      ) == 0x14
    )
    #expect(
      UltraVNCBigNum.mulM64(
        x: 0xffff_ffff_ffff_ffc5,
        y: 0xffff_ffff_ffff_ffa3,
        m: 0xffff_ffff_ffff_ff61
      ) == 0x19c8
    )
    #expect(UltraVNCBigNum.powM64(b: 4, e: 13, m: 497) == 445)
    #expect(
      UltraVNCBigNum.powM64(
        b: 0xffff_ffff_ffff_ffc5,
        e: 0x1_2345,
        m: 0xffff_ffff_ffff_ff61
      ) == 0x34be_28a2_05bf_50b9
    )
  }

  @Test
  func rejectsDegenerateUltraVNCKeyAgreementParameters() {
    let eightBytes: (UInt64) -> Data = { value in
      withUnsafeBytes(of: value.bigEndian) { Data($0) }
    }

    for (generator, modulus, response) in [
      (2, 0, 3),
      (2, 1, 3),
      (1, 17, 3),
      (17, 17, 3),
      (2, 17, 1),
      (2, 17, 17),
    ] {
      #expect(
        VNCProtocol.UltraVNCMSLogonIIAuthentication.DiffieHellmanKeyAgreement(
          generator: eightBytes(UInt64(generator)),
          modulus: eightBytes(UInt64(modulus)),
          resp: eightBytes(UInt64(response))
        ) == nil
      )
    }
  }

  @Test
  func rejectsUltraVNCPMinusOneKeyAgreementElements() {
    let modulus = ultraVNCValue(17)

    #expect(
      UltraVNCKeyAgreement(
        generator: ultraVNCValue(16),
        modulus: modulus,
        resp: ultraVNCValue(3)
      ) == nil
    )
    #expect(
      UltraVNCKeyAgreement(
        generator: ultraVNCValue(3),
        modulus: modulus,
        resp: ultraVNCValue(16)
      ) == nil
    )
  }

  @Test
  func acceptsUltraVNCPMinusTwoKeyAgreementElements() {
    let modulus = ultraVNCValue(17)

    #expect(
      UltraVNCKeyAgreement(
        generator: ultraVNCValue(15),
        modulus: modulus,
        resp: ultraVNCValue(3)
      ) != nil
    )
    #expect(
      UltraVNCKeyAgreement(
        generator: ultraVNCValue(3),
        modulus: modulus,
        resp: ultraVNCValue(15)
      ) != nil
    )
  }

  @Test
  func encodesCharactersAsX11KeySyms() {
    #expect(VNCKeyCode.withCharacter("A").map(\.rawValue) == [0x41])
    #expect(VNCKeyCode.withCharacter("é").map(\.rawValue) == [0xe9])
    #expect(VNCKeyCode.withCharacter("α").map(\.rawValue) == [0x0100_03b1])
    #expect(VNCKeyCode.withCharacter("🦀").map(\.rawValue) == [0x0101_f980])
    #expect(
      VNCKeyCode.withCharacter("e\u{301}").map(\.rawValue) == [0x65, 0x0100_0301]
    )
  }

  @Test
  func mapsKeypadDecimalToTheDecimalKeysym() {
    #expect(VNCKeyCode.ansiKeypadDecimal.rawValue == X11KeySymbols.XK_KP_Decimal)
    #expect(VNCKeyCode.ansiKeypadDecimal.rawValue != X11KeySymbols.XK_KP_Separator)

    #if canImport(ObjectiveC)
    #expect(_ObjC_VNCKeyCode.ansiKeypadDecimal == X11KeySymbols.XK_KP_Decimal)
    #endif
  }

  private func paddedARDValue(_ value: UInt8) -> Data {
    Data(repeating: 0, count: 127) + Data([value])
  }

  private var appleRemoteDesktopSafePrime: Data {
    hexadecimalData(
      """
      C692B0343A9FC77AB54DD8F0912F24E657BACB3D4272E6525E624DCBAB26A479
      904118111CCE782B6709522BD201F15C38EDF1B3E94DEAA7DEE91B4B4619607B
      3B76E1A1F9B65F6F545D42982FEE07F1F78D5855E9C490CAD9B45855F6BDEA7
      5BF549643A572571B9F8073EE56A36DD1B9EAD50DCF444406BFDFD851DE76E51B
      """
    )
  }

  private var appleRemoteDesktopUnsafePrime: Data {
    hexadecimalData(
      """
      F1EEAEF06F42BDFEF9524C7A03A6B26F074DC39F74F8C160BD15BA3869F54450
      CE55FD8DA6415AF88CEF7FFE7768BB1A061B7A3C0BCE0023B2C15C0A095D416B
      E103EB8EE3BE0EE5874ADFE2BF7270B8719CC8F99B38BFFC126D6005DBEABAB
      EE0037C10BAFB4D9CC864259DA28E1F5ECB949DCAC308512F9FA3E911F1E36061
      """
    )
  }

  private func hexadecimalData(_ value: String) -> Data {
    let hex = value.filter(\.isHexDigit)
    return Data(
      stride(from: 0, to: hex.count, by: 2).compactMap { offset in
        let start = hex.index(hex.startIndex, offsetBy: offset)
        let end = hex.index(start, offsetBy: 2)
        return UInt8(hex[start..<end], radix: 16)
      })
  }

  private func ultraVNCValue(_ value: UInt64) -> Data {
    withUnsafeBytes(of: value.bigEndian) { Data($0) }
  }
}
