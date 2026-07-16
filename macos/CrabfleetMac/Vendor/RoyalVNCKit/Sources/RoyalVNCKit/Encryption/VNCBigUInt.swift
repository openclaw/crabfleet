import Foundation
import Security

struct VNCBigUInt: Comparable {
  private static let wordBits = 32
  private static let wordBase = UInt64(1) << 32
  private static let wordMask = wordBase - 1

  private var words: [UInt32]

  init() {
    self.words = []
  }

  init(_ small: UInt) {
    let low = UInt32(truncatingIfNeeded: small)
    let high = UInt32(truncatingIfNeeded: small >> 32)
    self.words = high == 0 ? (low == 0 ? [] : [low]) : [low, high]
  }

  init(bigEndianData data: Data) {
    let bytes = [UInt8](data)
    var parsed = [UInt32]()
    parsed.reserveCapacity((bytes.count + 3) / 4)

    var end = bytes.count
    while end > 0 {
      let start = max(0, end - 4)
      var word: UInt32 = 0
      for byte in bytes[start..<end] {
        word = (word << 8) | UInt32(byte)
      }
      parsed.append(word)
      end = start
    }
    self.init(words: parsed)
  }

  private init(words: [UInt32]) {
    self.words = words
    normalize()
  }

  static func == (lhs: Self, rhs: Self) -> Bool {
    lhs.words == rhs.words
  }

  static func < (lhs: Self, rhs: Self) -> Bool {
    guard lhs.words.count == rhs.words.count else {
      return lhs.words.count < rhs.words.count
    }
    for index in lhs.words.indices.reversed() where lhs.words[index] != rhs.words[index] {
      return lhs.words[index] < rhs.words[index]
    }
    return false
  }

  static func + (lhs: Self, rhs: Self) -> Self {
    let count = max(lhs.words.count, rhs.words.count)
    var result = [UInt32](repeating: 0, count: count)
    var carry: UInt64 = 0

    for index in 0..<count {
      let left = index < lhs.words.count ? UInt64(lhs.words[index]) : 0
      let right = index < rhs.words.count ? UInt64(rhs.words[index]) : 0
      let sum = left + right + carry
      result[index] = UInt32(truncatingIfNeeded: sum)
      carry = sum >> wordBits
    }
    if carry != 0 {
      result.append(UInt32(carry))
    }
    return Self(words: result)
  }

  static func - (lhs: Self, rhs: Self) -> Self {
    precondition(lhs >= rhs)
    var result = lhs.words
    var borrow: UInt64 = 0

    for index in result.indices {
      let right = (index < rhs.words.count ? UInt64(rhs.words[index]) : 0) + borrow
      let left = UInt64(result[index])
      if left < right {
        result[index] = UInt32(left + wordBase - right)
        borrow = 1
      } else {
        result[index] = UInt32(left - right)
        borrow = 0
      }
    }
    precondition(borrow == 0)
    return Self(words: result)
  }

  static func * (lhs: Self, rhs: Self) -> Self {
    guard !lhs.isZero, !rhs.isZero else { return Self() }
    var result = [UInt32](repeating: 0, count: lhs.words.count + rhs.words.count)

    for leftIndex in lhs.words.indices {
      var carry: UInt64 = 0
      for rightIndex in rhs.words.indices {
        let resultIndex = leftIndex + rightIndex
        let product =
          UInt64(lhs.words[leftIndex]) * UInt64(rhs.words[rightIndex])
          + UInt64(result[resultIndex]) + carry
        result[resultIndex] = UInt32(truncatingIfNeeded: product)
        carry = product >> wordBits
      }
      result[leftIndex + rhs.words.count] = UInt32(carry)
    }
    return Self(words: result)
  }

  var isZero: Bool {
    words.isEmpty
  }

  var bitWidth: Int {
    guard let high = words.last else { return 0 }
    return (words.count - 1) * Self.wordBits + (Self.wordBits - high.leadingZeroBitCount)
  }

  var bigEndianData: Data {
    guard let high = words.last else { return Data() }
    var data = Data()
    data.reserveCapacity((bitWidth + 7) / 8)

    var emittedHighWord = false
    for word in words.reversed() {
      for shift in stride(from: 24, through: 0, by: -8) {
        let byte = UInt8(truncatingIfNeeded: word >> UInt32(shift))
        if emittedHighWord || byte != 0 || word != high {
          data.append(byte)
          emittedHighWord = true
        }
      }
    }
    return data
  }

