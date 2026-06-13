#if canImport(FoundationEssentials)
import FoundationEssentials
#else
import Foundation
#endif

extension VNCProtocol {
	struct HextileEncoding: VNCFrameEncoding {
		let encodingType = VNCFrameEncodingType.hextile.rawValue

		static let tileSize: UInt16 = 16

		let rawEncoding: RawEncoding
	}
}

extension VNCProtocol.HextileEncoding {
	func decodeRectangle(_ rectangle: VNCProtocol.Rectangle,
						 framebuffer: VNCFramebuffer,
						 connection: NetworkConnectionReading,
						 logger: VNCLogger) async throws {
		logger.logDebug("Beginning to read Hextile Encoding")

		let bytesPerPixel = framebuffer.sourceProperties.bytesPerPixel

		let rectangleWidth = rectangle.width
		let rectangleHeight = rectangle.height

		let rectangleX = rectangle.xPosition
		let rectangleY = rectangle.yPosition

		let xTileCount = (rectangleWidth + Self.tileSize - 1) / Self.tileSize
		let yTileCount = (rectangleHeight + Self.tileSize - 1) / Self.tileSize

		var lastBackgroundPixelData: Data?
		var lastForegroundPixelData: Data?

		for tileY in 0..<yTileCount {
			for tileX in 0..<xTileCount {
				let tileTopLeftX = rectangleX + (tileX * Self.tileSize)
				let tileTopLeftY = rectangleY + (tileY * Self.tileSize)

				let tileWidth = Self.tileSize(tileNumber: tileX,
											  tileCount: xTileCount,
											  rectangleSize: rectangleWidth)

				let tileHeight = Self.tileSize(tileNumber: tileY,
											   tileCount: yTileCount,
											   rectangleSize: rectangleHeight)

				let subencodingMask = try await connection.readUInt8()
				let subencoding = SubencodingMask(rawValue: subencodingMask)

				let isRaw = subencoding.contains(.raw)

				guard let rawEncodingType = rawEncoding.encodingType.int32Value else {
					fatalError("Failed to convert Raw Encoding type to Int32")
				}

				let tileRectangle = VNCProtocol.Rectangle(xPosition: tileTopLeftX,
														  yPosition: tileTopLeftY,
														  width: tileWidth,
														  height: tileHeight,
														  encodingType: rawEncodingType)

				if isRaw {
					try await rawEncoding.decodeRectangle(tileRectangle,
														  framebuffer: framebuffer,
														  connection: connection,
														  logger: logger)
				} else {
					let hasBackground = subencoding.contains(.backgroundSpecified)
					let hasForeground = subencoding.contains(.foregroundSpecified)
					let hasSubrects = subencoding.contains(.anySubrects)
					let subrectsColored = subencoding.contains(.subrectsColoured)

					let backgroundPixelData = hasBackground
						? try await connection.read(length: bytesPerPixel)
						: lastBackgroundPixelData

					let foregroundPixelData = hasForeground
						? try await connection.read(length: bytesPerPixel)
						: lastForegroundPixelData

					lastBackgroundPixelData = backgroundPixelData
					lastForegroundPixelData = foregroundPixelData

					if var backgroundPixelData = backgroundPixelData {
						framebuffer.fill(region: tileRectangle.region,
										 withPixel: &backgroundPixelData)
					}

					if hasSubrects {
						let subrectCount = try await connection.readUInt8()

						for _ in 0..<subrectCount {
							let subrectPixelData = subrectsColored
								? try await connection.read(length: bytesPerPixel)
								: foregroundPixelData

							let coords = try await connection.readUInt8()
							let dimensions = try await connection.readUInt8()

							let subrectX = coords >> 4
							let subrectY = coords & 0x0f

							let subrectWidth = (dimensions >> 4) + 1
							let subrectHeight = (dimensions & 0x0f) + 1
							guard Int(subrectX) + Int(subrectWidth) <= Int(tileWidth),
								  Int(subrectY) + Int(subrectHeight) <= Int(tileHeight) else {
								throw VNCError.protocol(.invalidData)
							}

							let subrectTopLeftX = tileTopLeftX + .init(subrectX)
							let subrectTopLeftY = tileTopLeftY + .init(subrectY)

							let subrectRegion = VNCRegion(x: subrectTopLeftX,
														  y: subrectTopLeftY,
														  width: .init(subrectWidth),
														  height: .init(subrectHeight))

							if var subrectPixelData {
								framebuffer.fill(region: subrectRegion,
												 withPixel: &subrectPixelData)
							}
						}
					}
				}
			}
		}

		let region = rectangle.region

		framebuffer.didUpdate(region: region)
	}
}

private extension VNCProtocol.HextileEncoding {
	struct SubencodingMask: OptionSet {
		let rawValue: UInt8

		static let raw    				= SubencodingMask(rawValue: 1 << 0)
		static let backgroundSpecified  = SubencodingMask(rawValue: 1 << 1)
		static let foregroundSpecified  = SubencodingMask(rawValue: 1 << 2)
		static let anySubrects   		= SubencodingMask(rawValue: 1 << 3)
		static let subrectsColoured   	= SubencodingMask(rawValue: 1 << 4)
	}

	static func tileSize(tileNumber: UInt16,
						 tileCount: UInt16,
						 rectangleSize: UInt16) -> UInt16 {
		let overlap = rectangleSize % Self.tileSize

		if tileNumber == tileCount - 1 &&
		   overlap != 0 {
			return overlap
		}

		return Self.tileSize
	}
}
