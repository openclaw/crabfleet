#if os(macOS)
#if canImport(FoundationEssentials)
import FoundationEssentials
#else
import Foundation
#endif

import AppKit

#if canImport(ObjectiveC)
@objc(VNCScrollView)
#endif
public final class VNCScrollView: NSScrollView {
	public override func scrollWheel(with event: NSEvent) {
		nextResponder?
			.nextResponder?
			.nextResponder?
			.scrollWheel(with: event)
	}

	public override init(frame frameRect: NSRect) {
		super.init(frame: frameRect)

		commonInit()
	}

	public required init?(coder: NSCoder) {
		super.init(coder: coder)

		commonInit()
	}
}

private extension VNCScrollView {
	func commonInit() {
		scrollerStyle = .legacy
		autohidesScrollers = false

		hasVerticalScroller = false
		hasHorizontalScroller = false
	}
}
#endif
