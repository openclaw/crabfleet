#if canImport(FoundationEssentials)
import FoundationEssentials
#else
import Foundation
#endif

extension VNCProtocol {
	struct SecurityResult {
        // swiftlint:disable:next nesting
		enum Result: UInt32 {
			case ok = 0
			case failed = 1
			case failedTooManyAttempts = 2 // Only valid if the Tight Security Type is enabled
		}

		let value: UInt32

		fileprivate init(value: UInt32) {
			self.value = value
		}
	}
}

extension VNCProtocol.SecurityResult {
	static func receive(connection: NetworkConnectionReading) async throws -> Self {
		let value = try await connection.readUInt32()

		return Self(value: value)
	}

	static func receiveFailureReason(connection: NetworkConnectionReading) async throws -> String {
		let reason = try await connection.readString(encoding: .utf8)

		return reason
	}

	var result: Result? {
		return .init(rawValue: value)
	}
}
