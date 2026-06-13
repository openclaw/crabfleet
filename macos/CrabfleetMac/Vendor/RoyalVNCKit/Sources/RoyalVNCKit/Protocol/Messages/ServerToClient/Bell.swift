#if canImport(FoundationEssentials)
import FoundationEssentials
#else
import Foundation
#endif

extension VNCProtocol {
	struct Bell: VNCReceivableMessage {
		static let messageType: UInt8 = 2

		let messageType: UInt8
	}
}

extension VNCProtocol.Bell {
	static func receive(connection: NetworkConnectionReading,
						logger: VNCLogger) async throws -> Self {
		return .init(messageType: Self.messageType)
	}
}
