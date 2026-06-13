#if canImport(FoundationEssentials)
import FoundationEssentials
#else
import Foundation
#endif

extension VNCProtocol {
	struct SetEncodings: VNCSendableMessage {
		let messageType: UInt8 = 2

		let encodingTypes: [VNCEncodingType]
	}
}

extension VNCProtocol.SetEncodings {
	var data: Data {
		let baseLength = 4
		let sizeOfOneEncoding = VNCEncodingType.size
		let numberOfEncodings = UInt16(encodingTypes.count)
		let sizeOfAllEncodings = sizeOfOneEncoding * Int(numberOfEncodings)
		let length = baseLength + sizeOfAllEncodings

		var data = Data(capacity: length)

		data.append(messageType)
		data.appendPadding()
		data.append(numberOfEncodings, bigEndian: true)

		for encodingType in encodingTypes {
			if let int32EncodingType = encodingType.int32Value {
				data.append(int32EncodingType, bigEndian: true)
			} else if let uint32EncodingType = encodingType.uint32Value {
				data.append(uint32EncodingType, bigEndian: true)
			} else {
				let expectedSize = VNCEncodingType.size
				let actualSize = MemoryLayout.size(ofValue: encodingType)

				fatalError("VNCProtocol.SetEncodings invalid encoding type size. Expected Size: \(expectedSize), Actual Size: \(actualSize)")
			}
		}

		guard data.count == length else {
			fatalError("VNCProtocol.SetEncodings data.count (\(data.count)) != \(length)")
		}

		return data
	}

	func send(connection: NetworkConnectionWriting) async throws {
		try await connection.write(data: data)
	}
}
