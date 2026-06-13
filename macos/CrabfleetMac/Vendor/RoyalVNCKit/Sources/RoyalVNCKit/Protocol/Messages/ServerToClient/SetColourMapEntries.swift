#if canImport(FoundationEssentials)
import FoundationEssentials
#else
import Foundation
#endif

extension VNCProtocol {
	struct SetColourMapEntries: VNCReceivableMessage {
		static let messageType: UInt8 = 1

		let messageType: UInt8

		let firstColour: UInt16
		let colors: [Colour]
	}
}

extension VNCProtocol.SetColourMapEntries {
	struct Colour {
		let red: UInt16
		let green: UInt16
		let blue: UInt16
	}
}

extension VNCProtocol.SetColourMapEntries {
	static func receive(connection: NetworkConnectionReading,
						logger: VNCLogger) async throws -> Self {
		try await connection.readPadding()

		let firstColour = try await connection.readUInt16()
		let numberOfColours = try await connection.readUInt16()
		guard Int(firstColour) + Int(numberOfColours) <= 65_536 else {
			throw VNCError.protocol(.invalidData)
		}

		var colours = [Colour]()

		for _ in 0..<numberOfColours {
			let colour = try await Colour.receive(connection: connection,
												  logger: logger)

			colours.append(colour)
		}

		return .init(messageType: Self.messageType,
					 firstColour: firstColour,
					 colors: colours)
	}
}

extension VNCProtocol.SetColourMapEntries.Colour {
	static func receive(connection: NetworkConnectionReading,
						logger: VNCLogger) async throws -> Self {
		let red = try await connection.readUInt16()
		let green = try await connection.readUInt16()
		let blue = try await connection.readUInt16()

		return .init(red: red,
					 green: green,
					 blue: blue)
	}
}

extension VNCProtocol.SetColourMapEntries.Colour {
	var redUInt8: UInt8 {
		return .init(red / 256)
	}

	var greenUInt8: UInt8 {
		return .init(green / 256)
	}

	var blueUInt8: UInt8 {
		return .init(blue / 256)
	}
}
