#if canImport(FoundationEssentials)
import FoundationEssentials
#else
import Foundation
#endif

#if canImport(CoreGraphics) && canImport(ImageIO)
import CoreGraphics
import ImageIO

#if canImport(UniformTypeIdentifiers)
import UniformTypeIdentifiers
#endif

#endif

#if canImport(stb_image)
import stb_image
#endif

extension VNCProtocol {
	final class TightEncoding: VNCFrameEncoding {
#if canImport(CoreGraphics) && canImport(ImageIO)
        private static let rgbColorSpace = CGColorSpaceCreateDeviceRGB()
        private static let bitmapInfo = CGBitmapInfo.byteOrder32Big.union(.init(rawValue: CGImageAlphaInfo.noneSkipLast.rawValue))
        private static let directBitmapInfo = CGBitmapInfo.byteOrder32Little.union(.init(rawValue: CGImageAlphaInfo.noneSkipFirst.rawValue))

        private static let imageCreateOptions: CFDictionary = [
            kCGImageSourceShouldCache: kCFBooleanFalse as Any,
            kCGImageSourceShouldCacheImmediately: kCFBooleanFalse as Any,
            kCGImageSourceShouldAllowFloat: kCFBooleanFalse as Any
        ] as CFDictionary

        private static let jpegImageSourceCreateOptions: CFDictionary = [
            kCGImageSourceTypeIdentifierHint: jpegTypeIdentifierHint
        ] as CFDictionary

        private static let pngImageSourceCreateOptions: CFDictionary = [
            kCGImageSourceTypeIdentifierHint: pngTypeIdentifierHint
        ] as CFDictionary

        private static var jpegTypeIdentifierHint: CFString {
#if canImport(UniformTypeIdentifiers)
            UTType.jpeg.identifier as CFString
#else
            "public.jpeg" as CFString
#endif
        }

        private static var pngTypeIdentifierHint: CFString {
#if canImport(UniformTypeIdentifiers)
            UTType.png.identifier as CFString
#else
            "public.png" as CFString
#endif
        }
#endif

        let encodingType = VNCFrameEncodingType.tight.rawValue

        private var zStreams: [ZlibStream]

		init() {
			self.zStreams = [
				ZlibStream(),
				ZlibStream(),
				ZlibStream(),
				ZlibStream()
			]
		}

		static func supportsPixelFormat(_ pixelFormat: VNCProtocol.PixelFormat) -> Bool {
			pixelFormat.trueColor &&
			pixelFormat.bitsPerPixel == 32 &&
			pixelFormat.depth == 24 &&
			pixelFormat.redMax == 255 &&
			pixelFormat.greenMax == 255 &&
			pixelFormat.blueMax == 255
		}
	}
}

