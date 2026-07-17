#if canImport(FoundationEssentials)
import FoundationEssentials
#else
import Foundation
#endif

extension VNCProtocol {
	struct PointerPositionEncoding: VNCReceivablePseudoEncoding {
		let encodingType = VNCPseudoEncodingType.pointerPosition.rawValue
	}
}

extension VNCProtocol.PointerPositionEncoding {
	func receive(_ rectangle: VNCProtocol.Rectangle,
				 framebuffer: VNCFramebuffer,
				 connection: NetworkConnectionReading,
				 logger: VNCLogger) async throws {
		guard rectangle.width == 0,
			  rectangle.height == 0,
			  Int(rectangle.xPosition) < Int(framebuffer.size.width),
			  Int(rectangle.yPosition) < Int(framebuffer.size.height) else {
			throw VNCError.protocol(.invalidData)
		}
		framebuffer.updatePointerPosition(
			VNCPoint(x: rectangle.xPosition, y: rectangle.yPosition))
	}
}
