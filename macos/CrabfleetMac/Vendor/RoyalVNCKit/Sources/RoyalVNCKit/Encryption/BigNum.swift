#if canImport(FoundationEssentials)
  import FoundationEssentials
#else
  import Foundation
#endif

final class BigNum {
  private var bigInt: VNCBigUInt

  init() {
    self.bigInt = VNCBigUInt()
  }

  init?(data: Data) {
    self.bigInt = VNCBigUInt(bigEndianData: data)
  }

  private init(_ value: VNCBigUInt) {
    self.bigInt = value
  }
}

extension BigNum {
  var isGreaterThanOne: Bool {
    bigInt > VNCBigUInt(1)
  }

  func isValidDiffieHellmanElement(modulus: BigNum) -> Bool {
    guard modulus.bigInt > VNCBigUInt(2) else { return false }
    return bigInt > VNCBigUInt(1) && bigInt < modulus.bigInt - VNCBigUInt(1)
  }

  var isZero: Bool {
    bigInt.isZero
  }

  var bytesCount: Int32 {
    Int32(bigInt.bigEndianData.count)
  }

  var bitsCount: Int32 {
    Int32(bigInt.bitWidth)
  }

  func rand(range: BigNum) -> Bool {
    guard let random = VNCBigUInt.random(lessThan: range.bigInt) else { return false }
    bigInt = random
    return true
  }

  static func modExp(
    y: BigNum,
    g: BigNum,
    x: BigNum,
    p: BigNum
  ) -> Bool {
    // Montgomery reduction requires an odd modulus; fail instead of trapping.
    guard !p.bigInt.isZero, p.bigInt.isOdd else { return false }
    y.bigInt = VNCBigUInt.modPow(base: g.bigInt, exponent: x.bigInt, modulus: p.bigInt)
    return true
  }

  func isProbablePrime(rounds: Int) -> Bool {
    bigInt.isProbablePrime(rounds: rounds)
  }

  var halvedPredecessor: BigNum? {
    guard !bigInt.isZero else { return nil }
    return BigNum((bigInt - VNCBigUInt(1)).shiftedRight(1))
  }

  func bigEndianData() -> Data? {
    bigInt.bigEndianData
  }
}
