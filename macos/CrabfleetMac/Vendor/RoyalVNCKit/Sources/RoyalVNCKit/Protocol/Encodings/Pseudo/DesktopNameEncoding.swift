#if canImport(FoundationEssentials)
import FoundationEssentials
#else
import Foundation
#endif

extension VNCProtocol {
	// TODO: Untested - not sure how?
	struct DesktopNameEncoding: VNCReceivablePseudoEncoding {
		let encodingType = VNCPseudoEncodingType.desktopName.rawValue
	}
}

extension VNCProtocol.DesktopNameEncoding {
	func receive(_ rectangle: VNCProtocol.Rectangle,
				 framebuffer: VNCFramebuffer,
				 connection: NetworkConnectionReading,
				 logger: VNCLogger) async throws {
		// Rectangle must be all zero
		guard rectangle.region == .zero else {
			throw VNCError.protocol(.frameDecode(encodingType: encodingType, underlyingError: nil))
		}

		logger.logDebug("Receiving new desktop name")

		let newDesktopName = try await connection.readString(encoding: .utf8)

		logger.logDebug("Finished receiving new desktop name: \"\(newDesktopName)\"")

		framebuffer.updateDesktopName(newDesktopName)
	}
}
