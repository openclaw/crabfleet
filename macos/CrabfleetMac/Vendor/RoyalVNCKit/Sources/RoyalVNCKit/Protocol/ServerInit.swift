#if canImport(FoundationEssentials)
import FoundationEssentials
#else
import Foundation
#endif

extension VNCProtocol {
	struct ServerInit {
		let framebufferWidth: UInt16
		let framebufferHeight: UInt16

		let pixelFormat: PixelFormat

		let name: String
	}
}

extension VNCProtocol.ServerInit {
	static func receive(connection: NetworkConnectionReading,
						isTightSecurityEnabled: Bool) async throws -> Self {
		guard !isTightSecurityEnabled else {
			// TODO: When Tight Security is enabled there are addtional fields
			// See https://github.com/rfbproto/rfbproto/blob/master/rfbproto.rst#serverinit
			throw VNCError.protocol(.notImplemented(feature: "Tight Security"))
		}

		let frameBufferWidth = try await connection.readUInt16()
		let frameBufferHeight = try await connection.readUInt16()

		let pixelFormat = try await VNCProtocol.PixelFormat.receive(connection: connection)

		let name = try await connection.readString(encoding: .utf8)

		return .init(framebufferWidth: frameBufferWidth,
					 framebufferHeight: frameBufferHeight,
					 pixelFormat: pixelFormat,
					 name: name)
	}
}
