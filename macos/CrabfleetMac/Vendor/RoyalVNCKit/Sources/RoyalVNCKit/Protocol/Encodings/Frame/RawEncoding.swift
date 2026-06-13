#if canImport(FoundationEssentials)
import FoundationEssentials
#else
import Foundation
#endif

extension VNCProtocol {
	struct RawEncoding: VNCFrameEncoding {
		let encodingType = VNCFrameEncodingType.raw.rawValue
	}
}

extension VNCProtocol.RawEncoding {
	func decodeRectangle(_ rectangle: VNCProtocol.Rectangle,
						 framebuffer: VNCFramebuffer,
						 connection: NetworkConnectionReading,
						 logger: VNCLogger) async throws {
		let bytesPerPixel = framebuffer.sourceProperties.bytesPerPixel
		let totalBytesToRead = Int(rectangle.width) * Int(rectangle.height) * bytesPerPixel

		guard totalBytesToRead > 0 else {
			logger.logDebug("Nothing to RAW download, skipping")

			return
		}

		let chunkSize = 1024 * 16

		var data = try await connection.readBuffered(length: totalBytesToRead,
													 minimumChunkSize: 1,
													 maximumChunkSize: chunkSize)

		guard !data.isEmpty else {
			throw VNCError.protocol(.noData)
		}

		guard data.count == totalBytesToRead else {
			throw VNCError.protocol(.invalidData)
		}

		let region = rectangle.region

		framebuffer.update(region: region,
						   data: &data)

		framebuffer.didUpdate(region: region)
	}
}