extension VNCProtocol.TightEncoding {
    func decodeRectangle(_ rectangle: VNCProtocol.Rectangle,
                         framebuffer: VNCFramebuffer,
                         connection: NetworkConnectionReading,
                         logger: VNCLogger) async throws {
//        logger.logDebug("Beginning to read Tight Encoding")

		let width = Int(rectangle.width)
		let height = Int(rectangle.height)

		guard width > 0,
			  height > 0 else {
			logger.logDebug("Nothing to Tight decode, skipping")
			return
		}

		let pixelFormat = framebuffer.sourcePixelFormat

		guard pixelFormat.trueColor else {
			throw VNCError.protocol(.notImplemented(feature: "Tight encoding for non-true-color pixel formats"))
		}

		let bytesPerPixel = framebuffer.sourceProperties.bytesPerPixel
		let tPixelSize = Self.tightPixelSize(pixelFormat: pixelFormat)

//        logger.logDebug("Reading Tight Encoding compression-control byte")

		let control = try await connection.readUInt8()

		resetZStreamsIfNeeded(control: control,
                              logger: logger)

		let subencoding = control & 0xF0

//        logger.logDebug("Read Tight Sub-Encoding: \(subencoding)")

		if subencoding == TightSubencoding.png.rawValue {
			throw VNCError.protocol(.notImplemented(feature: "Tight PNG subencoding"))
		}

		if (control & 0x80) != 0,
		   subencoding != TightSubencoding.fill.rawValue,
		   subencoding != TightSubencoding.jpeg.rawValue {
			throw VNCError.protocol(.notImplemented(feature: "Tight subencoding \(subencoding)"))
		}

		if subencoding == TightSubencoding.fill.rawValue {
//            logger.logDebug("Reading Tight Fill Sub-Encoding pixel data of size \(tPixelSize)")

			var pixelData = try await connection.read(length: tPixelSize)

			if tPixelSize != bytesPerPixel {
//                logger.logDebug("Converting Tight TPixel Data")

                pixelData = try Self.convertTPixelData(
                    pixelData,
                    pixelFormat: pixelFormat,
                    bytesPerPixel: bytesPerPixel,
                    tPixelSize: tPixelSize
                )
			}

			framebuffer.fill(region: rectangle.region,
							 withPixel: &pixelData)

			framebuffer.didUpdate(region: rectangle.region)

			return
		}

		if subencoding == TightSubencoding.jpeg.rawValue {
			guard Self.supportsPixelFormat(pixelFormat) else {
				throw VNCError.protocol(.notImplemented(feature: "Tight JPEG decoding for current pixel format"))
			}

//            logger.logDebug("Reading Tight JPEG Sub-Encoding length")

			let jpegLength = try await readCompactLength(connection: connection,
                                                         logger: logger)

//            logger.logDebug("Reading Tight JPEG Sub-Encoding data (JPEG Length: \(jpegLength))")

            let jpegData = try await readBuffered(connection: connection,
                                                  length: jpegLength,
                                                  logger: logger)

//            logger.logDebug("Decoding Tight JPEG Sub-Encoding image data")

            var decoded = try Self.decodeImageData(
                jpegData,
                imageType: .jpeg,
                width: width,
                height: height,
                pixelFormat: pixelFormat,
                bytesPerPixel: bytesPerPixel
            )

            framebuffer.update(region: rectangle.region,
                               data: &decoded)

			framebuffer.didUpdate(region: rectangle.region)

			return
		}

		let streamID = Int((control >> 4) & 0x03)
		let explicitFilter = (control & 0x40) != 0

        let filterID: UInt8

        if explicitFilter {
//            logger.logDebug("Reading explicit Tight Filter ID")
            filterID = try await connection.readUInt8()
        } else {
            filterID = TightFilter.copy.rawValue
        }

		switch filterID {
			case TightFilter.copy.rawValue:
				let expectedSize = width * height * tPixelSize

//                logger.logDebug("Reading Tight Copy Data of size \(expectedSize)")

                var rawData = try await readTightData(
                    connection: connection,
                    expectedSize: expectedSize,
                    streamID: streamID,
                    control: control,
                    logger: logger
                )

				if tPixelSize != bytesPerPixel {
//                    logger.logDebug("Converting Tight TPixel Data of size \(tPixelSize)")

                    rawData = try Self.convertTPixelData(
                        rawData,
                        pixelFormat: pixelFormat,
                        bytesPerPixel: bytesPerPixel,
                        tPixelSize: tPixelSize
                    )
				}

                framebuffer.update(region: rectangle.region,
                                   data: &rawData)

			case TightFilter.palette.rawValue:
//                logger.logDebug("Reading Tight Palette size")

				let paletteSize = Int(try await connection.readUInt8()) + 1
				let paletteBytes = paletteSize * tPixelSize

//                logger.logDebug("Reading Tight Raw Palette Data of size \(paletteBytes)")

				let rawPaletteData = try await connection.read(length: paletteBytes)

//                logger.logDebug("Converting Tight Palette Data")

                let paletteData = try Self.convertPaletteData(
                    rawPaletteData,
                    pixelFormat: pixelFormat,
                    bytesPerPixel: bytesPerPixel,
                    tPixelSize: tPixelSize
                )

				let indexDataSize: Int

				if paletteSize == 2 {
					let bytesPerRow = (width + 7) / 8
					indexDataSize = bytesPerRow * height
				} else {
					indexDataSize = width * height
				}

//                logger.logDebug("Reading Tight Palette Data")

                let indices = try await readTightData(
                    connection: connection,
                    expectedSize: indexDataSize,
                    streamID: streamID,
                    control: control,
                    logger: logger
                )

//                logger.logDebug("Expanding Tight Palette")

                var decoded = try Self.expandPalette(
                    indices: indices,
                    palette: paletteData,
                    paletteSize: paletteSize,
                    width: width,
                    height: height,
                    bytesPerPixel: bytesPerPixel
                )

                framebuffer.update(region: rectangle.region,
                                   data: &decoded)

			case TightFilter.gradient.rawValue:
				guard tPixelSize == 3 else {
					throw VNCError.protocol(.notImplemented(feature: "Tight Gradient Filter for current pixel format"))
				}

                let expectedSize = width * height * tPixelSize

//                logger.logDebug("Reading Tight Gradient data of size \(expectedSize)")

                let filteredData = try await readTightData(
                    connection: connection,
                    expectedSize: expectedSize,
                    streamID: streamID,
                    control: control,
                    logger: logger
                )

//                logger.logDebug("Decoding Tight Gradient data")

                var decoded = try Self.decodeGradient(
                    filteredData,
                    width: width,
                    height: height,
                    pixelFormat: pixelFormat,
                    bytesPerPixel: bytesPerPixel
                )

                framebuffer.update(region: rectangle.region,
                                   data: &decoded)

			default:
				throw VNCError.protocol(.notImplemented(feature: "Tight Filter ID \(filterID)"))
		}

		framebuffer.didUpdate(region: rectangle.region)
	}
}

