#if canImport(FoundationEssentials)
import FoundationEssentials
#else
import Foundation
#endif

#if os(macOS)
import AppKit
#elseif os(iOS)
import UIKit
#endif

final class VNCClipboard {
#if os(macOS)
	let pasteboard: NSPasteboard
#elseif os(iOS)
	let pasteboard: UIPasteboard
#endif

#if os(macOS)
	init(pasteboard: NSPasteboard = .general) {
		self.pasteboard = pasteboard
	}
#elseif os(iOS)
	init(pasteboard: UIPasteboard = .general) {
		self.pasteboard = pasteboard
	}
#else
	init() {}
#endif
}

extension VNCClipboard {
	var text: String? {
		get {
#if os(macOS)
            let pBoardType = pasteboard.availableType(from: [.string])

            guard let pBoardType,
                  pBoardType == .string else {
                return nil
            }

			let text = pasteboard.string(forType: pBoardType)
#elseif os(iOS)
            guard pasteboard.hasStrings else {
                return nil
            }

			let text = pasteboard.string
#else
			let text: String? = nil
#endif

			return text
		}
		set {
#if os(macOS)
			pasteboard.clearContents()

			pasteboard.setString(newValue ?? "", forType: .string)
#elseif os(iOS)
			pasteboard.string = newValue
#endif
		}
	}
}

extension VNCClipboard {
	var changeCount: Int {
#if os(macOS) || os(iOS)
		pasteboard.changeCount
#else
		0
#endif
	}
}