  func shiftedRight(_ count: Int) -> Self {
    precondition(count >= 0)
    guard count != 0, !isZero else { return self }
    let wordShift = count / Self.wordBits
    let bitShift = count % Self.wordBits
    guard wordShift < words.count else { return Self() }

    var result = [UInt32](repeating: 0, count: words.count - wordShift)
    for sourceIndex in wordShift..<words.count {
      let destination = sourceIndex - wordShift
      result[destination] |= words[sourceIndex] >> UInt32(bitShift)
      if bitShift != 0, sourceIndex + 1 < words.count {
        result[destination] |= words[sourceIndex + 1] << UInt32(Self.wordBits - bitShift)
      }
    }
    return Self(words: result)
  }

  func quotientAndRemainder(dividingBy divisor: Self) -> (quotient: Self, remainder: Self) {
    precondition(!divisor.isZero)
    guard self >= divisor else { return (Self(), self) }
    if divisor.words.count == 1 {
      let result = dividedByWord(divisor.words[0])
      return (result.quotient, Self(UInt(result.remainder)))
    }

    // Knuth algorithm D: normalize the divisor, estimate one quotient word, then correct.
    let divisorCount = divisor.words.count
    let dividendCount = words.count
    let quotientHighIndex = dividendCount - divisorCount
    let shift = divisor.words[divisorCount - 1].leadingZeroBitCount
    let normalizedDivisor = Self.shiftedLeftWords(
      divisor.words, by: shift, outputCount: divisorCount)
    var normalizedDividend = Self.shiftedLeftWords(words, by: shift, outputCount: dividendCount + 1)
    var quotient = [UInt32](repeating: 0, count: quotientHighIndex + 1)
    let divisorHigh = UInt64(normalizedDivisor[divisorCount - 1])

    for quotientIndex in stride(from: quotientHighIndex, through: 0, by: -1) {
      let top = UInt64(normalizedDividend[quotientIndex + divisorCount])
      let next = UInt64(normalizedDividend[quotientIndex + divisorCount - 1])
      var estimate: UInt64
      var remainderEstimate: UInt64

      if top == divisorHigh {
        estimate = Self.wordBase - 1
        remainderEstimate = next + divisorHigh
      } else {
        let numerator = (top << Self.wordBits) | next
        estimate = numerator / divisorHigh
        remainderEstimate = numerator % divisorHigh
      }

      if divisorCount > 1 {
        let divisorNext = UInt64(normalizedDivisor[divisorCount - 2])
        let dividendNext = UInt64(normalizedDividend[quotientIndex + divisorCount - 2])
        while remainderEstimate < Self.wordBase,
          estimate * divisorNext > (remainderEstimate << Self.wordBits) + dividendNext
        {
          estimate -= 1
          remainderEstimate += divisorHigh
        }
      }

      var borrow: UInt64 = 0
      for divisorIndex in 0..<divisorCount {
        let product = estimate * UInt64(normalizedDivisor[divisorIndex]) + borrow
        let productLow = product & Self.wordMask
        let dividendIndex = quotientIndex + divisorIndex
        let current = UInt64(normalizedDividend[dividendIndex])
        if current < productLow {
          normalizedDividend[dividendIndex] = UInt32(current + Self.wordBase - productLow)
          borrow = (product >> Self.wordBits) + 1
        } else {
          normalizedDividend[dividendIndex] = UInt32(current - productLow)
          borrow = product >> Self.wordBits
        }
      }

      let highIndex = quotientIndex + divisorCount
      let high = UInt64(normalizedDividend[highIndex])
      if high < borrow {
        estimate -= 1
        var carry: UInt64 = 0
        for divisorIndex in 0..<divisorCount {
          let dividendIndex = quotientIndex + divisorIndex
          let sum =
            UInt64(normalizedDividend[dividendIndex])
            + UInt64(normalizedDivisor[divisorIndex]) + carry
          normalizedDividend[dividendIndex] = UInt32(truncatingIfNeeded: sum)
          carry = sum >> Self.wordBits
        }
        normalizedDividend[highIndex] = UInt32(
          truncatingIfNeeded: high + Self.wordBase - borrow + carry
        )
      } else {
        normalizedDividend[highIndex] = UInt32(high - borrow)
      }
      quotient[quotientIndex] = UInt32(estimate)
    }

    let normalizedRemainder = Array(normalizedDividend.prefix(divisorCount))
    let remainder = Self(words: normalizedRemainder).shiftedRight(shift)
    return (Self(words: quotient), remainder)
  }

