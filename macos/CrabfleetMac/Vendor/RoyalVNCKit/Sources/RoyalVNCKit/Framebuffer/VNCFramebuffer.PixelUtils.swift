#if canImport(FoundationEssentials)
import FoundationEssentials
#else
import Foundation
#endif

extension VNCFramebuffer {
	enum ColorChannel {
		case red
		case green
		case blue
	}

	struct LocalPixel {
		let red: UInt8
		let green: UInt8
		let blue: UInt8
	}

	struct PixelUtils { }
}

// MARK: - Offset Utils
extension VNCFramebuffer.PixelUtils {
	static func offsetOf(row: Int,
						 width: Int,
						 bytesPerPixel: Int) -> Int {
		bytesPerPixel * row * width
	}

	static func offsetOf(column: Int,
						 bytesPerPixel: Int) -> Int {
		bytesPerPixel * column
	}

	static func offsetOf(point: VNCPoint,
						 bytesPerRow: Int,
						 bitsPerPixel: Int) -> Int {
		let xPos = Int(point.x)
		let yPos = Int(point.y)

		let offset = bytesPerRow * yPos + (bitsPerPixel / 8) * xPos

		return offset
	}
}

// MARK: - Pixel Data Utils
extension VNCFramebuffer.PixelUtils {
	static func destinationPixelWith(sourcePixelData: UnsafeRawBufferPointer,
									 sourcePixelDataOffset: Int,
									 sourceProperties: VNCFramebuffer.Properties,
									 destinationProperties: VNCFramebuffer.Properties,
									 colorMap: VNCFramebuffer.ColorMap?) -> VNCFramebuffer.LocalPixel {
		let sourcePixelValue = pixelValue(sourcePixelData,
										  pixelDataOffset: sourcePixelDataOffset,
										  bitsPerPixel: sourceProperties.bitsPerPixel)

		let destinationRed = channelValue(sourceColor: sourcePixelValue,
										  colorChannel: .red,
										  colorMap: colorMap,
										  sourceProperties: sourceProperties,
										  destinationProperties: destinationProperties)

		let destinationGreen = channelValue(sourceColor: sourcePixelValue,
											colorChannel: .green,
											colorMap: colorMap,
											sourceProperties: sourceProperties,
											destinationProperties: destinationProperties)

		let destinationBlue = channelValue(sourceColor: sourcePixelValue,
										   colorChannel: .blue,
										   colorMap: colorMap,
										   sourceProperties: sourceProperties,
										   destinationProperties: destinationProperties)

		return .init(red: destinationRed,
					 green: destinationGreen,
					 blue: destinationBlue)
	}

	private static func pixelValue(_ pixelData: UnsafeRawBufferPointer,
								   pixelDataOffset: Int,
								   bitsPerPixel: Int) -> Int {
		switch bitsPerPixel {
			case 32:
				.init(pixelData.load(fromByteOffset: pixelDataOffset, as: UInt32.self))
			case 16:
				.init(pixelData.load(fromByteOffset: pixelDataOffset, as: UInt16.self))
			case 8:
				.init(pixelData.load(fromByteOffset: pixelDataOffset, as: UInt8.self))
			default:
				fatalError("Unsupported bits per pixel: \(bitsPerPixel)")
		}
	}
}

// MARK: - Color Utils
private extension VNCFramebuffer.PixelUtils {
	static func channelValue(sourceColor: Int,
							 colorChannel: VNCFramebuffer.ColorChannel,
							 colorMap: VNCFramebuffer.ColorMap?,
							 sourceProperties: VNCFramebuffer.Properties,
							 destinationProperties: VNCFramebuffer.Properties) -> UInt8 {
		if sourceProperties.usesColorMap,
		   let colorMap = colorMap,
		   let colorMapChannelValue = channelValueOfColorMap(colorMap,
															 at: sourceColor,
															 colorChannel: colorChannel) {
			return colorMapChannelValue
		}

		let sourceDepth = sourceProperties.colorDepth
		let sourceMax: Int
		let sourceShift: Int

		let destinationDepth = destinationProperties.colorDepth
		let destinationMax: Int
		let destinationShift: Int

		switch colorChannel {
			case .red:
				sourceMax = sourceProperties.redMax
				sourceShift = sourceProperties.redShift

				destinationMax = destinationProperties.redMax
				destinationShift = destinationProperties.redShift
			case .green:
				sourceMax = sourceProperties.greenMax
				sourceShift = sourceProperties.greenShift

				destinationMax = destinationProperties.greenMax
				destinationShift = destinationProperties.greenShift
			case .blue:
				sourceMax = sourceProperties.blueMax
				sourceShift = sourceProperties.blueShift

				destinationMax = destinationProperties.blueMax
				destinationShift = destinationProperties.blueShift
		}

		let value = channelValue(sourceColor: sourceColor,
								 sourceDepth: sourceDepth,
								 sourceMax: sourceMax,
								 sourceShift: sourceShift,
								 destinationDepth: destinationDepth,
								 destinationMax: destinationMax,
								 destinationShift: destinationShift)

		return value
	}

	static func channelValue(sourceColor: Int,
							 sourceDepth: Int,
							 sourceMax: Int,
							 sourceShift: Int,
							 destinationDepth: Int,
							 destinationMax: Int,
							 destinationShift: Int) -> UInt8 {
		// Retrieve channel value from the source
		var value = (sourceColor >> sourceShift) & sourceMax

		if sourceMax != destinationMax { // Color range conversion needed?
			// Calculate channel depth
			let sourceChannelDepth = sourceDepth / 3
			let destinationChannelDepth = destinationDepth / 3

			if sourceChannelDepth > destinationChannelDepth { // Reduction: Shift the value right so only the most significant bits remain
				value >>= sourceChannelDepth - destinationChannelDepth
			} else { // Extension: Shift the value left so the remaining bits get the most significance
				value <<= destinationChannelDepth - sourceChannelDepth
			}
		}

		return .init(value)
	}
}

// MARK: - Color Map Extensions
private extension VNCFramebuffer.PixelUtils {
	static func channelValueOfColorMap(_ colorMap: VNCFramebuffer.ColorMap,
									   at index: Int,
									   colorChannel: VNCFramebuffer.ColorChannel) -> UInt8? {
		guard let color = colorMap.colorAt(index) else {
			return nil
		}

		switch colorChannel {
			case .red:
				return color.red
			case .green:
				return color.green
			case .blue:
				return color.blue
		}
	}
}
