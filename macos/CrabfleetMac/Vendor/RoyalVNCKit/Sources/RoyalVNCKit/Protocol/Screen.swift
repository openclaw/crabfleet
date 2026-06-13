#if canImport(FoundationEssentials)
import FoundationEssentials
#else
import Foundation
#endif

extension VNCProtocol {
	struct Screen {
		let id: UInt32

		let xPosition: UInt16
		let yPosition: UInt16

		let width: UInt16
		let height: UInt16

		let flags: UInt32
	}
}

extension VNCProtocol.Screen {
	static func receive(connection: NetworkConnectionReading) async throws -> Self {
		let id = try await connection.readUInt32()

		let xPosition = try await connection.readUInt16()
		let yPosition = try await connection.readUInt16()

		let width = try await connection.readUInt16()
		let height = try await connection.readUInt16()

		let flags = try await connection.readUInt32()

		return .init(id: id,
					 xPosition: xPosition,
					 yPosition: yPosition,
					 width: width,
					 height: height,
					 flags: flags)
	}

	var region: VNCRegion {
		return .init(location: .init(x: xPosition, y: yPosition),
					 size: .init(width: width, height: height))
	}
}
