#if canImport(FoundationEssentials)
import FoundationEssentials
#else
import Foundation
#endif

extension VNCProtocol {
	struct QualityControl: VNCSendableMessage {
		let messageType: UInt8 = 201
		let mode: VNCQualityMode

		var data: Data {
			Data([messageType, mode.rawValue, 0, 0])
		}

		func send(connection: NetworkConnectionWriting) async throws {
			try await connection.write(data: data)
		}
	}
}
