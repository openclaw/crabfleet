#if canImport(FoundationEssentials)
import FoundationEssentials
#else
import Foundation
#endif

extension VNCProtocol {
	struct LastRectEncoding: VNCPseudoEncoding {
		let encodingType = VNCPseudoEncodingType.lastRect.rawValue
	}
}
