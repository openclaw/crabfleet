#if canImport(FoundationEssentials)
import FoundationEssentials
#else
import Foundation
#endif

protocol VNCFrameEncoding: VNCEncoding {
	func decodeRectangle(_ rectangle: VNCProtocol.Rectangle,
						 framebuffer: VNCFramebuffer,
						 connection: NetworkConnectionReading,
						 logger: VNCLogger) async throws
}
