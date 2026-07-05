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
	/// True once the server negotiated the Extended Clipboard extension,
	/// which lifts the ISO-8859-1 restriction on clipboard text.
	var supportsUTF8Clipboard: Bool {
		state.extendedClipboardServerCaps?.supportsText == true
	}

	func sendClipboardText(_ text: String) throws {
		guard settings.clipboardMode != .disabled else {
			throw VNCClipboardError.disabled
		}
		guard connectionState.status == .connected else {
			throw VNCClipboardError.notConnected
		}

		if let caps = state.extendedClipboardServerCaps, caps.supportsText,
		   try sendExtendedClipboardText(text, caps: caps) {
			return
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

private extension VNCConnection {
	/// Returns false when neither an unsolicited provide nor a notify is
	/// receivable by the server, so the caller falls back to legacy cut text.
	func sendExtendedClipboardText(_ text: String,
								   caps: VNCExtendedClipboardCaps) throws -> Bool {
		let wireByteCount = VNCExtendedClipboard.wireTextByteCount(text)

		guard wireByteCount <= VNCProtocolLimits.maximumClipboardBytes else {
			throw VNCClipboardError.payloadTooLarge(
				maximumBytes: VNCProtocolLimits.maximumClipboardBytes
			)
		}

		// Kept regardless of route so a later server request can be answered.
		state.lastExtendedClipboardText = text

		switch VNCExtendedClipboard.textRoute(wireByteCount: wireByteCount,
											  caps: caps) {
			case .provide:
				guard let body = try? VNCExtendedClipboard.encodeProvide(text: text) else {
					throw VNCClipboardError.payloadTooLarge(
						maximumBytes: VNCProtocolLimits.maximumClipboardBytes
					)
				}

				enqueueClientToServerMessage(VNCProtocol.ExtendedClientCutText(body: body))

				return true

			case .notify:
				enqueueClientToServerMessage(VNCProtocol.ExtendedClientCutText(
					body: VNCExtendedClipboard.encodeNotify(hasText: true)
				))

				return true

			case .legacy:
				return false
		}
	}
}
