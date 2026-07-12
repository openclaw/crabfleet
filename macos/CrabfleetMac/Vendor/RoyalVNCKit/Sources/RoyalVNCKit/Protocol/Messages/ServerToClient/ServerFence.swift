#if canImport(FoundationEssentials)
import FoundationEssentials
#else
import Foundation
#endif

extension VNCProtocol {
	struct ServerFence: VNCReceivableMessage {
		static let messageType: UInt8 = 248

		let messageType: UInt8
		let flags: FenceFlags
		let payload: Data
	}
}

extension VNCProtocol.ServerFence {
	static func receive(connection: NetworkConnectionReading) async throws -> Self {
		try await connection.readPadding(length: 3)
		let flags = VNCProtocol.FenceFlags(rawValue: try await connection.readUInt32())
		let payloadLength = Int(try await connection.readUInt8())
		guard payloadLength <= VNCProtocol.ClientFence.maximumPayloadLength else {
			throw VNCError.protocol(.invalidData)
		}
		let payload = try await connection.read(length: payloadLength)
		return .init(messageType: messageType, flags: flags, payload: payload)
	}
}
