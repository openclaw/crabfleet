#if canImport(FoundationEssentials)
import FoundationEssentials
#else
import Foundation
#endif

extension VNCProtocol {
	struct SetPixelFormat: VNCSendableMessage {
		let messageType: UInt8 = 0

		let pixelFormat: PixelFormat
	}
}

extension VNCProtocol.SetPixelFormat {
	var data: Data {
		let length = 20

		var data = Data(capacity: length)

		data.append(messageType)
		data.appendPadding(length: 3)

		let pixelFormatData = pixelFormat.data

		data.append(contentsOf: pixelFormatData)

		guard data.count == length else {
			fatalError("VNCProtocol.SetPixelFormat data.count (\(data.count)) != \(length)")
		}

		return data
	}

	func send(connection: NetworkConnectionWriting) async throws {
		try await connection.write(data: data)
	}
}
