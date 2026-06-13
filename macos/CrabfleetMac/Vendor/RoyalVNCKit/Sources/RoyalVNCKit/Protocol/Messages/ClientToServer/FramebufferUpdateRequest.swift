#if canImport(FoundationEssentials)
import FoundationEssentials
#else
import Foundation
#endif

extension VNCProtocol {
	struct FramebufferUpdateRequest: VNCSendableMessage {
		let messageType: UInt8 = 3

		let incremental: Bool

		let xPosition: UInt16
		let yPosition: UInt16

		let width: UInt16
		let height: UInt16
	}
}

extension VNCProtocol.FramebufferUpdateRequest {
	var data: Data {
		let length = 10

		var data = Data(capacity: length)

		data.append(messageType)
		data.append(incremental)
		data.append(xPosition, bigEndian: true)
		data.append(yPosition, bigEndian: true)
		data.append(width, bigEndian: true)
		data.append(height, bigEndian: true)

		guard data.count == length else {
			fatalError("VNCProtocol.FramebufferUpdateRequest data.count (\(data.count)) != \(length)")
		}

		return data
	}

	func send(connection: NetworkConnectionWriting) async throws {
		try await connection.write(data: data)
	}
}
