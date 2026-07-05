#if canImport(FoundationEssentials)
import FoundationEssentials
#else
import Foundation
#endif

extension VNCProtocol {
	/// ClientCutText with a negative length: one Extended Clipboard body.
	struct ExtendedClientCutText: VNCSendableMessage {
		let messageType: UInt8 = 6

		let body: Data
	}
}

extension VNCProtocol.ExtendedClientCutText {
	var data: Data {
		VNCExtendedClipboard.frame(messageType: messageType,
								   body: body)
	}

	func send(connection: NetworkConnectionWriting) async throws {
		try await connection.write(data: data)
	}
}
