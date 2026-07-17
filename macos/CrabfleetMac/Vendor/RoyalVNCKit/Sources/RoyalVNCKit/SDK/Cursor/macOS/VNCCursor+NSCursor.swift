#if os(macOS)
#if canImport(FoundationEssentials)
import FoundationEssentials
#else
import Foundation
#endif

import AppKit

public extension VNCCursor {
	var nsCursor: NSCursor {
		nsCursor(scale: 1)
	}

	func nsCursor(scale: CGFloat) -> NSCursor {
		guard !isEmpty else {
			return Self.emptyNSCursor
		}

		guard let cgImage else {
			return Self.emptyNSCursor
		}
		let scale = max(scale, CGFloat.leastNonzeroMagnitude)
		let imageSize = CGSize(
			width: max(1, CGFloat(size.width) * scale),
			height: max(1, CGFloat(size.height) * scale))
		let image = NSImage(cgImage: cgImage, size: imageSize)
		let scaledHotspot = CGPoint(
			x: CGFloat(hotspot.x) * scale,
			y: CGFloat(hotspot.y) * scale)

		let cursor = NSCursor(image: image, hotSpot: scaledHotspot)

		return cursor
	}
}

private extension VNCCursor {
	static var emptyNSCursor: NSCursor {
		// TODO: Should use a "dot" cursor like in other VNC clients

		.arrow
	}

}
#endif
