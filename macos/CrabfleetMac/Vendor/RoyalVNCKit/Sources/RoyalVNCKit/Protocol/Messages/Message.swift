#if canImport(FoundationEssentials)
import FoundationEssentials
#else
import Foundation
#endif

protocol VNCMessage {
	var messageType: UInt8 { get }
}

protocol VNCSendableMessage: VNCMessage {
	var data: Data { get }

	func send(connection: NetworkConnectionWriting) async throws
}

protocol VNCReceivableMessage: VNCMessage {
	static var messageType: UInt8 { get }
}
