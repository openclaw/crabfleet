#if canImport(FoundationEssentials)
import FoundationEssentials
#else
import Foundation
#endif

extension VNCProtocol {
	struct SetDesktopSize: VNCSendableMessage {
		let messageType: UInt8 = 251
		let width: UInt16
		let height: UInt16
		let screens: [Screen]
	}
}

extension VNCProtocol.SetDesktopSize {
	var data: Data {
		let length = 8 + screens.count * 16
		var data = Data(capacity: length)

		data.append(messageType)
		data.appendPadding()
		data.append(width, bigEndian: true)
		data.append(height, bigEndian: true)
		data.append(UInt8(screens.count))
		data.appendPadding()

		for screen in screens {
			data.append(screen.id, bigEndian: true)
			data.append(screen.xPosition, bigEndian: true)
			data.append(screen.yPosition, bigEndian: true)
			data.append(screen.width, bigEndian: true)
			data.append(screen.height, bigEndian: true)
			data.append(screen.flags, bigEndian: true)
		}

		guard data.count == length else {
			fatalError("VNCProtocol.SetDesktopSize data.count (\(data.count)) != \(length)")
		}

		return data
	}

	func send(connection: NetworkConnectionWriting) async throws {
		try await connection.write(data: data)
	}
}
