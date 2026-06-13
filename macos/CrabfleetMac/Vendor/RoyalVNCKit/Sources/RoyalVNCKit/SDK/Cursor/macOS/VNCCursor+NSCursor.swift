#if os(macOS)
#if canImport(FoundationEssentials)
import FoundationEssentials
#else
import Foundation
#endif

import AppKit

public extension VNCCursor {
	var nsCursor: NSCursor {
		guard !isEmpty else {
			return Self.emptyNSCursor
		}

		guard let nsImage else {
			return Self.emptyNSCursor
		}

		let cursor = NSCursor(image: nsImage,
							  hotSpot: hotspot.cgPoint)

		return cursor
	}
}

private extension VNCCursor {
	static var emptyNSCursor: NSCursor {
		// TODO: Should use a "dot" cursor like in other VNC clients

		.arrow
	}

	var nsImage: NSImage? {
		guard let cgImage else { return nil }

		let nsImage = NSImage(cgImage: cgImage, size: size.cgSize)

		return nsImage
	}
}
#endif
