#if canImport(FoundationEssentials)
import FoundationEssentials
#else
import Foundation
#endif

extension VNCProtocol {
	struct ContinuousUpdatesEncoding: VNCPseudoEncoding {
		let encodingType = VNCPseudoEncodingType.continuousUpdates.rawValue
	}
}
