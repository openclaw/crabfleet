// swiftlint:disable nesting

#if canImport(FoundationEssentials)
import FoundationEssentials
#else
import Foundation
#endif

extension VNCProtocol {
    struct ServerCutText: VNCReceivableMessage {
        static let messageType: UInt8 = 3

		static let stringEncoding: String.Encoding = .isoLatin1

        let messageType: UInt8
        let text: String

		let extended: ExtendedServerCutText?
    }
}

extension VNCProtocol.ServerCutText {
    static func receive(connection: NetworkConnectionReading,
                        logger: VNCLogger) async throws -> Self {
        try await connection.readPadding(length: 3)

		let length = try await receiveLength(connection: connection,
										 logger: logger)
		guard length >= 0,
			  length <= VNCProtocolLimits.maximumClipboardBytes else {
			throw VNCError.protocol(.invalidData)
		}

		let text = try await connection.readString(encoding: Self.stringEncoding,
											   length: .init(length))

		return .init(messageType: Self.messageType,
					 text: text,
					 extended: nil)
    }
}

private extension VNCProtocol.ServerCutText {
	static func receiveLength(connection: NetworkConnectionReading,
							  logger: VNCLogger) async throws -> Int {
		let lengthDataLength = MemoryLayout<UInt32>.size
		let lengthData = try await connection.read(length: lengthDataLength)

		guard lengthData.count == lengthDataLength else {
			throw VNCError.protocol(.invalidData)
		}

		let bigEndianUnsignedLength = lengthData.withUnsafeBytes {
			$0.load(as: UInt32.self)
		}

        let endianess = Endianness.current

        var length = endianess == .little
			? Int(UInt32(bigEndian: bigEndianUnsignedLength))
			: Int(bigEndianUnsignedLength)

		// TODO: Is that the correct check?
		if length > Int32.max {
			let bigEndianSignedLength = lengthData.withUnsafeBytes {
				$0.load(as: Int32.self)
			}

			length = endianess == .little
				? Int(Int32(bigEndian: bigEndianSignedLength))
				: Int(bigEndianSignedLength)
		}

		return length
	}
}

extension VNCProtocol.ServerCutText {
	// TODO: WIP
	struct ExtendedServerCutText {
		let serverCapabilities: ServerCapabilities?

		struct ServerCapabilities {
			let format: Format
			let action: Action
		}

		struct Format: OptionSet {
			let rawValue: UInt32

			/// Plain, unformatted text using the UTF-8 encoding. End of line is represented by carriage-return and linefeed / newline pairs (values 13 and 10). The text must be followed by a terminating null even though the length is also explicitly given.
			static let text = Self(rawValue: 1)

			/// Microsoft Rich Text Format.
			static let rtf = Self(rawValue: 1 << 1)

			/// Microsoft HTML clipboard fragments.
			static let html = Self(rawValue: 1 << 2)

			/// Microsoft Device Independent Bitmap v5. A file header must not be included.
			static let dib = Self(rawValue: 1 << 3)

			/// Currently reserved but not defined.
			static let files = Self(rawValue: 1 << 4)
		}

		struct Action: OptionSet {
			let rawValue: UInt32

			/// If caps is set then the other bits indicate which formats and actions that the sender is willing to receive.
			static let caps = Self(rawValue: 1 << 24)

			/// The recipient should respond with a provide message with the clipboard data for the formats indicated in flags. No other data is provided with this message.
			static let request = Self(rawValue: 1 << 25)

			/// The recipient should send a new notify message indicating which formats are available. No other bits in flags need to be set and no other data is provided with this message.
			static let peek = Self(rawValue: 1 << 26)

			/// This message indicates which formats are available on the remote side and should be sent whenever the clipboard changes, or as a response to a peek message. The available formats are specified in flags and no other data is provided with this message.
			static let notify = Self(rawValue: 1 << 27)

			/// This message includes the actual clipboard data and should be sent whenever the clipboard changes and the data for each format is less than the respective specified maximum size, or as a response to a request message.
			static let provide = Self(rawValue: 1 << 28)
		}

		// See https://github.com/novnc/noVNC/blob/master/core/rfb.js#L2136
		static func receive(connection: NetworkConnectionReading,
							logger: VNCLogger,
							length: Int32) async throws -> Self {
			let flagsRawValue = try await connection.readUInt32()

			let formats: Format = .init(rawValue: flagsRawValue)
			let actions: Action = .init(rawValue: flagsRawValue)

			let isCaps = actions.contains(.caps)

			var serverCapabilities: ServerCapabilities?

			if isCaps {
				logger.logDebug("ExtendedServerCutText Caps")

				var bytesToSkip = 0

				var serverFormatCapabilities: Format = [ ]

				// Update server format capabilities
				for idx: UInt32 in 0..<15 {
					let index: UInt32 = 1 << idx
					let format = Format(rawValue: index)

					let supportsFormat = formats.contains(format)

					if supportsFormat {
						serverFormatCapabilities.insert(format)

						// We don't send unsolicited clipboard, so we ignore the size
						bytesToSkip += 4
					}
				}

				var serverActionCapabilities: Action = [ ]

				// Update server action capabilities
				for idx: UInt32 in 24..<31 {
					let index: UInt32 = 1 << idx
					let action = Action(rawValue: index)

					let supportsAction = actions.contains(action)

					if supportsAction {
						serverActionCapabilities.insert(action)
					}
				}

				serverCapabilities = .init(format: serverFormatCapabilities,
										   action: serverActionCapabilities)

				try await connection.readPadding(length: bytesToSkip)

				// Caps handling done, send caps with the clients capabilities set as a response
				// TODO:
				/* let clientActionCapabilities: Action = [
					Action.caps,
					Action.request,
					Action.peek,
					Action.notify,
					Action.provide
				] */

				// TODO: Send (for reference, extendedClipboardCaps in novnc: https://github.com/novnc/noVNC/blob/9761278df8f663f64f13b18e901a80bda799d893/core/rfb.js#L2997)
			} else if actions == Action.request {
				logger.logDebug("ExtendedServerCutText Request")

				// TODO
			} else if actions == Action.peek {
				logger.logDebug("ExtendedServerCutText Peek")

				// TODO
			} else if actions == Action.notify {
				logger.logDebug("ExtendedServerCutText Notify")

				// TODO
			} else if actions == Action.provide {
				logger.logDebug("ExtendedServerCutText Provide")

				// TODO
			} else {
				// TODO:
				throw VNCError.protocol(.unexpectedExtendedServerCutTextAction(action: actions.rawValue))
			}

			return .init(serverCapabilities: serverCapabilities)
		}
	}
}

// swiftlint:enable nesting
