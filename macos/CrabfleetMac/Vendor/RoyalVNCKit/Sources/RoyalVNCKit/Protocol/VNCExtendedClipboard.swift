#if canImport(FoundationEssentials)
import FoundationEssentials
#else
import Foundation
#endif

/// Extended Clipboard (pseudo-encoding 0xc0a1e5ce) message codec.
///
/// Both cut-text message types reuse this body layout when their length field
/// is negative: a 32-bit flags word followed by action-specific data. The
/// codec is public so an application-owned RFB server can speak the same
/// dialect as the client connection; only plain UTF-8 text is supported.
public enum VNCExtendedClipboard {
	/// Format bit for plain UTF-8 text.
	public static let textFormat: UInt32 = 1

	public static let capsAction: UInt32 = 1 << 24
	public static let requestAction: UInt32 = 1 << 25
	public static let peekAction: UInt32 = 1 << 26
	public static let notifyAction: UInt32 = 1 << 27
	public static let provideAction: UInt32 = 1 << 28

	/// Matches the legacy cut-text limit so no path accepts more than 1 MiB of text.
	public static let maximumTextBytes = 1 * 1_024 * 1_024

	/// Compressed bodies of incompressible maximum-size text can slightly
	/// exceed the text limit; the slack covers zlib framing overhead.
	public static let maximumBodyBytes = maximumTextBytes + 65_536

	/// Hard cap for a decompressed provide stream that may carry more formats than text.
	static let maximumDecompressedProvideBytes = 8 * 1_024 * 1_024

	static let formatMask: UInt32 = 0xffff
	static let actionMask: UInt32 = ~formatMask
}

public struct VNCExtendedClipboardCaps: Equatable, Sendable {
	public let supportsText: Bool
	public let maximumUnsolicitedTextBytes: UInt32
	public let actions: UInt32

	public init(supportsText: Bool,
				maximumUnsolicitedTextBytes: UInt32,
				actions: UInt32) {
		self.supportsText = supportsText
		self.maximumUnsolicitedTextBytes = maximumUnsolicitedTextBytes
		self.actions = actions
	}

	public var supportsProvide: Bool {
		actions & VNCExtendedClipboard.provideAction != 0
	}

	public var supportsNotify: Bool {
		actions & VNCExtendedClipboard.notifyAction != 0
	}

	public var supportsRequest: Bool {
		actions & VNCExtendedClipboard.requestAction != 0
	}

	public func allowsUnsolicitedText(byteCount: Int) -> Bool {
		supportsText
			&& byteCount >= 0
			&& UInt32(clamping: byteCount) <= maximumUnsolicitedTextBytes
	}
}

/// How an outbound text change should reach a peer, honoring the actions the
/// peer's caps advertised as receivable.
public enum VNCExtendedClipboardTextRoute: Equatable, Sendable {
	case provide
	case notify
	case legacy
}

public extension VNCExtendedClipboard {
	/// Wire size of `text` as extended clipboard payload: UTF-8 with CR-LF
	/// line endings plus the terminating NUL. Slightly over-counts existing
	/// CR-LF pairs, which keeps the bound conservative.
	static func wireTextByteCount(_ text: String) -> Int {
		var count = 1

		for byte in text.utf8 {
			count += byte == 0x0A ? 2 : 1
		}

		return count
	}

	/// Picks the outbound path for a text change. Unsolicited provide requires
	/// the peer to accept the provide action and this payload size; notify
	/// requires the notify action; otherwise fall back to legacy cut text.
	static func textRoute(wireByteCount: Int,
						  caps: VNCExtendedClipboardCaps) -> VNCExtendedClipboardTextRoute {
		guard caps.supportsText else {
			return .legacy
		}

		if caps.supportsProvide,
		   caps.allowsUnsolicitedText(byteCount: wireByteCount) {
			return .provide
		}

		if caps.supportsNotify {
			return .notify
		}

		return .legacy
	}
}

public enum VNCExtendedClipboardMessage: Equatable, Sendable {
	case caps(VNCExtendedClipboardCaps)
	case request(text: Bool)
	case peek
	case notify(text: Bool)

	/// `nil` text means the provide stream did not carry the text format.
	case provide(text: String?)
}

public enum VNCExtendedClipboardError: Error, Equatable, Sendable {
	case bodyTooShort
	case bodyTooLarge
	case unknownAction(flags: UInt32)
	case malformedCaps
	case malformedProvide
	case textTooLarge
	case compressionFailed
}

// MARK: - Encoding
public extension VNCExtendedClipboard {
	/// Frames an extended body as a complete cut-text message
	/// (`3` for server-to-client, `6` for client-to-server).
	static func frame(messageType: UInt8, body: Data) -> Data {
		var data = Data(capacity: 8 + body.count)
		data.append(messageType)
		data.append(contentsOf: [0, 0, 0])
		data.append(Int32(-body.count), bigEndian: true)
		data.append(body)
		return data
	}

	static func encodeCaps(maximumUnsolicitedTextBytes: UInt32) -> Data {
		let flags = capsAction
			| requestAction
			| peekAction
			| notifyAction
			| provideAction
			| textFormat

		var body = Data(capacity: 8)
		body.append(flags, bigEndian: true)
		body.append(maximumUnsolicitedTextBytes, bigEndian: true)
		return body
	}