  static func random(lessThan bound: Self) -> Self? {
    guard !bound.isZero else { return nil }
    let byteCount = (bound.bitWidth + 7) / 8
    let excessBits = byteCount * 8 - bound.bitWidth

    while true {
      var bytes = [UInt8](repeating: 0, count: byteCount)
      guard SecRandomCopyBytes(kSecRandomDefault, byteCount, &bytes) == errSecSuccess else {
        return nil
      }
      if excessBits != 0 {
        bytes[0] &= UInt8(0xFF >> excessBits)
      }
      let candidate = Self(bigEndianData: Data(bytes))
      if candidate < bound {
        return candidate
      }
    }
  }

  static func modPow(base: Self, exponent: Self, modulus: Self) -> Self {
    precondition(!modulus.isZero)
    guard modulus != Self(1) else { return Self() }
    precondition(modulus.isOdd, "Montgomery reduction requires an odd modulus")

    let reducer = MontgomeryReducer(modulus: modulus)
    let montgomeryBase = reducer.convert(base)
    var result = reducer.convert(Self(1))
    guard !exponent.isZero else { return reducer.reduce(result) }

    let windowWidth = 4
    let squaredBase = reducer.multiply(montgomeryBase, montgomeryBase)
    var oddPowers = [montgomeryBase]
    oddPowers.reserveCapacity(1 << (windowWidth - 1))
    for _ in 1..<(1 << (windowWidth - 1)) {
      oddPowers.append(reducer.multiply(oddPowers.last!, squaredBase))
    }

    var bitIndex = exponent.bitWidth - 1
    while bitIndex >= 0 {
      if !exponent.bit(at: bitIndex) {
        result = reducer.multiply(result, result)
        bitIndex -= 1
        continue
      }

      var low = max(0, bitIndex - windowWidth + 1)
      while !exponent.bit(at: low) {
        low += 1
      }
      var value = 0
      for index in stride(from: bitIndex, through: low, by: -1) {
        value = (value << 1) | (exponent.bit(at: index) ? 1 : 0)
        result = reducer.multiply(result, result)
      }
      result = reducer.multiply(result, oddPowers[(value - 1) / 2])
      bitIndex = low - 1
    }
    return reducer.reduce(result)
  }

  func isProbablePrime(rounds: Int) -> Bool {
    precondition(rounds > 0)
    let two = Self(2)
    let three = Self(3)
    guard self >= two else { return false }
    if self == two || self == three { return true }
    guard isOdd else { return false }

    let smallPrimes: [UInt32] = [
      3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37, 41, 43, 47, 53, 59, 61, 67,
      71, 73, 79, 83, 89, 97, 101, 103, 107, 109, 113, 127, 131, 137, 139,
      149, 151, 157, 163, 167, 173, 179, 181, 191, 193, 197, 199, 211, 223,
      227, 229, 233, 239, 241, 251,
    ]
    for prime in smallPrimes {
      if self == Self(UInt(prime)) { return true }
      if dividedByWord(prime).remainder == 0 { return false }
    }

    let one = Self(1)
    let nMinusOne = self - one
    var d = nMinusOne
    var powerOfTwo = 0
    while !d.isOdd {
      d = d.shiftedRight(1)
      powerOfTwo += 1
    }
    let baseRange = self - Self(3)

    for _ in 0..<rounds {
      guard let random = Self.random(lessThan: baseRange) else { return false }
      let base = random + two
      var witness = Self.modPow(base: base, exponent: d, modulus: self)
      if witness == one || witness == nMinusOne { continue }

      var passed = false
      if powerOfTwo > 1 {
        for _ in 1..<powerOfTwo {
          witness = Self.modPow(base: witness, exponent: two, modulus: self)
          if witness == nMinusOne {
            passed = true
            break
          }
          if witness == one { return false }
        }
      }
      if !passed { return false }
    }
    return true
  }
}

extension VNCBigUInt {
  var isOdd: Bool {
    words.first.map { $0 & 1 == 1 } ?? false
  }

  fileprivate mutating func normalize() {
    while words.last == 0 {
      words.removeLast()
    }
  }

