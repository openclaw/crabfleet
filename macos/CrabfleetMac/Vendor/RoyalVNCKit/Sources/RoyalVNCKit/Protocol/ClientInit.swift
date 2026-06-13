#if canImport(FoundationEssentials)
import FoundationEssentials
#else
import Foundation
#endif

extension VNCProtocol {
	struct ClientInit { }
}

extension VNCProtocol.ClientInit {
	static func send(connection: NetworkConnectionWriting,
					 isShared: Bool) async throws {
		let sharedFlag: UInt8 = isShared ? 1 : 0

		try await connection.write(value: sharedFlag)
	}
}