private extension VNCProtocol.TightEncoding {
    enum TightImageType {
        case jpeg
        case png
    }

	enum TightSubencoding: UInt8 {
		case fill = 0x80
		case jpeg = 0x90
		case png = 0xA0
	}

	enum TightFilter: UInt8 {
		case copy = 0
		case palette = 1
		case gradient = 2
	}

	func resetZStreamsIfNeeded(control: UInt8,
                               logger: VNCLogger) {
		for idx in 0..<4 {
			let mask = UInt8(1 << idx)

			if (control & mask) != 0 {
                logger.logDebug("Resetting Tight Encoding zStream at index \(idx)")

				do {
					try zStreams[idx].reset()
				} catch {
					zStreams[idx] = ZlibStream()
				}
			}
		}
	}
}

extension VNCProtocol.TightEncoding {
	func readCompactLength(connection: NetworkConnectionReading,
                           logger: VNCLogger) async throws -> Int {
		let first = try await connection.readUInt8()
		var length = Int(first & 0x7F)
		guard (first & 0x80) != 0 else {
			return length
		}

		let second = try await connection.readUInt8()
		length |= Int(second & 0x7F) << 7
		guard (second & 0x80) != 0 else {
			return length
		}

		let third = try await connection.readUInt8()
		length |= Int(third) << 14
		return length
	}
}

private extension VNCProtocol.TightEncoding {
	func readBuffered(connection: NetworkConnectionReading,
					  length: Int,
                      logger: VNCLogger) async throws -> Data {
		guard length > 0 else {
			return .init()
		}

		let chunkSize = 1024 * 16

//        logger.logDebug("Reading Tight Buffered Data (Length: \(length), Chunk Size: \(chunkSize))")

        let data = try await connection.readBuffered(
            length: length,
            minimumChunkSize: 1,
            maximumChunkSize: chunkSize
        )

		guard data.count == length else {
			throw VNCError.protocol(.invalidData)
		}

		return data
	}

