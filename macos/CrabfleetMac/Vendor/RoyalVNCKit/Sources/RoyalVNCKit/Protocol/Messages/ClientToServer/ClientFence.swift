#if canImport(FoundationEssentials)
import FoundationEssentials
#else
import Foundation
#endif

extension VNCProtocol {
	struct FenceFlags: OptionSet {
		let rawValue: UInt32

		static let blockBefore = Self(rawValue: 1 << 0)
		static let blockAfter = Self(rawValue: 1 << 1)
		static let syncNext = Self(rawValue: 1 << 2)
		static let request = Self(rawValue: 1 << 31)

		static let supported: Self = [.blockBefore, .blockAfter, .syncNext, .request]
	}

	struct ClientFence: VNCSendableMessage {
		static let maximumPayloadLength = 64
		static let messageType: UInt8 = 248

		var messageType: UInt8 { Self.messageType }
		let flags: FenceFlags
		let payload: Data
	}
}

extension VNCProtocol.ClientFence {
	var data: Data {
		precondition(payload.count <= Self.maximumPayloadLength)

		var data = Data(capacity: 9 + payload.count)
		data.append(messageType)
		data.appendPadding(length: 3)
		data.append(flags.rawValue, bigEndian: true)
		data.append(UInt8(payload.count))
		data.append(payload)
		return data
	}

	func send(connection: NetworkConnectionWriting) async throws {
		try await connection.write(data: data)
	}
}
