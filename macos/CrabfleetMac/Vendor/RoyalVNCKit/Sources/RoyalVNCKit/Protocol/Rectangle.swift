#if canImport(FoundationEssentials)
import FoundationEssentials
#else
import Foundation
#endif

extension VNCProtocol {
	struct Rectangle {
		let xPosition: UInt16
		let yPosition: UInt16

		let width: UInt16
		let height: UInt16

		let encodingType: Int32
	}
}

extension VNCProtocol.Rectangle {
	static func receive(connection: NetworkConnectionReading) async throws -> Self {
		let xPosition = try await connection.readUInt16()
		let yPosition = try await connection.readUInt16()

		let width = try await connection.readUInt16()
		let height = try await connection.readUInt16()

		let encodingType = try await connection.readInt32()

		return .init(xPosition: xPosition,
					 yPosition: yPosition,
					 width: width,
					 height: height,
					 encodingType: encodingType)
	}

	var region: VNCRegion {
		return .init(location: .init(x: xPosition, y: yPosition),
					 size: .init(width: width, height: height))
	}
}
