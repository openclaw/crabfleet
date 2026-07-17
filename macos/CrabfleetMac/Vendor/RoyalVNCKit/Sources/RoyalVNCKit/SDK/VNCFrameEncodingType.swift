#if canImport(FoundationEssentials)
import FoundationEssentials
#else
import Foundation
#endif

#if canImport(ObjectiveC)
@objc(VNCFrameEncodingType)
#endif
// swiftlint:disable:next type_name
public enum _ObjC_VNCFrameEncodingType: Int64 {
	case raw = 0
	case copyRect = 1
	case rre = 2
	case coRRE = 4
	case hextile = 5
	case zlib = 6
	case tight = 7
	case zrle = 16
	case openH264 = 50
	case crabfleetAudio = 0x43414631
	case crabfleetChroma444 = 0x43343434
	case crabfleetHEVC = 0x48455631
	case crabfleetQualityControl = 0x5143544c
}

public enum VNCFrameEncodingType: VNCEncodingType {
	case raw = 0
	case copyRect = 1
	case rre = 2
	case coRRE = 4
	case hextile = 5
	case zlib = 6
	case tight = 7
	case zrle = 16
	case openH264 = 50
	case crabfleetAudio = 0x43414631
	case crabfleetChroma444 = 0x43343434
	case crabfleetHEVC = 0x48455631
	case crabfleetQualityControl = 0x5143544c
}

extension VNCFrameEncodingType: CustomStringConvertible {
	public var description: String {
		switch self {
			case .raw:
				"Raw"
			case .copyRect:
				"Copy Rectangle"
			case .rre:
				"RRE"
			case .coRRE:
				"CoRRE"
			case .hextile:
				"Hextile"
			case .zlib:
				"Zlib"
			case .tight:
				"Tight"
			case .zrle:
				"ZRLE"
			case .openH264:
				"Open H.264"
			case .crabfleetAudio:
				"Crabfleet Audio"
			case .crabfleetChroma444:
				"Crabfleet HEVC 4:4:4 capability"
			case .crabfleetHEVC:
				"Crabfleet HEVC"
			case .crabfleetQualityControl:
				"Crabfleet per-viewer quality control capability"
		}
	}
}

public extension VNCFrameEncodingType {
	static let defaultFrameEncodings: [VNCFrameEncodingType] = [
		.tight,
		.zlib,
		.zrle,
		.hextile,
		.coRRE,
		.rre
	]
}

#if canImport(ObjectiveC)
@objc(VNCFrameEncodingTypeUtils)
// swiftlint:disable:next type_name
public final class _ObjC_VNCFrameEncodingTypeUtils: NSObject {
    @objc
	public static var defaultFrameEncodings: [Int64] {
		VNCFrameEncodingType.defaultFrameEncodings.map({ $0.rawValue.rawValue })
	}

    @objc
	public static func descriptionForFrameEncoding(_ frameEncoding: _ObjC_VNCFrameEncodingType) -> String {
		let enc = VNCFrameEncodingType.fromObjCFrameEncodingType(frameEncoding)
		let desc = enc.description

		return desc
	}
}
#endif

public extension [VNCFrameEncodingType] {
	static var `default`: Self {
		VNCFrameEncodingType.defaultFrameEncodings
	}

	func encode() -> [String] {
		let encodedValue = compactMap { frameEncoding in
			let encType = frameEncoding.rawValue
			let rawValue = encType.rawValue
			let strValue = String(rawValue)

			return strValue
		}

		return encodedValue
	}

	static func decode(_ strings: [String]) -> Self {
		let encs: [VNCFrameEncodingType] = strings.compactMap {
			guard let encTypeNum = VNCEncodingType.RawValue($0),
				  let encType = VNCEncodingType(rawValue: encTypeNum),
				  let enc = VNCFrameEncodingType(rawValue: encType) else {
				return nil
			}

			return enc
		}

		return encs
	}
}

extension VNCFrameEncodingType {
	static func fromObjCFrameEncodingType(_ objCFrameEncodingType: _ObjC_VNCFrameEncodingType) -> Self {
		switch objCFrameEncodingType {
			case .raw:
				.raw
			case .copyRect:
				.copyRect
			case .rre:
				.rre
			case .coRRE:
				.coRRE
			case .hextile:
				.hextile
			case .zlib:
				.zlib
			case .tight:
				.tight
			case .zrle:
				.zrle
			case .openH264:
				.openH264
			case .crabfleetAudio:
				.crabfleetAudio
			case .crabfleetChroma444:
				.crabfleetChroma444
			case .crabfleetHEVC:
				.crabfleetHEVC
			case .crabfleetQualityControl:
				.crabfleetQualityControl
		}
	}
}
