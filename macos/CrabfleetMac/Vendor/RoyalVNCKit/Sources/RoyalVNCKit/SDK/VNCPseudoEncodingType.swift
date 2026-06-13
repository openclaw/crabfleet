#if canImport(FoundationEssentials)
import FoundationEssentials
#else
import Foundation
#endif

public enum VNCPseudoEncodingType: VNCEncodingType {
	case lastRect = -224
	case cursor = -239
	case desktopName = -307
	case continuousUpdates = -313
	case desktopSize = -223
	case extendedDesktopSize = -308

	// Level 1 means lowest compression level, Level 10 means highest compression level

	/// Lowest compression level
	case compressionLevel1 = -256
	case compressionLevel2 = -255
	case compressionLevel3 = -254
	case compressionLevel4 = -253
	case compressionLevel5 = -252
	case compressionLevel6 = -251
	case compressionLevel7 = -250
	case compressionLevel8 = -249
	case compressionLevel9 = -248
	/// Highest compression level
	case compressionLevel10 = -247

	// JPEG quality levels for Tight encoding (0 = lowest quality, 9 = highest quality)
	case jpegQualityLevel0 = -32
	case jpegQualityLevel1 = -31
	case jpegQualityLevel2 = -30
	case jpegQualityLevel3 = -29
	case jpegQualityLevel4 = -28
	case jpegQualityLevel5 = -27
	case jpegQualityLevel6 = -26
	case jpegQualityLevel7 = -25
	case jpegQualityLevel8 = -24
	case jpegQualityLevel9 = -23

	case extendedClipboard = 0xc0a1e5ce
}

extension VNCPseudoEncodingType: CustomStringConvertible {
	public var description: String {
		switch self {
			case .lastRect:
				"Last Rectangle"
			case .cursor:
				"Cursor"
			case .desktopName:
				"Desktop Name"
			case .continuousUpdates:
				"Continuous Updates"
			case .desktopSize:
				"Desktop Size"
			case .extendedDesktopSize:
				"Extended Desktop Size"
			case .compressionLevel1:
				"Compression Level 1"
			case .compressionLevel2:
				"Compression Level 2"
			case .compressionLevel3:
				"Compression Level 3"
			case .compressionLevel4:
				"Compression Level 4"
			case .compressionLevel5:
				"Compression Level 5"
			case .compressionLevel6:
				"Compression Level 6"
			case .compressionLevel7:
				"Compression Level 7"
			case .compressionLevel8:
				"Compression Level 8"
			case .compressionLevel9:
				"Compression Level 9"
			case .compressionLevel10:
				"Compression Level 10"
			case .jpegQualityLevel0:
				"JPEG Quality Level 0"
			case .jpegQualityLevel1:
				"JPEG Quality Level 1"
			case .jpegQualityLevel2:
				"JPEG Quality Level 2"
			case .jpegQualityLevel3:
				"JPEG Quality Level 3"
			case .jpegQualityLevel4:
				"JPEG Quality Level 4"
			case .jpegQualityLevel5:
				"JPEG Quality Level 5"
			case .jpegQualityLevel6:
				"JPEG Quality Level 6"
			case .jpegQualityLevel7:
				"JPEG Quality Level 7"
			case .jpegQualityLevel8:
				"JPEG Quality Level 8"
			case .jpegQualityLevel9:
				"JPEG Quality Level 9"
			case .extendedClipboard:
				"Extended Clipboard"
		}
	}
}
