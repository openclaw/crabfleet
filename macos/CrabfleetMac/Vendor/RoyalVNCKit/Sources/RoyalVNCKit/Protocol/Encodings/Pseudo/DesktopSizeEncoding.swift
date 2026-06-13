#if canImport(FoundationEssentials)
import FoundationEssentials
#else
import Foundation
#endif

extension VNCProtocol {
	struct DesktopSizeEncoding: VNCReceivablePseudoEncoding {
		let encodingType = VNCPseudoEncodingType.desktopSize.rawValue
	}
}

extension VNCProtocol.DesktopSizeEncoding {
	func receive(_ rectangle: VNCProtocol.Rectangle,
				 framebuffer: VNCFramebuffer,
				 connection: NetworkConnectionReading,
				 logger: VNCLogger) async throws {
		let newSize = rectangle.region.size

		framebuffer.resize(to: newSize)
	}
}