    func readTightData(
        connection: NetworkConnectionReading,
        expectedSize: Int,
        streamID: Int,
        control: UInt8,
        logger: VNCLogger
    ) async throws -> Data {
		guard expectedSize > 0 else {
			return .init()
		}

		if expectedSize < 12 {
            let data = try await readBuffered(
                connection: connection,
                length: expectedSize,
                logger: logger
            )

			return data
		}

		let compressedLength = try await readCompactLength(connection: connection,
                                                           logger: logger)

		guard compressedLength > 0 else {
//			logger.logDebug("Tight: Compressed length is 0 (control=0x\(String(format: "%02X", control)), expectedSize=\(expectedSize))")

			throw VNCError.protocol(.invalidData)
		}

        let compressedData = try await readBuffered(
            connection: connection,
            length: compressedLength,
            logger: logger
        )

		do {
            return try zStreams[streamID].decompressedData(
                compressedData: compressedData,
                uncompressedSize: .init(expectedSize)
            )
		} catch {
			throw VNCError.protocol(.frameDecode(encodingType: encodingType, underlyingError: error))
		}
	}

	static func tightPixelSize(pixelFormat: VNCProtocol.PixelFormat) -> Int {
        if pixelFormat.trueColor,
           pixelFormat.bitsPerPixel == 32,
           pixelFormat.depth == 24,
           pixelFormat.redMax == 255,
           pixelFormat.greenMax == 255,
           pixelFormat.blueMax == 255 {
            return 3
        }

		return Int(pixelFormat.bitsPerPixel / 8)
	}

    static func convertPaletteData(
        _ paletteData: Data,
        pixelFormat: VNCProtocol.PixelFormat,
        bytesPerPixel: Int,
        tPixelSize: Int
    ) throws -> Data {
		guard tPixelSize != bytesPerPixel else {
			return paletteData
		}

        return try convertTPixelData(
            paletteData,
            pixelFormat: pixelFormat,
            bytesPerPixel: bytesPerPixel,
            tPixelSize: tPixelSize
        )
	}

    static func convertTPixelData(
        _ data: Data,
        pixelFormat: VNCProtocol.PixelFormat,
        bytesPerPixel: Int,
        tPixelSize: Int
    ) throws -> Data {
		guard tPixelSize == 3 else {
			throw VNCError.protocol(.notImplemented(feature: "Tight TPIXEL size \(tPixelSize) conversion"))
		}

		guard data.count % tPixelSize == 0 else {
			throw VNCError.protocol(.invalidData)
		}

		let pixelCount = data.count / tPixelSize
		let bitsPerPixel = Int(pixelFormat.bitsPerPixel)

		var converted = Data(count: pixelCount * bytesPerPixel)

		converted.withUnsafeMutableBytes { convertedPtr in
			var inputIndex = 0

			for pixelIndex in 0..<pixelCount {
				let red = data[inputIndex]
				let green = data[inputIndex + 1]
				let blue = data[inputIndex + 2]

                let pixelValue = packPixelValue(
                    red: red,
                    green: green,
                    blue: blue,
                    pixelFormat: pixelFormat
                )

				let offset = pixelIndex * bytesPerPixel

                storePixelValue(
                    pixelValue,
                    bitsPerPixel: bitsPerPixel,
                    targetPtr: convertedPtr.baseAddress,
                    offset: offset
                )

				inputIndex += tPixelSize
			}
		}

		return converted
	}

