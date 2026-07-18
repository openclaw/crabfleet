#if canImport(FoundationEssentials)
import FoundationEssentials
#else
import Foundation
#endif

#if canImport(Security)
import Security
#endif

public enum VNCHostAuthentication {
  public static let challengeLength = 16

  public static func makeChallenge() throws -> Data {
    var challenge = Data(count: challengeLength)
    let generated = challenge.withUnsafeMutableBytes { bytes -> Bool in
      guard let address = bytes.baseAddress else { return false }
      #if canImport(Security)
      return SecRandomCopyBytes(kSecRandomDefault, challengeLength, address) == errSecSuccess
      #else
      return false
      #endif
    }
    guard generated else { throw VNCHostAuthenticationError.randomGenerationFailed }
    return challenge
  }

  public static func response(challenge: Data, candidate: String) -> Data? {
    guard challenge.count == challengeLength else { return nil }
    return VNCDESEncryption.encrypt(data: challenge, key: candidate)
  }

  public static func verifies(response: Data, challenge: Data, candidate: String) -> Bool {
    guard let expected = self.response(challenge: challenge, candidate: candidate),
      response.count == expected.count
    else {
      return false
    }
    var difference: UInt8 = 0
    for (received, wanted) in zip(response, expected) {
      difference |= received ^ wanted
    }
    return difference == 0
  }
}

public enum VNCHostAuthenticationError: Error {
  case randomGenerationFailed
}
