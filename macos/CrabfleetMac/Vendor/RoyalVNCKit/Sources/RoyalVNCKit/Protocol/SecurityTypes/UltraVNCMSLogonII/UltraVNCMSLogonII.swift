#if canImport(FoundationEssentials)
import FoundationEssentials
#else
import Foundation
#endif

extension VNCProtocol {
	struct UltraVNCMSLogonIIAuthentication: VNCSecurityType {
		static let authenticationType = VNCAuthenticationType.ultraVNCMSLogonII
		let authenticationType: VNCAuthenticationType = Self.authenticationType

		let generator: Data
		let modulus: Data
		let resp: Data

		fileprivate init?(generator: Data,
						  modulus: Data,
						  resp: Data) {
			guard generator.count == 8,
				  modulus.count == 8,
				  resp.count == 8 else {
				return nil
			}

			self.generator = generator
			self.modulus = modulus
			self.resp = resp
		}
	}
}

extension VNCProtocol.UltraVNCMSLogonIIAuthentication {
	static func receive(connection: NetworkConnectionReading) async throws -> Self {
		let generator = try await connection.readBuffered(length: 8)
		let modulus = try await connection.readBuffered(length: 8)
		let resp = try await connection.readBuffered(length: 8)

		guard let auth = Self(generator: generator,
							  modulus: modulus,
							  resp: resp) else {
			throw VNCError.protocol(.invalidData)
		}

		return auth
	}

	func send(connection: NetworkConnectionWriting,
			  credential: VNCUsernamePasswordCredential) async throws {
		let authResult = try authenticate(credential: credential)

		try await Self.sendResponse(connection: connection,
                                    publicKey: authResult.publicKey,
                                    credentials: authResult.encryptedCredential)
	}
}

private extension VNCProtocol.UltraVNCMSLogonIIAuthentication {
	static func sendResponse(connection: NetworkConnectionWriting,
							 publicKey: Data,
							 credentials: Data) async throws {
		try await connection.write(data: publicKey)
		try await connection.write(data: credentials)
	}

	func authenticate(credential: VNCUsernamePasswordCredential) throws -> Authentication {
        guard let agreement = DiffieHellmanKeyAgreement(generator: generator,
                                                        modulus: modulus,
                                                        resp: resp),
			!agreement.publicKey.isEmpty,
			!agreement.privateKey.isEmpty,
			!agreement.secretKey.isEmpty else {
			throw VNCError.authentication(.ultraVNCMSLogonIIAuthenticationFailed)
		}

        guard let authentication = Authentication(agreement: agreement,
                                                  username: credential.username,
                                                  password: credential.password),
              !authentication.publicKey.isEmpty,
              !authentication.encryptedCredential.isEmpty else {
            throw VNCError.authentication(.ultraVNCMSLogonIIAuthenticationFailed)
        }

        return authentication
	}
}
