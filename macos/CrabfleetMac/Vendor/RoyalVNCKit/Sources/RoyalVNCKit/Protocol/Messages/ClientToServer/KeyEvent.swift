#if canImport(FoundationEssentials)
import FoundationEssentials
#else
import Foundation
#endif

extension VNCProtocol {
	struct KeyEvent: VNCSendableMessage {
		let messageType: UInt8 = 4

		let isDown: Bool
		let key: UInt32
	}
}

extension VNCProtocol.KeyEvent {
	var data: Data {
		let length = 8

		var data = Data(capacity: length)

		data.append(messageType)
		data.append(isDown)

		// 2 bytes padding
		data.appendPadding(length: 2)

		data.append(key, bigEndian: true)

		guard data.count == length else {
			fatalError("VNCProtocol.KeyEvent data.count (\(data.count)) != \(length)")
		}

		return data
	}

	func send(connection: NetworkConnectionWriting) async throws {
		try await connection.write(data: data)
	}

	var description: String {
		let keyUpOrDownChar = isDown ? "↓" : "↑"

		let keyCode = VNCKeyCode(key)
		let keyHex = keyCode.description

		let desc = "\(keyHex) \(keyUpOrDownChar)"

		return desc
	}
}
