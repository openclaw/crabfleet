#if canImport(FoundationEssentials)
import FoundationEssentials
#else
import Foundation
#endif

import d3des

extension VNCProtocol.UltraVNCMSLogonIIAuthentication {
	struct Authentication {
        let encryptedCredential: Data
        let publicKey: Data

        private init(encryptedCredential: Data,
                     publicKey: Data) {
            self.encryptedCredential = encryptedCredential
            self.publicKey = publicKey
        }

        init?(agreement: DiffieHellmanKeyAgreement,
              username: String,
              password: String) {
            let usernameLength = 256
            let passwordLength = 64

			let key = agreement.secretKey

			guard let encryptedUsername = Self.encrypt(string: username,
													   length: usernameLength,
													   key: key) else {
				return nil
			}

			guard let encryptedPassword = Self.encrypt(string: password,
													   length: passwordLength,
													   key: key) else {
				return nil
			}

            let credentialsLength = usernameLength + passwordLength
            let credentialsData = encryptedUsername + encryptedPassword

			guard credentialsData.count == credentialsLength else {
				return nil
			}

            self.encryptedCredential = credentialsData
            self.publicKey = agreement.publicKey
        }
	}
}

private extension VNCProtocol.UltraVNCMSLogonIIAuthentication.Authentication {
    static func cappedOrPaddedStringData(string: String,
                                         length: Int) -> Data? {
        guard var data = string.data(using: .utf8) else { return nil }

        if data.count > length {
            data = data[0..<length]
        } else {
            let requiredPadding = length - data.count

            guard requiredPadding > 0 else {
                return data
            }

            data.appendPadding(length: .init(requiredPadding))
        }

        guard data.count == length else {
            return nil
        }

        return data
    }

	static func encrypt(string: String,
						length: Int,
						key: Data) -> Data? {
		guard var stringData = Self.cappedOrPaddedStringData(string: string,
															 length: length),
			  stringData.count == length else {
			return nil
		}

		var mutableKey = key

		D3DESLock.shared.lock()
		defer { D3DESLock.shared.unlock() }
		let success = mutableKey.withUnsafeMutableBytes { keyBufferPtr in
			guard let keyPtr = keyBufferPtr.baseAddress?.assumingMemoryBound(to: UInt8.self) else {
				return false
			}

			let encryptSuccess = stringData.withUnsafeMutableBytes { stringDataBufferPtr in
				guard let stringDataPtr = stringDataBufferPtr.baseAddress?.assumingMemoryBound(to: UInt8.self) else {
					return false
				}

				encryptD3DES(target: stringDataPtr,
							 length: length,
							 key: keyPtr)

				return true
			}

			return encryptSuccess
		}

		guard success else {
			return nil
		}

		return stringData
	}

	static func encryptD3DES(target: UnsafeMutablePointer<UInt8>,
							 length: Int,
							 key: UnsafeMutablePointer<UInt8>) {
		for idx in 0..<8 {
			target[idx] ^= key[idx]
		}

		encryptDES(target: target,
				   key: key,
				   source: target,
				   sourceLength: 8)

		for idx in stride(from: 8, to: length, by: 8) {
			for idxJ in 0..<8 {
				target[idx + idxJ] ^= target[idx + idxJ - 8]
			}

			encryptDES(target: target + idx,
					   key: key,
					   source: target + idx,
					   sourceLength: 8)
		}
	}

	static func encryptDES(target: UnsafeMutablePointer<UInt8>,
						   key: UnsafeMutablePointer<UInt8>,
						   source: UnsafeMutablePointer<UInt8>,
						   sourceLength: Int) {
		deskey(key, EN0)

		let eightByteBlocks = sourceLength / 8

		for idx in 0..<eightByteBlocks {
			des(source + idx * 8, target + idx * 8)
		}
	}
}
