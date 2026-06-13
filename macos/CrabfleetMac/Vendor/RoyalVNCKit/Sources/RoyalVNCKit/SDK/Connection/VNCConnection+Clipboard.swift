#if canImport(FoundationEssentials)
import FoundationEssentials
#else
import Foundation
#endif

public enum VNCClipboardError: Error, Equatable, LocalizedError, Sendable {
	case disabled
	case notConnected
	case payloadTooLarge(maximumBytes: Int)
	case unsupportedCharacters

	public var errorDescription: String? {
		switch self {
			case .disabled:
				return "Clipboard synchronization is disabled for this connection."
			case .notConnected:
				return "The VNC connection is not ready for clipboard text."
			case .payloadTooLarge(let maximumBytes):
				return "Clipboard text exceeds the \(maximumBytes)-byte VNC limit."
			case .unsupportedCharacters:
				return "This VNC server path supports ISO-8859-1 clipboard text only."
		}
	}
}

public extension VNCConnection {
	func sendClipboardText(_ text: String) throws {
		guard settings.clipboardMode != .disabled else {
			throw VNCClipboardError.disabled
		}
		guard connectionState.status == .connected else {
			throw VNCClipboardError.notConnected
		}

		var byteCount = 0
		for scalar in text.unicodeScalars {
			guard scalar.value <= UInt8.max else {
				throw VNCClipboardError.unsupportedCharacters
			}
			byteCount += 1
			guard byteCount <= VNCProtocolLimits.maximumClipboardBytes else {
				throw VNCClipboardError.payloadTooLarge(
					maximumBytes: VNCProtocolLimits.maximumClipboardBytes
				)
			}
		}

		enqueueClientCutTextMessage(text)
	}
}
