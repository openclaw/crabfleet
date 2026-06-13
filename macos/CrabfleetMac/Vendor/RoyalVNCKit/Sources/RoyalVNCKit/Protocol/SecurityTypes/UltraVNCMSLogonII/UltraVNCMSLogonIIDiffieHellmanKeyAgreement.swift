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
        guard generatorNum < maxNum else { return nil }

		let modulusNum = UltraVNCBigNum.dataToBigNum(modulus)
        guard modulusNum < maxNum else { return nil }

		let privNum = UltraVNCBigNum.randomBigNum(max: .init(maxNum))
        guard privNum < maxNum else { return nil }

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
        guard respNum < maxNum else { return nil }

		let keyNum = UltraVNCBigNum.powM64(b: .init(respNum),
									   e: .init(privNum),
									   m: .init(modulusNum))

		let keyData = UltraVNCBigNum.bigNumToData(.init(keyNum))

        return keyData
    }
}