	static func encodeRequestText() -> Data {
		flagsOnlyBody(requestAction | textFormat)
	}

	static func encodePeek() -> Data {
		flagsOnlyBody(peekAction)
	}

	static func encodeNotify(hasText: Bool) -> Data {
		flagsOnlyBody(notifyAction | (hasText ? textFormat : 0))
	}

	static func encodeProvide(text: String) throws -> Data {
		let wireText = text
			.replacingOccurrences(of: "\r\n", with: "\n")
			.replacingOccurrences(of: "\n", with: "\r\n")

		var textData = Data(wireText.utf8)
		textData.append(0)

		guard textData.count <= maximumTextBytes else {
			throw VNCExtendedClipboardError.textTooLarge
		}

		var uncompressed = Data(capacity: 4 + textData.count)
		uncompressed.append(UInt32(textData.count), bigEndian: true)
		uncompressed.append(textData)

		guard let compressed = try? ZlibOneShot.deflate(uncompressed) else {
			throw VNCExtendedClipboardError.compressionFailed
		}

		var body = Data(capacity: 4 + compressed.count)
		body.append(provideAction | textFormat, bigEndian: true)
		body.append(compressed)
		return body
	}

	private static func flagsOnlyBody(_ flags: UInt32) -> Data {
		var body = Data(capacity: 4)
		body.append(flags, bigEndian: true)
		return body
	}
}

// MARK: - Decoding
public extension VNCExtendedClipboard {
	/// Decodes one extended cut-text body (flags word plus action data).
	static func decode(body: Data) throws -> VNCExtendedClipboardMessage {
		guard body.count >= 4 else {
			throw VNCExtendedClipboardError.bodyTooShort
		}

		guard body.count <= 4 + maximumBodyBytes else {
			throw VNCExtendedClipboardError.bodyTooLarge
		}

		let bytes = Data(body)
		let flags = UInt32(bytes[0]) << 24
			| UInt32(bytes[1]) << 16
			| UInt32(bytes[2]) << 8
			| UInt32(bytes[3])

		let formats = flags & formatMask
		let remainder = bytes.dropFirst(4)

		if flags & capsAction != 0 {
			return .caps(try decodeCaps(formats: formats,
										flags: flags,
										data: remainder))
		}

		switch flags & actionMask {
			case requestAction:
				return .request(text: formats & textFormat != 0)
			case peekAction:
				return .peek
			case notifyAction:
				return .notify(text: formats & textFormat != 0)
			case provideAction:
				return .provide(text: try decodeProvideText(formats: formats,
															compressed: remainder))
			default:
				throw VNCExtendedClipboardError.unknownAction(flags: flags)
		}
	}

	private static func decodeCaps(formats: UInt32,
								   flags: UInt32,
								   data: Data.SubSequence) throws -> VNCExtendedClipboardCaps {
		var announcedFormatCount = 0

		for bit in 0..<16 where formats & (1 << UInt32(bit)) != 0 {
			announcedFormatCount += 1
		}

		guard data.count >= announcedFormatCount * 4 else {
			throw VNCExtendedClipboardError.malformedCaps
		}

		var maximumUnsolicitedTextBytes: UInt32 = 0
		var offset = data.startIndex

		for bit in 0..<16 where formats & (1 << UInt32(bit)) != 0 {
			let size = UInt32(data[offset]) << 24
				| UInt32(data[offset + 1]) << 16
				| UInt32(data[offset + 2]) << 8
				| UInt32(data[offset + 3])
			offset += 4

			if UInt32(1 << bit) == textFormat {
				maximumUnsolicitedTextBytes = size
			}
		}

		return .init(supportsText: formats & textFormat != 0,
					 maximumUnsolicitedTextBytes: maximumUnsolicitedTextBytes,
					 actions: flags & actionMask)
	}

	private static func decodeProvideText(formats: UInt32,
										  compressed: Data.SubSequence) throws -> String? {
		guard formats & textFormat != 0 else {
			return nil
		}

		guard let decompressed = try? ZlibOneShot.inflate(
			Data(compressed),
			maximumDecompressedBytes: maximumDecompressedProvideBytes
		) else {
			throw VNCExtendedClipboardError.malformedProvide
		}

		// Text is format bit zero, so its chunk is always first in the stream.
		guard decompressed.count >= 4 else {
			throw VNCExtendedClipboardError.malformedProvide
		}

		let length = Int(UInt32(decompressed[0]) << 24
			| UInt32(decompressed[1]) << 16
			| UInt32(decompressed[2]) << 8
			| UInt32(decompressed[3]))

		guard length <= maximumTextBytes,
			  decompressed.count >= 4 + length else {
			throw VNCExtendedClipboardError.malformedProvide
		}

		var textBytes = decompressed.subdata(in: 4..<(4 + length))

		if let nulIndex = textBytes.firstIndex(of: 0) {
			textBytes = textBytes.prefix(upTo: nulIndex)
		}

		guard let wireText = String(bytes: textBytes, encoding: .utf8) else {
			throw VNCExtendedClipboardError.malformedProvide
		}

		return wireText.replacingOccurrences(of: "\r\n", with: "\n")
	}
}
