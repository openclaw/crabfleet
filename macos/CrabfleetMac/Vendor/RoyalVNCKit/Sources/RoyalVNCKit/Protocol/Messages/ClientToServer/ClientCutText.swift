#if canImport(FoundationEssentials)
import FoundationEssentials
#else
import Foundation
#endif

	extension VNCProtocol {
	struct ClientCutText: VNCSendableMessage {
		let messageType: UInt8 = 6

		let textData: Data

		init?(text: String) {
			var textData = Data()
			textData.reserveCapacity(min(text.utf8.count, VNCProtocolLimits.maximumClipboardBytes))

			for scalar in text.unicodeScalars {
				guard scalar.value <= UInt8.max,
					  textData.count < VNCProtocolLimits.maximumClipboardBytes else {
					return nil
				}

				textData.append(UInt8(scalar.value))
			}

			self.textData = textData
		}
	}
}

extension VNCProtocol.ClientCutText {
	var data: Data {
		let textLength = textData.count
		let length = 8 + textLength

		var data = Data(capacity: length)

		data.append(messageType)
		data.appendPadding(length: 3)

		data.append(UInt32(textLength), bigEndian: true)
		data.append(contentsOf: textData)

		guard data.count == length else {
			fatalError("VNCProtocol.ClientCutText data.count (\(data.count)) != \(length)")
		}

		return data
	}

	func send(connection: NetworkConnectionWriting) async throws {
		try await connection.write(data: data)
	}
}