  fileprivate func bit(at index: Int) -> Bool {
    let word = index / Self.wordBits
    let bit = index % Self.wordBits
    guard word < words.count else { return false }
    return words[word] & (UInt32(1) << UInt32(bit)) != 0
  }

  fileprivate func dividedByWord(_ divisor: UInt32) -> (quotient: Self, remainder: UInt32) {
    precondition(divisor != 0)
    var quotient = [UInt32](repeating: 0, count: words.count)
    var remainder: UInt64 = 0
    for index in words.indices.reversed() {
      let dividend = (remainder << Self.wordBits) | UInt64(words[index])
      quotient[index] = UInt32(dividend / UInt64(divisor))
      remainder = dividend % UInt64(divisor)
    }
    return (Self(words: quotient), UInt32(remainder))
  }

  fileprivate static func shiftedLeftWords(_ source: [UInt32], by shift: Int, outputCount: Int)
    -> [UInt32]
  {
    precondition(shift >= 0 && shift < wordBits)
    var output = [UInt32](repeating: 0, count: outputCount)
    var carry: UInt64 = 0
    for index in source.indices {
      let value = (UInt64(source[index]) << shift) | carry
      output[index] = UInt32(truncatingIfNeeded: value)
      carry = value >> wordBits
    }
    if source.count < outputCount {
      output[source.count] = UInt32(carry)
    }
    return output
  }

  fileprivate struct MontgomeryReducer {
    let modulus: VNCBigUInt
    let count: Int
    let factor: UInt32
    let rSquared: VNCBigUInt

    init(modulus: VNCBigUInt) {
      precondition(modulus.isOdd)
      self.modulus = modulus
      self.count = modulus.words.count

      let low = modulus.words[0]
      var inverse: UInt32 = 1
      for _ in 0..<5 {
        inverse = inverse &* (2 &- low &* inverse)
      }
      self.factor = 0 &- inverse

      var rSquaredWords = [UInt32](repeating: 0, count: modulus.words.count * 2 + 1)
      rSquaredWords[modulus.words.count * 2] = 1
      self.rSquared =
        VNCBigUInt(words: rSquaredWords)
        .quotientAndRemainder(dividingBy: modulus).remainder
    }

    func convert(_ value: VNCBigUInt) -> VNCBigUInt {
      let reduced = value.quotientAndRemainder(dividingBy: modulus).remainder
      return multiply(reduced, rSquared)
    }

    func reduce(_ value: VNCBigUInt) -> VNCBigUInt {
      multiply(value, VNCBigUInt(1))
    }

    func multiply(_ lhs: VNCBigUInt, _ rhs: VNCBigUInt) -> VNCBigUInt {
      var left = lhs.words
      var right = rhs.words
      left += repeatElement(0, count: max(0, count - left.count))
      right += repeatElement(0, count: max(0, count - right.count))
      var accumulator = [UInt32](repeating: 0, count: count + 2)

      for leftIndex in 0..<count {
        var carry: UInt64 = 0
        for rightIndex in 0..<count {
          let sum =
            UInt64(accumulator[rightIndex])
            + UInt64(left[leftIndex]) * UInt64(right[rightIndex]) + carry
          accumulator[rightIndex] = UInt32(truncatingIfNeeded: sum)
          carry = sum >> VNCBigUInt.wordBits
        }
        var highSum = UInt64(accumulator[count]) + carry
        accumulator[count] = UInt32(truncatingIfNeeded: highSum)
        accumulator[count + 1] = UInt32(highSum >> VNCBigUInt.wordBits)

        let reductionWord = accumulator[0] &* factor
        carry = 0
        for modulusIndex in 0..<count {
          let sum =
            UInt64(accumulator[modulusIndex])
            + UInt64(reductionWord) * UInt64(modulus.words[modulusIndex]) + carry
          accumulator[modulusIndex] = UInt32(truncatingIfNeeded: sum)
          carry = sum >> VNCBigUInt.wordBits
        }
        highSum = UInt64(accumulator[count]) + carry
        accumulator[count] = UInt32(truncatingIfNeeded: highSum)
        accumulator[count + 1] &+= UInt32(highSum >> VNCBigUInt.wordBits)

        for index in 0...count {
          accumulator[index] = accumulator[index + 1]
        }
        accumulator[count + 1] = 0
      }

      var result = VNCBigUInt(words: Array(accumulator.prefix(count + 1)))
      if result >= modulus {
        result = result - modulus
      }
      return result
    }
  }
}
