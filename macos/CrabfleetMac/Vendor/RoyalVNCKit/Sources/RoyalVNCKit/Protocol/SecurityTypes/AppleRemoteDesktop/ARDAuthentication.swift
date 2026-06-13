#if canImport(FoundationEssentials)
import FoundationEssentials
#else
import Foundation
#endif

extension VNCProtocol {
	struct ARDAuthentication: VNCSecurityType {
		static let authenticationType = VNCAuthenticationType.appleRemoteDesktop
		let authenticationType: VNCAuthenticationType = Self.authenticationType

		let generator: Data // Is actually UInt16 but our implementation requires Data, so...
		let keySize: UInt16
		let prime: Data
		let peerKey: Data

		fileprivate init?(generator: Data,
						  keySize: UInt16,
						  prime: Data,
						  peerKey: Data) {
			guard generator.count == 2 else {
				return nil
			}

			self.generator = generator
			self.keySize = keySize

			guard prime.count == keySize,
				  peerKey.count == keySize else {
				return nil
			}

			self.prime = prime
			self.peerKey = peerKey
		}
	}
}

extension VNCProtocol.ARDAuthentication {
	static func receive(connection: NetworkConnectionReading) async throws -> Self {
		let generator = try await connection.readBuffered(length: 2)
		let keySize = try await connection.readUInt16()
		let prime = try await connection.readBuffered(length: .init(keySize))
		let peerKey = try await connection.readBuffered(length: .init(keySize))

		guard let auth = Self(generator: generator,
							  keySize: keySize,
							  prime: prime,
							  peerKey: peerKey) else {
			throw VNCError.protocol(.invalidData)
		}

		return auth
	}

	func send(connection: NetworkConnectionWriting,
			  credential: VNCUsernamePasswordCredential) async throws {
		let authentication = try authenticate(credential: credential)

		let cipherText = authentication.cipherText
		let publicKey = authentication.publicKey

		try await Self.sendResponse(connection: connection,
									cipherText: cipherText,
									publicKey: publicKey)
	}
}

private extension VNCProtocol.ARDAuthentication {
	static func sendResponse(connection: NetworkConnectionWriting,
							 cipherText: Data,
							 publicKey: Data) async throws {
		try await connection.write(data: cipherText)
		try await connection.write(data: publicKey)
	}

	func authenticate(credential: VNCUsernamePasswordCredential) throws -> Authentication {
		guard let agreement = DiffieHellmanKeyAgreement(prime: prime,
														generator: generator,
														peerKey: peerKey,
														keyLength: .init(keySize)),
			  !agreement.publicKey.isEmpty,
			  !agreement.privateKey.isEmpty,
			  !agreement.secretKey.isEmpty else {
			throw VNCError.authentication(.ardAuthenticationFailed)
		}

		guard let authentication = Authentication(agreement: agreement,
												  username: credential.username,
												  password: credential.password),
			  !authentication.publicKey.isEmpty,
			  !authentication.cipherText.isEmpty else {
			throw VNCError.authentication(.ardAuthenticationFailed)
		}

		return authentication
	}
}
