#if canImport(FoundationEssentials)
import FoundationEssentials
#else
import Foundation
#endif

extension VNCProtocol {
	struct NumberOfSecurityTypes {
		let number: UInt8

		fileprivate init(number: UInt8) {
			self.number = number
		}
	}
}

extension VNCProtocol.NumberOfSecurityTypes {
	static func receive(connection: NetworkConnectionReading) async throws -> Self {
		let number = try await connection.readUInt8()
		let inst = Self(number: number)

		return inst
	}

	static func receiveFailureReason(connection: NetworkConnectionReading) async throws -> String {
		let reason = try await connection.readString(encoding: .utf8)

		return reason
	}
}
