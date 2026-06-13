#if canImport(FoundationEssentials)
import FoundationEssentials
#else
import Foundation
#endif

extension VNCProtocol {
	struct EndOfContinuousUpdates: VNCMessage {
		static let messageType: UInt8 = 150

		let messageType: UInt8
	}
}
