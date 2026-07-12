import Foundation
import Testing

@testable import RoyalVNCKit

struct SecurityAndInputTests {
  typealias ARDKeyAgreement = VNCProtocol.ARDAuthentication.DiffieHellmanKeyAgreement
  typealias UltraVNCBigNum =
    VNCProtocol.UltraVNCMSLogonIIAuthentication.DiffieHellmanKeyAgreement.UltraVNCBigNum

  @Test
  func rejectsZeroAndOneAppleRemoteDesktopModuli() {
    for prime in [Data([0]), Data([1]), Data([0, 1])] {
      let agreement = ARDKeyAgreement(
        prime: prime,
        generator: Data([2]),
        peerKey: Data([2]),
        keyLength: prime.count
      )

      #expect(agreement.map { _ in true } == nil)
    }
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
  func encodesCharactersAsX11KeySyms() {
    #expect(VNCKeyCode.withCharacter("A").map(\.rawValue) == [0x41])
    #expect(VNCKeyCode.withCharacter("é").map(\.rawValue) == [0xe9])
    #expect(VNCKeyCode.withCharacter("α").map(\.rawValue) == [0x0100_03b1])
    #expect(VNCKeyCode.withCharacter("🦀").map(\.rawValue) == [0x0101_f980])
  }

  @Test
  func mapsKeypadDecimalToTheDecimalKeysym() {
    #expect(VNCKeyCode.ansiKeypadDecimal.rawValue == X11KeySymbols.XK_KP_Decimal)
    #expect(VNCKeyCode.ansiKeypadDecimal.rawValue != X11KeySymbols.XK_KP_Separator)

    #if canImport(ObjectiveC)
    #expect(_ObjC_VNCKeyCode.ansiKeypadDecimal == X11KeySymbols.XK_KP_Decimal)
    #endif
  }
}
