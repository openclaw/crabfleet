#if canImport(FoundationEssentials)
import FoundationEssentials
#else
import Foundation
#endif

extension VNCProtocol.UltraVNCMSLogonIIAuthentication {
    struct DiffieHellmanKeyAgreement {
        static let maxBits = 31
        static let maxNum = ((UInt64(1)) << maxBits) - 1

        let publicKey: Data
        let privateKey: Data
        let secretKey: Data

        init?(generator: Data,
              modulus: Data,
              resp: Data) {
            guard let keyPair = Self.generateKeyPair(generator: generator,
                                                     modulus: modulus) else {
                return nil
            }

            guard let secretKey = Self.computeSharedKey(modulus: modulus,
                                                        resp: resp,
                                                        privateKey: keyPair.privateKey),
                  !secretKey.isEmpty else {
                return nil
            }

            self.publicKey = keyPair.publicKey
            self.privateKey = keyPair.privateKey
            self.secretKey = secretKey
        }
    }
}

private extension VNCProtocol.UltraVNCMSLogonIIAuthentication.DiffieHellmanKeyAgreement {
    struct KeyPair {
        let publicKey: Data
        let privateKey: Data
    }

    static func generateKeyPair(generator: Data,
                                modulus: Data) -> KeyPair? {
		let generatorNum = UltraVNCBigNum.dataToBigNum(generator)
		let modulusNum = UltraVNCBigNum.dataToBigNum(modulus)
        guard modulusNum > 3,
              modulusNum < maxNum,
              generatorNum > 1,
              generatorNum <= modulusNum - 2 else {
            return nil
        }

        let privNum = UInt64.random(in: 2..<(modulusNum - 1))

		let privData = UltraVNCBigNum.bigNumToData(privNum)

		let pubNum = UltraVNCBigNum.powM64(b: .init(generatorNum),
									   e: .init(privNum),
									   m: .init(modulusNum))

		let pubData = UltraVNCBigNum.bigNumToData(.init(pubNum))

        let keyPair = KeyPair(publicKey: pubData,
                              privateKey: privData)

        return keyPair
    }

    static func computeSharedKey(modulus: Data,
                                 resp: Data,
                                 privateKey: Data) -> Data? {
		let privNum = UltraVNCBigNum.dataToBigNum(privateKey)
		let modulusNum = UltraVNCBigNum.dataToBigNum(modulus)

		let respNum = UltraVNCBigNum.dataToBigNum(resp)
        guard modulusNum > 3,
              modulusNum < maxNum,
              privNum > 1,
              privNum < modulusNum,
              respNum > 1,
              respNum <= modulusNum - 2 else {
            return nil
        }

		let keyNum = UltraVNCBigNum.powM64(b: .init(respNum),
									   e: .init(privNum),
									   m: .init(modulusNum))

		let keyData = UltraVNCBigNum.bigNumToData(.init(keyNum))

        return keyData
    }
}
