#if canImport(FoundationEssentials)
import FoundationEssentials
#else
import Foundation
#endif

extension VNCProtocol {
	struct CursorWithAlphaEncoding: VNCReceivablePseudoEncoding {
		let encodingType = VNCPseudoEncodingType.cursorWithAlpha.rawValue
	}
}

extension VNCProtocol.CursorWithAlphaEncoding {
	func receive(_ rectangle: VNCProtocol.Rectangle,
				 framebuffer: VNCFramebuffer,
				 connection: NetworkConnectionReading,
				 logger: VNCLogger) async throws {
		let hotspot = rectangle.region.location
		let size = rectangle.region.size
		let width = Int(size.width)
		let height = Int(size.height)
		guard width <= VNCProtocolLimits.maximumCursorDimension,
			  height <= VNCProtocolLimits.maximumCursorDimension,
			  (width == 0) == (height == 0),
			  width == 0 || (Int(hotspot.x) < width && Int(hotspot.y) < height) else {
			throw VNCError.protocol(.invalidData)
		}

		let nestedEncoding = try await connection.readInt32()
		guard nestedEncoding == VNCFrameEncodingType.raw.rawValue.int32Value else {
			throw VNCError.protocol(.unsupportedEncoding(encodingType: .init(nestedEncoding)))
		}
		guard width > 0 else {
			framebuffer.updateCursor(.empty)
			return
		}

		let payloadLength = width * height * 4
		logger.logDebug("Receiving CursorWithAlpha data")
		let rgba = try await connection.readBuffered(length: payloadLength)
		logger.logDebug("Finished receiving CursorWithAlpha data")
		framebuffer.updateCursor(
			VNCCursor(
				imageData: rgba,
				size: size,
				hotspot: hotspot,
				bitsPerComponent: 8,
				bitsPerPixel: 32,
				bytesPerPixel: 4,
				isPremultiplied: true))
	}
}
