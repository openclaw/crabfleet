#if canImport(FoundationEssentials)
import FoundationEssentials
#else
import Foundation
#endif

extension VNCProtocol {
	enum EncodingType: Int32 {
		case raw = 0
		case copyRect = 1
		case rre = 2
		case coRRE = 4
		case hextile = 5
		case zlib = 6
		case tight = 7
		case zlibhex = 8
		case ultra = 9
		case ultra2 = 10
		case trle = 15
		case zrle = 16
		case hitachiZYWRLE = 17
		case h264 = 20
		case jpeg = 21
		case jrle = 22
		case openH264 = 50
		case tightPNG = -260

		case apple1000 = 1000
		case apple1001 = 1001
		case apple1002 = 1002
		case apple1011 = 1011
		case apple1100 = 1100
		case apple1101 = 1101
		case apple1102 = 1102
		case apple1103 = 1103
		case apple1104 = 1104
		case apple1105 = 1105
	}
}
