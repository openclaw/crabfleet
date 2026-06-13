#if os(macOS)
#if canImport(FoundationEssentials)
import FoundationEssentials
#else
import Foundation
#endif

import AppKit

#if canImport(ObjectiveC)
@objc(VNCCenteringClipView)
#endif
public final class VNCCenteringClipView: NSClipView {
	public override func constrainBoundsRect(_ proposedBounds: NSRect) -> NSRect {
		var rect = super.constrainBoundsRect(proposedBounds)

		guard let containerView = documentView else { return rect }

		if rect.size.width > containerView.frame.size.width {
			rect.origin.x = (containerView.frame.size.width - rect.size.width) / 2.0
		}

		if rect.size.height > containerView.frame.size.height {
			rect.origin.y = (containerView.frame.size.height - rect.size.height) / 2.0
		}

		return rect
	}

	public override var drawsBackground: Bool {
		get {
			return false
		}
		set {
			// Into the void...
		}
	}
}
#endif
