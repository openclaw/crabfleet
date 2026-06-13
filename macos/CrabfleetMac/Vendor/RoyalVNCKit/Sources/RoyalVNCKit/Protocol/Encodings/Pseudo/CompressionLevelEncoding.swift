#if canImport(FoundationEssentials)
import FoundationEssentials
#else
import Foundation
#endif

// TODO: Untested
extension VNCProtocol {
	struct CompressionLevelEncoding: VNCPseudoEncoding {
		/// Set to any value between (including) VNCPseudoEncodingType.compressionLevel1 to VNCPseudoEncodingType.compressionLevel10
		/// Level 1 is the lowest, Level 10 the highest compression level
		let encodingType: VNCEncodingType
	}
}
