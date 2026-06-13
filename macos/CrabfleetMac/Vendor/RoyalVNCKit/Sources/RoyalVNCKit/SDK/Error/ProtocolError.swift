#if canImport(FoundationEssentials)
import FoundationEssentials
#else
import Foundation
#endif

public extension VNCError {
	enum ProtocolError: Error, LocalizedError {
		case notImplemented(feature: String)
		case noData
		case invalidData
		case unsupportedServerToClientMessage(messageType: UInt8)
		case unsupportedColorDepth(colorDepth: UInt8)
		case unsupportedEncoding(encodingType: VNCEncodingType)
		case invalidEncodingTypeSize(encodingType: VNCEncodingType, actualSize: Int)
		case framebufferUpdateReceivedWithoutFramebuffer
		case framebufferFailedToCreateIOSurface
		case setColourMapEntriesReceivedWithoutFramebuffer
		case frameDecode(encodingType: VNCEncodingType, underlyingError: Error?)
		case zlibDecompress(underlyingError: Error?)
		case zrleInvalidSubencoding(subencoding: UInt8)
		case zrleUnsupportedBitsPerPixel(bitsPerPixel: Int)
		case zrleUnexpectedPaletteSize(paletteSize: UInt8)
		case zrleUnexpectedRLEPaletteSize(paletteSize: UInt8)
		case zrlePaletteIndexOverflow(paletteIndex: Int, paletteSize: UInt8)
		case zrlePaletteRLELengthOverflow
		case zrleUnexpectedRLEStreamEnd
		case unexpectedExtendedServerCutTextAction(action: UInt32)

		// MARK: - LocalizedError
		public var errorDescription: String? {
			// TODO: Localize
			switch self {
				case .notImplemented(let feature):
					return "The feature \"\(feature)\" is not implemented."
				case .noData:
					return "No Data was retrieved."
				case .invalidData:
					return "Invalid Data was retrieved."
				case .unsupportedServerToClientMessage(let messageType):
					return "An unsupported Server to Client Message (\(messageType)) was retrieved."
				case .unsupportedColorDepth(let colorDepth):
					return "An unsupported color depth (\(colorDepth)) was requested."
				case .unsupportedEncoding(let encodingType):
					return "An Encoding Type (\(encodingType.rawValue)) which is not supported by the client was requested by the server."
				case .invalidEncodingTypeSize(let encodingType, let actualSize):
					return "An encoding Type (\(encodingType.rawValue)) with invalid size was specified. Expected Size: \(VNCEncodingType.size), Actual Size: \(actualSize)"
				case .framebufferUpdateReceivedWithoutFramebuffer:
					return "A Framebuffer Update request has been retrieved but no Framebuffer has been created yet."
				case .framebufferFailedToCreateIOSurface:
					return "Failed to create IOSurface for Framebuffer."
				case .setColourMapEntriesReceivedWithoutFramebuffer:
					return "A Set Colour Map Entries request has been retrieved but no Framebuffer has been created yet."
				case .frameDecode(let encodingType, let underlyingError):
					return VNCError.combinedErrorDescription("An error occurred while decoding a Framebuffer Update Message (Encoding Type: \(encodingType)).",
															 underlyingError: underlyingError)
				case .zlibDecompress(let underlyingError):
					return VNCError.combinedErrorDescription("An error occurred while decompressing Zlib data.",
															 underlyingError: underlyingError)
				case .zrleInvalidSubencoding(let subencoding):
					return "An invalid ZRLE subencoding type (\(subencoding)) was retrieved."
				case .zrleUnsupportedBitsPerPixel(let bitsPerPixel):
					return "An unsupported ZRLE Bits Per Pixel value (\(bitsPerPixel)) was retrieved."
				case .zrleUnexpectedPaletteSize(let paletteSize):
					return "An unexpected ZRLE palette size (\(paletteSize)) encountered."
				case .zrleUnexpectedRLEPaletteSize(let paletteSize):
					return "An unexpected ZRLE RLE palette size (\(paletteSize)) encountered."
				case .zrlePaletteIndexOverflow(let paletteIndex, let paletteSize):
					return "An invalid ZRLE palette index (\(paletteIndex)) was encountered for a palette of size \(paletteSize)."
				case .zrlePaletteRLELengthOverflow:
					return "An invalid ZRLE RLE length was encountered."
				case .zrleUnexpectedRLEStreamEnd:
					return "End of stream reached while reading ZRLE RLE run-length."
				case .unexpectedExtendedServerCutTextAction(let action):
					return "An unexpected ExtendedServerCutText Action (\(action)) was retrieved."
			}
		}
	}
}
