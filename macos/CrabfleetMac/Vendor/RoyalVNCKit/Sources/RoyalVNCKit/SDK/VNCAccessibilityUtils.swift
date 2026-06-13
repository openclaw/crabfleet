#if os(macOS)
#if canImport(FoundationEssentials)
import FoundationEssentials
#else
import Foundation
#endif

import AppKit
import ApplicationServices

@objc(VNCAccessibilityUtils)
public final class VNCAccessibilityUtils: NSObject {
	private static let accessibilityPreferencePaneURL = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")!

    @objc
	public static func inputModeRequiresAccessibilityPermissions(_ inputMode: VNCConnection.Settings.InputMode) -> Bool {
		inputMode.requiresAccessibilityPermissions
	}

    @objc
	public static var hasAccessibilityPermissions: Bool {
		AXIsProcessTrusted()
	}

	@discardableResult
    @objc
	public static func openAccessibilityPermissionsPreferencePane() -> Bool {
		let success = NSWorkspace.shared.open(accessibilityPreferencePaneURL)

		return success
	}
}
#endif
