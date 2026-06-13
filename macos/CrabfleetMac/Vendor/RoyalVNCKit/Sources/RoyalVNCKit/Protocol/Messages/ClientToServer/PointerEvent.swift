#if canImport(FoundationEssentials)
import FoundationEssentials
#else
import Foundation
#endif

extension VNCProtocol {
	struct PointerEvent: VNCSendableMessage {
		let messageType: UInt8 = 5

		let buttonMask: UInt8

		let xPosition: UInt16
		let yPosition: UInt16
	}
}

extension VNCProtocol.PointerEvent {
	var data: Data {
		let length = 6

		var data = Data(capacity: length)

		data.append(messageType)
		data.append(buttonMask)
		data.append(xPosition, bigEndian: true)
		data.append(yPosition, bigEndian: true)

		guard data.count == length else {
			fatalError("VNCProtocol.PointerEvent data.count (\(data.count)) != \(length)")
		}

		return data
	}

	init(buttons: VNCProtocol.MousePointerButton,
		 position: VNCProtocol.MousePosition) {
		self.buttonMask = buttons.rawValue

		self.xPosition = position.x
		self.yPosition = position.y
	}

	func send(connection: NetworkConnectionWriting) async throws {
		try await connection.write(data: data)
	}
}
