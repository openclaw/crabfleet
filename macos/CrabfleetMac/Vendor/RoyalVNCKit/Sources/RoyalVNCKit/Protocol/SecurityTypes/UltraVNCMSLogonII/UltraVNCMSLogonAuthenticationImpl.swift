#if canImport(FoundationEssentials)
import FoundationEssentials
#else
import Foundation
#endif

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

		let keyBytes = Array(key.prefix(8))
		guard keyBytes.count == 8,
			  encryptBlocks(target: &stringData,
							 length: length,
							 key: keyBytes) else {
			return nil
		}

		return stringData
	}

	static func encryptBlocks(target: inout Data,
							 length: Int,
							 key: [UInt8]) -> Bool {
		for idx in 0..<8 {
			target[idx] ^= key[idx]
		}

		guard encryptDES(target: &target,
						 offset: 0,
						 key: key) else {
			return false
		}

		for idx in stride(from: 8, to: length, by: 8) {
			for idxJ in 0..<8 {
				target[idx + idxJ] ^= target[idx + idxJ - 8]
			}

			guard encryptDES(target: &target,
							 offset: idx,
							 key: key) else {
				return false
			}
		}

		return true
	}

	static func encryptDES(target: inout Data,
						   offset: Int,
						   key: [UInt8]) -> Bool {
		let range = offset..<(offset + 8)
		guard let encrypted = VNCDESEncryption.encryptBlocks(Data(target[range]), keyBytes: key) else {
			return false
		}
		target.replaceSubrange(range, with: encrypted)
		return true
	}
}
