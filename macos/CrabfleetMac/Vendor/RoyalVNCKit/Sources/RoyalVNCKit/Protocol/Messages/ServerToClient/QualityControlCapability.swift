#if canImport(FoundationEssentials)
import FoundationEssentials
#else
import Foundation
#endif

extension VNCProtocol {
	struct QualityControlCapability: VNCReceivableMessage {
		static let messageType: UInt8 = 201
		let messageType: UInt8 = 201

		static func receive(connection: NetworkConnectionReading) async throws -> Self {
			guard try await connection.readBuffered(length: 3) == Data([1, 0, 0]) else {
				throw VNCError.protocol(.invalidData)
			}
			return .init()
		}
	}
}
