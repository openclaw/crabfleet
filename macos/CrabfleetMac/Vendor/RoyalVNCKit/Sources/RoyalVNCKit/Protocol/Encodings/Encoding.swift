#if canImport(FoundationEssentials)
import FoundationEssentials
#else
import Foundation
#endif

protocol VNCEncoding {
	var encodingType: VNCEncodingType { get }
}
