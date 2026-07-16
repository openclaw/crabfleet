import Foundation
import Testing

@testable import RoyalVNCKit

struct VNCDESKnownAnswerTests {
  @Test
  func matchesVendoredD3DESKnownAnswers() {
    let sequential = Data((0...15).map(UInt8.init))
    #expect(
      VNCDESEncryption.encrypt(data: sequential, key: "12345678")
        == data(hex: "83dd2b4dbd04367f28578fdd5b142740")
    )

    let allOnes = Data(repeating: 0xFF, count: 16)
    #expect(
      VNCDESEncryption.encrypt(data: allOnes, key: "abc")
        == data(hex: "e321a7ecc547e65be321a7ecc547e65b")
    )

    #expect(
      VNCDESEncryption.encryptBlocks(Data(repeating: 0, count: 8), keyBytes: [UInt8](repeating: 0, count: 8))
        == data(hex: "8ca64de9c1b123a7")
    )
  }

  @Test
  func concurrentEncryptionMatchesSerialResults() {
    let input = Data((0...15).map(UInt8.init))
    let keys = (0..<8).map { "key\($0)" }
    let expected = keys.map { VNCDESEncryption.encrypt(data: input, key: $0) }
    let lock = NSLock()
    var actual = [Data?](repeating: nil, count: keys.count)

    DispatchQueue.concurrentPerform(iterations: keys.count) { index in
      let encrypted = VNCDESEncryption.encrypt(data: input, key: keys[index])
      lock.lock()
      actual[index] = encrypted
      lock.unlock()
    }

    #expect(actual == expected)
  }

  private func data(hex: String) -> Data {
    Data(stride(from: 0, to: hex.count, by: 2).map { offset in
      let start = hex.index(hex.startIndex, offsetBy: offset)
      let end = hex.index(start, offsetBy: 2)
      return UInt8(hex[start..<end], radix: 16)!
    })
  }
}
