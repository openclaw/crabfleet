#if canImport(FoundationEssentials)
import FoundationEssentials
#else
import Foundation
#endif

extension VNCProtocol {
	struct RREEncoding: VNCFrameEncoding {
		let encodingType = VNCFrameEncodingType.rre.rawValue
	}
}

extension VNCProtocol.RREEncoding {
	func decodeRectangle(_ rectangle: VNCProtocol.Rectangle,
						 framebuffer: VNCFramebuffer,
						 connection: NetworkConnectionReading,
						 logger: VNCLogger) async throws {
		logger.logDebug("Beginning to read RRE Encoding")

		let bytesPerPixel = framebuffer.sourceProperties.bytesPerPixel

		let numberOfSubRectangles = try await connection.readUInt32()
		guard numberOfSubRectangles <= VNCProtocolLimits.maximumSubrectangles else {
			throw VNCError.protocol(.invalidData)
		}
		var backgroundPixelValue = try await connection.read(length: bytesPerPixel)

		logger.logDebug("Received RRE Encoding number of sub rectangles: \(numberOfSubRectangles)")

		framebuffer.fill(region: rectangle.region,
						 withPixel: &backgroundPixelValue)

		for idx in 0..<numberOfSubRectangles {
			logger.logDebug("Receiving RRE Encoding Sub Rectangles \(idx + 1)/\(numberOfSubRectangles)")

			let subRectangle = try await SubRectangle.receive(bytesPerPixel: bytesPerPixel,
														  connection: connection)
			guard Int(subRectangle.xPosition) + Int(subRectangle.width) <= Int(rectangle.width),
				  Int(subRectangle.yPosition) + Int(subRectangle.height) <= Int(rectangle.height) else {
				throw VNCError.protocol(.invalidData)
			}

			let subRegion = VNCRegion(x: rectangle.xPosition + subRectangle.xPosition,
									  y: rectangle.yPosition + subRectangle.yPosition,
									  width: subRectangle.width,
									  height: subRectangle.height)

			var foregroundPixelValue = subRectangle.pixelValue

			logger.logDebug("Received RRE Encoding Sub Rectangle \(idx + 1)/\(numberOfSubRectangles): \(subRectangle)")

			framebuffer.fill(region: subRegion,
							 withPixel: &foregroundPixelValue)
		}

		let region = rectangle.region

		framebuffer.didUpdate(region: region)
	}
}

private extension VNCProtocol.RREEncoding {
	struct SubRectangle {
		let pixelValue: Data

		let xPosition: UInt16
		let yPosition: UInt16

		let width: UInt16
		let height: UInt16
	}
}

private extension VNCProtocol.RREEncoding.SubRectangle {
	static func receive(bytesPerPixel: Int,
						connection: NetworkConnectionReading) async throws -> Self {
		let pixelValue = try await connection.read(length: bytesPerPixel)

		let xPosition = try await connection.readUInt16()
		let yPosition = try await connection.readUInt16()

		let width = try await connection.readUInt16()
		let height = try await connection.readUInt16()

		return .init(pixelValue: pixelValue,
					 xPosition: xPosition,
					 yPosition: yPosition,
					 width: width,
					 height: height)
	}
}
