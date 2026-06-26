#if canImport(FoundationEssentials)
import FoundationEssentials
#else
import Foundation
#endif

#if canImport(Security)
import Security
#endif

extension VNCProtocol.ARDAuthentication {
    struct Authentication {
        let cipherText: Data
        let publicKey: Data

        private init(cipherText: Data,
                     publicKey: Data) {
            self.cipherText = cipherText
            self.publicKey = publicKey
        }

		init?(agreement: DiffieHellmanKeyAgreement,
			  username: String,
			  password: String) {
            // Get MD5 hash of shared secret
			let secretHash = agreement.secretKey.md5Hash()

            // ciphertext: AES128(shared, username[64]:password[64])
            let credArraySize = 128
            var creds = Data(count: credArraySize)

            let randomCredsDataSuccess = creds.withUnsafeMutableBytes {
                guard let credsBytes = $0.baseAddress else { return false }

#if canImport(Security)
				let randomStatus = SecRandomCopyBytes(kSecRandomDefault, credArraySize, credsBytes)

                guard randomStatus == errSecSuccess else { return false }
#else
				// TODO: Probably not secure
				for i in 0..<credArraySize {
					$0[i] = UInt8.random(in: 0...255)
				}
#endif

                return true
            }

            guard randomCredsDataSuccess else { return nil }

			let usernameBytes = Self.credentialBytes(for: username)
			let passwordBytes = Self.credentialBytes(for: password)
			let passwordOffset = credArraySize / 2

			creds.replaceSubrange(0..<usernameBytes.count, with: usernameBytes)
			creds.replaceSubrange(
				passwordOffset..<(passwordOffset + passwordBytes.count),
				with: passwordBytes
			)

			// Add null bytes to indicate end of c string
			creds[usernameBytes.count] = 0
			creds[passwordOffset + passwordBytes.count] = 0

			guard let cipherText = creds.aes128ECBEncrypted(withKey: secretHash) else {
				return nil
			}

            self.init(cipherText: cipherText,
                      publicKey: agreement.publicKey)
        }

		static func credentialBytes(for value: String) -> Data {
			let maximumBytes = 63
			var result = Data()
			result.reserveCapacity(min(value.utf8.count, maximumBytes))

			for character in value {
				let bytes = String(character).utf8
				guard result.count + bytes.count <= maximumBytes else { break }
				result.append(contentsOf: bytes)
			}

			return result
		}
    }
}
