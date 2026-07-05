#if canImport(FoundationEssentials)
import FoundationEssentials
#else
import Foundation
#endif

extension VNCProtocol {
    struct ServerCutText: VNCReceivableMessage {
        static let messageType: UInt8 = 3

		static let stringEncoding: String.Encoding = .isoLatin1

		/// Flags word plus the codec's bounded compressed payload.
		static let maximumExtendedBodyBytes = 4 + VNCExtendedClipboard.maximumBodyBytes

        let messageType: UInt8
        let text: String

		/// True for negative-length bodies, even when decoding failed, so a
		/// malformed extended message is never mistaken for legacy cut text.
		let isExtended: Bool
		let extended: VNCExtendedClipboardMessage?
    }
}

extension VNCProtocol.ServerCutText {
    static func receive(connection: NetworkConnectionReading,
                        logger: VNCLogger) async throws -> Self {
        try await connection.readPadding(length: 3)

		let length = Int(try await connection.readInt32())

		if length >= 0 {
			guard length <= VNCProtocolLimits.maximumClipboardBytes else {
				throw VNCError.protocol(.invalidData)
			}

			let text = try await connection.readString(encoding: Self.stringEncoding,
													   length: length)

			return .init(messageType: Self.messageType,
						 text: text,
						 isExtended: false,
						 extended: nil)
		}

		// A negative length marks an Extended Clipboard body of abs(length) bytes.
		let bodyLength = -length

		guard bodyLength <= Self.maximumExtendedBodyBytes else {
			throw VNCError.protocol(.invalidData)
		}

		let body = try await connection.read(length: bodyLength)

		guard body.count == bodyLength else {
			throw VNCError.protocol(.invalidData)
		}

		// The body is fully consumed, so a malformed message is dropped
		// without desynchronizing or tearing down the connection.
		let extended: VNCExtendedClipboardMessage?

		do {
			extended = try VNCExtendedClipboard.decode(body: body)
		} catch {
			logger.logWarning("Ignoring malformed extended clipboard message: \(error)")
			extended = nil
		}

		return .init(messageType: Self.messageType,
					 text: "",
					 isExtended: true,
					 extended: extended)
    }
}
