#if canImport(FoundationEssentials)
import FoundationEssentials
#else
import Foundation
#endif

extension VNCProtocol {
	struct JPEGQualityLevelEncoding: VNCPseudoEncoding {
		/// Set to any value between (including) VNCPseudoEncodingType.jpegQualityLevel0 to VNCPseudoEncodingType.jpegQualityLevel9
		/// Level 0 is the lowest, Level 9 the highest JPEG quality level
		let encodingType: VNCEncodingType
	}
}