    static func expandPalette(
        indices: Data,
        palette: Data,
        paletteSize: Int,
        width: Int,
        height: Int,
        bytesPerPixel: Int
    ) throws -> Data {
		let pixelCount = width * height
		var output = Data(count: pixelCount * bytesPerPixel)
		var invalidIndex = false

		output.withUnsafeMutableBytes { outputPtr in
			guard let outputBase = outputPtr.baseAddress else {
				return
			}

			if paletteSize == 2 {
				let bytesPerRow = (width + 7) / 8

				for row in 0..<height {
					let rowStart = row * bytesPerRow

					for column in 0..<width {
						let byte = indices[rowStart + (column >> 3)]
						let bit = 7 - (column & 7)
						let paletteIndex = Int((byte >> bit) & 0x01)

						let sourceOffset = paletteIndex * bytesPerPixel
						let destinationOffset = (row * width + column) * bytesPerPixel

						let target = outputBase.advanced(by: destinationOffset)
                            .assumingMemoryBound(to: UInt8.self)

                        palette.copyBytes(to: target,
                                          from: sourceOffset..<sourceOffset + bytesPerPixel)
					}
				}
			} else {
				for idx in 0..<pixelCount {
					let paletteIndex = Int(indices[idx])

					guard paletteIndex < paletteSize else {
						invalidIndex = true
						return
					}

					let sourceOffset = paletteIndex * bytesPerPixel
					let destinationOffset = idx * bytesPerPixel

					let target = outputBase.advanced(by: destinationOffset)
                        .assumingMemoryBound(to: UInt8.self)

                    palette.copyBytes(to: target,
                                      from: sourceOffset..<sourceOffset + bytesPerPixel)
				}
			}
		}

		if invalidIndex {
			throw VNCError.protocol(.invalidData)
		}

		return output
	}

    static func decodeGradient(
        _ data: Data,
        width: Int,
        height: Int,
        pixelFormat: VNCProtocol.PixelFormat,
        bytesPerPixel: Int
    ) throws -> Data {
		guard data.count == width * height * 3 else {
			throw VNCError.protocol(.invalidData)
		}

		let pixelCount = width * height
		var output = Data(count: pixelCount * bytesPerPixel)

		var previousR = [Int](repeating: 0, count: width)
		var previousG = [Int](repeating: 0, count: width)
		var previousB = [Int](repeating: 0, count: width)

		var currentR = [Int](repeating: 0, count: width)
		var currentG = [Int](repeating: 0, count: width)
		var currentB = [Int](repeating: 0, count: width)

		let bitsPerPixel = Int(pixelFormat.bitsPerPixel)
		let maxValue = 255

		output.withUnsafeMutableBytes { outputPtr in
			guard let outputBase = outputPtr.baseAddress else {
				return
			}

			var dataIndex = 0

			for row in 0..<height {
				var leftR = 0
				var leftG = 0
				var leftB = 0

				for column in 0..<width {
					let diffR = Int(data[dataIndex])
					let diffG = Int(data[dataIndex + 1])
					let diffB = Int(data[dataIndex + 2])

					dataIndex += 3

					let upR = previousR[column]
					let upG = previousG[column]
					let upB = previousB[column]

					let upLeftR = column > 0 ? previousR[column - 1] : 0
					let upLeftG = column > 0 ? previousG[column - 1] : 0
					let upLeftB = column > 0 ? previousB[column - 1] : 0

					let predR = max(0, min(maxValue, leftR + upR - upLeftR))
					let predG = max(0, min(maxValue, leftG + upG - upLeftG))
					let predB = max(0, min(maxValue, leftB + upB - upLeftB))

					let valueR = (diffR + predR) & 0xFF
					let valueG = (diffG + predG) & 0xFF
					let valueB = (diffB + predB) & 0xFF

					currentR[column] = valueR
					currentG[column] = valueG
					currentB[column] = valueB

					leftR = valueR
					leftG = valueG
					leftB = valueB

					let offset = (row * width + column) * bytesPerPixel

                    let pixelValue = packPixelValue(
                        red: UInt8(valueR),
                        green: UInt8(valueG),
                        blue: UInt8(valueB),
                        pixelFormat: pixelFormat
                    )

                    storePixelValue(
                        pixelValue,
                        bitsPerPixel: bitsPerPixel,
                        targetPtr: outputBase,
                        offset: offset
                    )
				}

				swap(&previousR, &currentR)
				swap(&previousG, &currentG)
				swap(&previousB, &currentB)

				for idx in 0..<width {
					currentR[idx] = 0
					currentG[idx] = 0
					currentB[idx] = 0
				}
			}
		}

		return output
	}

