#if canImport(FoundationEssentials)
import FoundationEssentials
#else
import Foundation
#endif

extension VNCProtocol {
	struct CrabfleetAudio: VNCReceivableMessage {
		static let messageType: UInt8 = 200
		static let maximumPayloadBytes: UInt32 = 64 * 1_024

		let messageType: UInt8 = 200
		let message: VNCAudioMessage
	}
}

extension VNCProtocol.CrabfleetAudio {
	static func receive(connection: NetworkConnectionReading) async throws -> Self {
		switch try await connection.readUInt8() {
			case 1:
				let format = try await connection.readUInt8()
				let channels = try await connection.readUInt8()
				let sampleRate = try await connection.readUInt32()
				let cookieLength = try await connection.readUInt32()
				guard format == 1, (1...2).contains(channels),
					  (8_000...192_000).contains(sampleRate),
					  cookieLength <= maximumPayloadBytes else {
					throw VNCError.protocol(.invalidData)
				}
				let cookie = try await connection.readBuffered(length: Int(cookieLength))
				return .init(message: .config(
					channels: channels,
					sampleRate: sampleRate,
					magicCookie: cookie
				))

			case 2:
				let padding = try await connection.readBuffered(length: 2)
				let timestampMs = try await connection.readUInt32()
				let payloadLength = try await connection.readUInt32()
				guard padding == Data([0, 0]), payloadLength > 0,
					  payloadLength <= maximumPayloadBytes else {
					throw VNCError.protocol(.invalidData)
				}
				let payload = try await connection.readBuffered(length: Int(payloadLength))
				return .init(message: .packet(timestampMs: timestampMs, payload: payload))

			case 3:
				guard try await connection.readBuffered(length: 2) == Data([0, 0]) else {
					throw VNCError.protocol(.invalidData)
				}
				return .init(message: .stop)

			default:
				throw VNCError.protocol(.invalidData)
		}
	}
}
