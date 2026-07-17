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
		let dimension = 16
		guard let representation = NSBitmapImageRep(
			bitmapDataPlanes: nil,
			pixelsWide: dimension,
			pixelsHigh: dimension,
			bitsPerSample: 8,
			samplesPerPixel: 4,
			hasAlpha: true,
			isPlanar: false,
			colorSpaceName: .deviceRGB,
			bytesPerRow: dimension * 4,
			bitsPerPixel: 32) else {
			return .arrow
		}
		representation.bitmapData?.initialize(repeating: 0, count: dimension * dimension * 4)
		let image = NSImage(size: CGSize(width: dimension, height: dimension))
		image.addRepresentation(representation)
		return NSCursor(image: image, hotSpot: .zero)
	}

}
#endif
