#if canImport(FoundationEssentials)
import FoundationEssentials
#else
import Foundation
#endif

extension VNCProtocol {
	struct VNCAuthentication: VNCSecurityType {
		static let authenticationType = VNCAuthenticationType.vnc
		let authenticationType: VNCAuthenticationType = Self.authenticationType

		let challenge: Data

		fileprivate init?(challenge: Data) {
			guard challenge.count == 16 else { return nil }

			self.challenge = challenge
		}
	}
}

extension VNCProtocol.VNCAuthentication {
	static func receive(connection: NetworkConnectionReading) async throws -> Self {
		let data = try await connection.readBuffered(length: 16)

		guard let auth = Self(challenge: data) else {
			throw VNCError.protocol(.invalidData)
		}

		return auth
	}

	func send(connection: NetworkConnectionWriting,
			  credential: VNCPasswordCredential) async throws {
		guard let encryptedPassword = encrypt(password: credential.password) else {
			throw VNCError.authentication(.encryptionFailed)
		}

		try await Self.sendResponse(connection: connection,
									encryptedPassword: encryptedPassword)
	}
}

private extension VNCProtocol.VNCAuthentication {
	static func sendResponse(connection: NetworkConnectionWriting,
							 encryptedPassword: Data) async throws {
		guard encryptedPassword.count == 16 else {
			throw VNCError.protocol(.invalidData)
		}

		return try await connection.write(data: encryptedPassword)
	}

	func encrypt(password: String) -> Data? {
		guard let encryptedPassword = Self.encrypt(data: challenge,
												   password: password) else {
			return nil
		}

		return encryptedPassword
	}

	static func encrypt(data: Data,
						password: String) -> Data? {
		let encryptedData = VNCDESEncryption.encrypt(data: data,
													 key: password)

		return encryptedData
	}
}
