#if os(macOS)
#if canImport(FoundationEssentials)
import FoundationEssentials
#else
import Foundation
#endif

import AppKit

@MainActor
protocol DisplayLinkDelegate: AnyObject {
	func displayLinkDidUpdate(_ displayLink: DisplayLink)
}

final class DisplayLink {
	private let displayLink: CVDisplayLink

	weak var delegate: DisplayLinkDelegate?

	var isEnabled: Bool {
		get {
			CVDisplayLinkIsRunning(displayLink)
		}
		set {
			if newValue {
				CVDisplayLinkStart(displayLink)
			} else {
				CVDisplayLinkStop(displayLink)
			}
		}
	}

	init?(screen: NSScreen) {
		let displayID = screen.directDisplayID

		var displayLink: CVDisplayLink?

		let createStatus = CVDisplayLinkCreateWithCGDisplay(displayID, &displayLink)

		guard createStatus == kCVReturnSuccess,
			let displayLink = displayLink else {
			return nil
		}

		self.displayLink = displayLink

		registerCallback()
	}

	deinit {
		isEnabled = false

		unregisterCallback()
	}
}

private extension DisplayLink {
	func registerCallback() {
		let callback: CVDisplayLinkOutputCallback = { _, _, _, _, _, userInfo -> CVReturn in
			guard let userInfo = userInfo else {
				return kCVReturnSuccess
			}

			let strongSelf = Unmanaged<DisplayLink>.fromOpaque(.init(userInfo)).takeUnretainedValue()

			DispatchQueue.main.async {
				strongSelf.delegate?.displayLinkDidUpdate(strongSelf)
			}

			return kCVReturnSuccess
		}

		let unmanagedSelf = Unmanaged.passUnretained(self)
		let selfPtr = unmanagedSelf.toOpaque()

		CVDisplayLinkSetOutputCallback(displayLink, callback, selfPtr)
	}

	func unregisterCallback() {
		CVDisplayLinkSetOutputCallback(displayLink, nil, nil)
	}
}

private extension NSScreen {
	var directDisplayID: CGDirectDisplayID {
		let id = deviceDescription[.init("NSScreenNumber")] as? CGDirectDisplayID ?? 0

		return id
	}
}
#endif
