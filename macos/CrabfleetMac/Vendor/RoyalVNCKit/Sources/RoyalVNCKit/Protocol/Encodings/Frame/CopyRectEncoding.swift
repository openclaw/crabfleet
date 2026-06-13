#if canImport(FoundationEssentials)
import FoundationEssentials
#else
import Foundation
#endif

extension VNCProtocol {
	struct CopyRectEncoding: VNCFrameEncoding {
		let encodingType = VNCFrameEncodingType.copyRect.rawValue
	}
}

extension VNCProtocol.CopyRectEncoding {
	func decodeRectangle(_ rectangle: VNCProtocol.Rectangle,
						 framebuffer: VNCFramebuffer,
						 connection: NetworkConnectionReading,
						 logger: VNCLogger) async throws {
		let sourceXPosition = try await connection.readUInt16()
		let sourceYPosition = try await connection.readUInt16()

		let sourceRegion = VNCRegion(location: .init(x: sourceXPosition, y: sourceYPosition),
									 size: rectangle.region.size)

		let destinationRegion = rectangle.region

		framebuffer.copy(region: sourceRegion,
						 to: destinationRegion)

		framebuffer.didUpdate(region: destinationRegion)
	}
}
