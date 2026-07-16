import Foundation
import Testing

@testable import RoyalVNCKit

struct OSCryptoMigrationTests {
  @Test
  func hashesMD5WithRFC1321KnownAnswer() {
    #expect(Data("abc".utf8).md5Hash() == hexadecimalData("900150983cd24fb0d6963f7d28e17f72"))
  }

  @Test
  func encryptsAES128ECBKnownAnswers() {
    let key = hexadecimalData("000102030405060708090a0b0c0d0e0f")
    let block = hexadecimalData("00112233445566778899aabbccddeeff")
    #expect(
      AES128ECBEncryption.encrypt(data: block, key: key)
        == hexadecimalData("69c4e0d86a7b0430d8cdb78070b4c55a")
    )

    let partialBlock = hexadecimalData("0011223344")
    #expect(
      AES128ECBEncryption.encrypt(data: partialBlock, key: key)
        == hexadecimalData("a28e192e0c957630e1521839b7eccd27")
    )
  }

  @Test
  func computesModularExponentiationKnownAnswers() {
    #expect(
      VNCBigUInt.modPow(
        base: VNCBigUInt(4),
        exponent: VNCBigUInt(13),
        modulus: VNCBigUInt(497)
      ) == VNCBigUInt(445)
    )

    let modulus = bigUInt(
      """
      FFFFFFFFFFFFFFFFC90FDAA22168C234C4C6628B80DC1CD129024E088A67CC74
      020BBEA63B139B22514A08798E3404DDEF9519B3CD3A431B302B0A6DF25F1437
      4FE1356D6D51C245E485B576625E7EC6F44C42E9A637ED6B0BFF5CB6F406B7ED
      EE386BFB5A899FA5AE9F24117C4B1FE649286651ECE65381FFFFFFFFFFFFFFFF
      """
    )
    let result = VNCBigUInt.modPow(
      base: bigUInt("FEDCBA98765432100123456789ABCDEF"),
      exponent: bigUInt("123456789ABCDEF00112233445566778899AABBCCDDEEFF0FEDCBA9876543210"),
      modulus: modulus
    )
    #expect(
      result
        == bigUInt(
          """
          669E414B398DEC5A82799F263E51083068F1A711A9C440F3140B6161B64C0CD2
          BB13A993351917F4850F0F02292E38CB3741DA5FC3ECC76E4C0C53C47BD2F97
          FDBCF4E580DE5EC4BA0543FDD10758974894A9BFC32E73CD93B383AFC4F1C952
          32C75CA50F602D97295150A9543D6C72481168B89F4FD01D72BC17728710E9FD7
          """
        )
    )
  }

  @Test
  func performsMultiwordArithmeticKnownAnswers() {
    let left = bigUInt(
      "f123456789abcdef00112233445566778899aabbccddeeff0123456789abcdef"
        + "0123456789abcdef00112233445566778899aabbccddeeff0123456789abcdef"
    )
    let right = bigUInt("1fedcba9876543210ffeeddccbbaa99887766554433221100fedcba98765432101")

    #expect(
      left + right
        == bigUInt(
          "f123456789abcdef00112233445566778899aabbccddeeff0123456789abce0e"
            + "eeeeeeeeeeeeeefefefefefefefefefefefefefefefeff0eeeeeeeeeeeeeeef0"
        )
    )
    #expect(
      left - right
        == bigUInt(
          "f123456789abcdef00112233445566778899aabbccddeeff0123456789abcdcf"
            + "13579be02468acdf0123456789abcdf0123456789abcdeef13579be02468acee"
        )
    )
    #expect(
      left * right
        == bigUInt(
          "1e1342e5726129421136c2b50dccf27e5e7092a27e030f812422a1d717b91072"
            + "f23c757d86b324fe2aaebc75fd74febcacf5b4c80d62a5b4365843b68ea9e620"
            + "f02821870340eaab1876f8bfeea70b3d4d8421248e5e9532212490ce65dfc49cef"
        )
    )
    let division = left.quotientAndRemainder(dividingBy: right)
    #expect(
      division.quotient
        == bigUInt("78d660ed2f52ac2f1a6a3f8fbf6ec09d2c6ac9ab03b11daf3bf7d234df4a029"))
    #expect(
      division.remainder
        == bigUInt("13d057db3df1f3988d171aa35f3012e3ea12c65e5a107ac47f2104ca629b56e4c6"))
  }

  @Test
  func recognizesRFC2409OakleyGroup2SafePrime() {
    let prime = BigNum(data: oakleyGroup2Prime)!
    #expect(prime.isProbablePrime(rounds: 16))
    #expect(prime.halvedPredecessor?.isProbablePrime(rounds: 16) == true)
  }

  @Test
  func rejectsCompositeProbablePrimes() {
    #expect(!VNCBigUInt(561).isProbablePrime(rounds: 16))
    let composite = VNCBigUInt(bigEndianData: oakleyGroup2Prime) + VNCBigUInt(2)
    #expect(!composite.isProbablePrime(rounds: 16))
  }

  @Test
  func samplesUniformRandomValuesWithinRange() {
    let range = BigNum(data: Data([0x01, 0x00, 0x01]))!
    let sample = BigNum()
    var values = Set<Data>()
    for _ in 0..<128 {
      #expect(sample.rand(range: range))
      let value = sample.bigEndianData()!
      #expect(VNCBigUInt(bigEndianData: value) < VNCBigUInt(bigEndianData: range.bigEndianData()!))
      values.insert(value)
    }
    #expect(values.count > 1)
  }

  private var oakleyGroup2Prime: Data {
    hexadecimalData(
      """
      FFFFFFFFFFFFFFFFC90FDAA22168C234C4C6628B80DC1CD129024E088A67CC74
      020BBEA63B139B22514A08798E3404DDEF9519B3CD3A431B302B0A6DF25F1437
      4FE1356D6D51C245E485B576625E7EC6F44C42E9A637ED6B0BFF5CB6F406B7ED
      EE386BFB5A899FA5AE9F24117C4B1FE649286651ECE65381FFFFFFFFFFFFFFFF
      """
    )
  }

  private func bigUInt(_ value: String) -> VNCBigUInt {
    VNCBigUInt(bigEndianData: hexadecimalData(value))
  }

  private func hexadecimalData(_ value: String) -> Data {
    var hex = value.filter(\.isHexDigit)
    if !hex.count.isMultiple(of: 2) {
      hex = "0" + hex
    }
    return Data(
      stride(from: 0, to: hex.count, by: 2).map { offset in
        let start = hex.index(hex.startIndex, offsetBy: offset)
        let end = hex.index(start, offsetBy: 2)
        return UInt8(hex[start..<end], radix: 16)!
      }
    )
  }
}
