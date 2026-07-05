#if canImport(FoundationEssentials)
import FoundationEssentials
#else
import Foundation
#endif

extension VNCConnection {
	func startMonitoringClipboard() {
		guard settings.clipboardMode == .systemPasteboard else { return }

		clipboardMonitor.startMonitoring()
	}

	func stopMonitoringClipboard() {
		guard settings.clipboardMode == .systemPasteboard else { return }

		clipboardMonitor.stopMonitoring()
	}
}

// MARK: - VNCClipboardMonitorDelegate
extension VNCConnection: VNCClipboardMonitorDelegate {
	func clipboardMonitorShouldMonitor(_ clipboardMonitor: VNCClipboardMonitor) -> Bool {
		let isConnected = connectionState.status == .connected

		return isConnected
	}

	func clipboardMonitor(_ clipboardMonitor: VNCClipboardMonitor,
						  didChangeText text: String) {
		logger.logDebug("Clipboard Monitor did change text")

		guard settings.clipboardMode == .systemPasteboard else { return }

		// Route through the extended-aware sender so UTF-8 text reaches
		// Extended Clipboard servers instead of being dropped as non-Latin-1.
		do {
			try sendClipboardText(text)
		} catch {
			logger.logWarning("Ignoring unsendable clipboard change: \(error)")
		}
	}
}
