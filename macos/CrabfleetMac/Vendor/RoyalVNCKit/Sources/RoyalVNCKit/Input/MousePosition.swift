#if canImport(FoundationEssentials)
import FoundationEssentials
#else
import Foundation
#endif

extension VNCProtocol {
	struct MousePosition {
		let x: UInt16
		let y: UInt16
	}
}