    static func packPixelValue(
        red: UInt8,
        green: UInt8,
        blue: UInt8,
        pixelFormat: VNCProtocol.PixelFormat
    ) -> Int {
		let redScaled = scaleComponent(red, maxValue: Int(pixelFormat.redMax))
		let greenScaled = scaleComponent(green, maxValue: Int(pixelFormat.greenMax))
		let blueScaled = scaleComponent(blue, maxValue: Int(pixelFormat.blueMax))

		let redShift = Int(pixelFormat.redShift)
		let greenShift = Int(pixelFormat.greenShift)
		let blueShift = Int(pixelFormat.blueShift)

		let pixelValue = (redScaled << redShift) |
                         (greenScaled << greenShift) |
                         (blueScaled << blueShift)

		return pixelValue
	}

	static func scaleComponent(_ value: UInt8,
							   maxValue: Int) -> Int {
		guard maxValue != 255 else {
			return Int(value)
		}

		return (Int(value) * maxValue + 127) / 255
	}

    static func storePixelValue(
        _ value: Int,
        bitsPerPixel: Int,
        targetPtr: UnsafeMutableRawPointer?,
        offset: Int
    ) {
		guard let targetPtr else {
			return
		}

		switch bitsPerPixel {
			case 32:
                targetPtr.storeBytes(of: UInt32(value),
                                     toByteOffset: offset,
                                     as: UInt32.self)
			case 16:
                targetPtr.storeBytes(of: UInt16(value),
                                     toByteOffset: offset,
                                     as: UInt16.self)
            case 8:
                targetPtr.storeBytes(of: UInt8(value),
                                     toByteOffset: offset,
                                     as: UInt8.self)
            default:
				break
		}
	}
}

