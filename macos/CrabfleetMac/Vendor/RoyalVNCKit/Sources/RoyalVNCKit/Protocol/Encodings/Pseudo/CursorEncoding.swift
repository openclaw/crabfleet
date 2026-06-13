#if canImport(FoundationEssentials)
import FoundationEssentials
#else
import Foundation
#endif

extension VNCProtocol {
	struct CursorEncoding: VNCReceivablePseudoEncoding {
		let encodingType = VNCPseudoEncodingType.cursor.rawValue
	}
}

extension VNCProtocol.CursorEncoding {
	func receive(_ rectangle: VNCProtocol.Rectangle,
				 framebuffer: VNCFramebuffer,
				 connection: NetworkConnectionReading,
				 logger: VNCLogger) async throws {
		let hotspot = rectangle.region.location
		let size = rectangle.region.size

        let width = Int(size.width)
        let height = Int(size.height)
		guard width <= VNCProtocolLimits.maximumCursorDimension,
			  height <= VNCProtocolLimits.maximumCursorDimension else {
			throw VNCError.protocol(.invalidData)
		}

		let bytesPerPixel = framebuffer.sourceProperties.bytesPerPixel
        let bytesPerRow = (width + 7) / 8

        let pixelsLength = width * height * bytesPerPixel

		guard pixelsLength > 0 else {
			framebuffer.updateCursor(.empty)

			return
		}

        let maskLength = bytesPerRow * height
        let totalLength = maskLength + pixelsLength

		logger.logDebug("Receiving Cursor data")

		let data = try await connection.readBuffered(length: totalLength)

		logger.logDebug("Finished receiving Cursor data")

		var image = data.subdata(in: 0..<pixelsLength)
		var mask = data.subdata(in: pixelsLength..<pixelsLength + maskLength)

		let cursor = framebuffer.decodeCursor(image: &image,
											  mask: &mask,
											  size: size,
											  hotspot: hotspot)

		framebuffer.updateCursor(cursor)
	}
}
