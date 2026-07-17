import CommonCrypto

#if canImport(FoundationEssentials)
  import FoundationEssentials
#else
  import Foundation
#endif

struct AES128ECBEncryption {
  static func encrypt(
    data: Data,
    key: Data
  ) -> Data? {
    crypt(data: data, key: key, operation: CCOperation(kCCEncrypt))
  }

  static func decrypt(
    data: Data,
    key: Data
  ) -> Data? {
    crypt(data: data, key: key, operation: CCOperation(kCCDecrypt))
  }

  private static func crypt(
    data: Data,
    key: Data,
    operation: CCOperation
  ) -> Data? {
    guard key.count == kCCKeySizeAES128 else { return nil }

    var input = data
    let remainder = input.count % kCCBlockSizeAES128
    if remainder != 0 {
      input.append(Data(repeating: 0, count: kCCBlockSizeAES128 - remainder))
    }
    guard !input.isEmpty else { return Data() }

    var output = Data(count: input.count)
    var moved = 0
    let outputCapacity = output.count
    let status = key.withUnsafeBytes { keyBuffer in
      input.withUnsafeBytes { inputBuffer in
        output.withUnsafeMutableBytes { outputBuffer in
          CCCrypt(
            operation,
            CCAlgorithm(kCCAlgorithmAES),
            CCOptions(kCCOptionECBMode),
            keyBuffer.baseAddress,
            kCCKeySizeAES128,
            nil,
            inputBuffer.baseAddress,
            input.count,
            outputBuffer.baseAddress,
            outputCapacity,
            &moved
          )
        }
      }
    }

    guard status == kCCSuccess, moved == input.count else { return nil }
    return output
  }
}