private extension VNCProtocol.TightEncoding {
    static func decodeImageData(
        _ data: Data,
        imageType: TightImageType,
        width: Int,
        height: Int,
        pixelFormat: VNCProtocol.PixelFormat,
        bytesPerPixel: Int
    ) throws -> Data {
#if canImport(ImageIO) && canImport(CoreGraphics)
        let cfData = data as CFData

        let imageSourceCreateOptions: CFDictionary

        switch imageType {
            case .jpeg:
                imageSourceCreateOptions = jpegImageSourceCreateOptions
            case .png:
                imageSourceCreateOptions = pngImageSourceCreateOptions
        }

        guard let imageSource = CGImageSourceCreateWithData(cfData, imageSourceCreateOptions),
              let image = CGImageSourceCreateImageAtIndex(imageSource, 0, Self.imageCreateOptions) else {
            throw VNCError.protocol(.invalidData)
        }

        guard image.width == width,
              image.height == height else {
            throw VNCError.protocol(.invalidData)
        }

        let canUseDirectOutput = bytesPerPixel == 4 &&
            !pixelFormat.bigEndian &&
            pixelFormat.bitsPerPixel == 32 &&
            pixelFormat.depth == 24 &&
            pixelFormat.redMax == 255 &&
            pixelFormat.greenMax == 255 &&
            pixelFormat.blueMax == 255 &&
            pixelFormat.redShift == 16 &&
            pixelFormat.greenShift == 8 &&
            pixelFormat.blueShift == 0

        if canUseDirectOutput {
            let bytesPerRow = width * bytesPerPixel
            var output = Data(count: bytesPerRow * height)

            let drawResult = output.withUnsafeMutableBytes { ptr -> Bool in
                guard let baseAddress = ptr.baseAddress else {
                    return false
                }

                guard let context = CGContext(
                    data: baseAddress,
                    width: width,
                    height: height,
                    bitsPerComponent: 8,
                    bytesPerRow: bytesPerRow,
                    space: Self.rgbColorSpace,
                    bitmapInfo: Self.directBitmapInfo.rawValue
                ) else {
                    return false
                }

                context.draw(image,
                             in: CGRect(x: 0, y: 0, width: width, height: height))

                return true
            }

            guard drawResult else {
                throw VNCError.protocol(.invalidData)
            }

            return output
        }

        let bytesPerRow = width * 4
        var rgbaData = Data(count: bytesPerRow * height)

        let drawResult = rgbaData.withUnsafeMutableBytes { ptr -> Bool in
            guard let baseAddress = ptr.baseAddress else {
                return false
            }

            guard let context = CGContext(
                data: baseAddress,
                width: width,
                height: height,
                bitsPerComponent: 8,
                bytesPerRow: bytesPerRow,
                space: Self.rgbColorSpace,
                bitmapInfo: Self.bitmapInfo.rawValue
            ) else {
                return false
            }

            context.draw(image,
                         in: CGRect(x: 0, y: 0, width: width, height: height))

            return true
        }

        guard drawResult else {
            throw VNCError.protocol(.invalidData)
        }

        let pixelCount = width * height
        let bitsPerPixel = Int(pixelFormat.bitsPerPixel)
        var output = Data(count: pixelCount * bytesPerPixel)

        output.withUnsafeMutableBytes { outputPtr in
            guard let outputBase = outputPtr.baseAddress else {
                return
            }

            var inputIndex = 0

            for idx in 0..<pixelCount {
                let red = rgbaData[inputIndex]
                let green = rgbaData[inputIndex + 1]
                let blue = rgbaData[inputIndex + 2]

                let pixelValue = packPixelValue(
                    red: red,
                    green: green,
                    blue: blue,
                    pixelFormat: pixelFormat
                )

                let offset = idx * bytesPerPixel

                storePixelValue(
                    pixelValue,
                    bitsPerPixel: bitsPerPixel,
                    targetPtr: outputBase,
                    offset: offset
                )

                inputIndex += 4
            }
        }

        return output
#else
        switch imageType {
        case .jpeg:
#if canImport(stb_image)
            guard data.count <= Int(Int32.max) else {
                throw VNCError.protocol(.invalidData)
            }

            let compressedSize = Int32(data.count)
            let desiredChannels = Int32(3)

            var decodedWidth = Int32(0)
            var decodedHeight = Int32(0)

            let decodedPixels: UnsafeMutablePointer<UInt8>? = data.withUnsafeBytes { rawBuffer in
                guard let source = rawBuffer.bindMemory(to: UInt8.self).baseAddress else {
                    return nil
                }

                return stbi_load_from_memory(
                    source,
                    compressedSize,
                    &decodedWidth,
                    &decodedHeight,
                    nil,
                    desiredChannels
                )
            }

            guard let decodedPixels else {
                throw VNCError.protocol(.invalidData)
            }

            defer {
                stbi_image_free(decodedPixels)
            }

            guard Int(decodedWidth) == width,
                  Int(decodedHeight) == height else {
                throw VNCError.protocol(.invalidData)
            }

            let pixelCount = width * height

            guard pixelCount <= Int.max / Int(desiredChannels) else {
                throw VNCError.protocol(.invalidData)
            }

            let decodedByteCount = pixelCount * Int(desiredChannels)
            let rgbData = Data(bytes: decodedPixels,
                               count: decodedByteCount)

            return try convertTPixelData(
                rgbData,
                pixelFormat: pixelFormat,
                bytesPerPixel: bytesPerPixel,
                tPixelSize: Int(desiredChannels)
            )
#else
            throw VNCError.protocol(.notImplemented(feature: "Tight JPEG decoding requires stb_image on non-Apple platforms"))
#endif

        case .png:
            throw VNCError.protocol(.notImplemented(feature: "Tight PNG decoding is not implemented on non-Apple platforms"))
        }
#endif
    }
}
