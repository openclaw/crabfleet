// TODO: Reference Source: https://github.com/MarcusWichelmann/MarcusW.VncClient/blob/master/src/MarcusW.VncClient/Protocol/Implementation/EncodingTypes/Frame/ZrleEncodingType.cs

/* import Foundation

extension VNCProtocol {
    final class ZRLEEncoding: VNCFrameEncoding {
		let encodingType = VNCFrameEncodingType.zrle.rawValue

		static let tileSize: UInt16 = 64

		let zStream: ZlibStream

		// A buffer which fits even the largest tiles
//		var tileBuffer = Data(repeating: 0, count: Int(tileSize * tileSize * 4))

		init(zStream: ZlibStream) {
			self.zStream = zStream
		}
	}
}

extension VNCProtocol.ZRLEEncoding {
	func decodeRectangle(_ rectangle: VNCProtocol.Rectangle,
						 framebuffer: VNCFramebuffer,
						 connection: NetworkConnectionReading,
						 logger: VNCLogger) async throws {
		let compressedData = try await VNCProtocol.ZlibEncoding.retrieveCompressedData(connection: connection,
																					   logger: logger)

		let decompressedData = try zStream.decompressedData(
			compressedData: compressedData,
			maximumOutputSize: VNCProtocolLimits.maximumFramebufferBytes
		)

		let stream = DataStream(data: decompressedData)

		let rectangleWidth = rectangle.width
		let rectangleHeight = rectangle.height

		let rectangleX = rectangle.xPosition
		let rectangleY = rectangle.yPosition

		let tileSize = Self.tileSize

		// Decide on format for cpixels (compressed pixels) while respecting some special cases
		let cPixelFormat = Self.compressedPixelFormat(sourcePixelFormat: framebuffer.sourcePixelFormat)

		// Iterate over all tiles
        // TODO: Get rid of stride()
		for tileY in stride(from: rectangleY, to: rectangleY + rectangleHeight, by: .init(tileSize)) {
			let tileHeight = min(tileSize, rectangleY + rectangleHeight - tileY)

            // TODO: Get rid of stride()
			for tileX in stride(from: rectangleX, to: rectangleX + rectangleWidth, by: .init(tileSize)) {
				let tileWidth = min(tileSize, rectangleX + rectangleWidth - tileX)

				let tile = VNCRegion(x: tileX,
									 y: tileY,
									 width: tileWidth,
									 height: tileHeight)

				try readTile(tile,
							 cPixelFormat: cPixelFormat,
							 stream: stream,
							 framebuffer: framebuffer,
							 logger: logger)
			}
		}

		framebuffer.didUpdate(region: rectangle.region)
	}
}

// MARK: - Pixel Format
private extension VNCProtocol.ZRLEEncoding {
	static func compressedPixelFormat(sourcePixelFormat: VNCProtocol.PixelFormat) -> VNCProtocol.PixelFormat {
		// See https://github.com/TigerVNC/tigervnc/blob/d8bbbeb3b37c713a72a113f7ef78741e15cc4a4d/common/rfb/ZRLEDecoder.cxx#L84

		if sourcePixelFormat.trueColor,
			  sourcePixelFormat.bitsPerPixel == 32,
			  sourcePixelFormat.depth <= 24 {
			// Create a white pixel using the given pixel format
			let maxPixel = (sourcePixelFormat.redMax << sourcePixelFormat.redShift) |
						   (sourcePixelFormat.greenMax << sourcePixelFormat.greenShift) |
						   (sourcePixelFormat.blueMax << sourcePixelFormat.blueShift)

			// Does the white pixel fit in the least/most significant 3 bytes (big-endian view)?
			let fitsInLs3Bytes = maxPixel < 1 << 24
			let fitsInMs3Bytes = (maxPixel & 0xff) == 0

			// Note that we have to differentiate between endianness here, because reversing the bytes also affects,
			// where we have to put the received bytes when reconstructing the pixel value:

			// Should the received bytes be put first in memory, when reconstructing the pixel value? memory(LE): ___0 (0x0___)
			// little-endian received as C,B,A --> memory(LE): CBA0 (0x0ABC)                     == least-significant
			//    big-endian received as A,B,C --> memory(LE): ABC0 (0x0CBA) --> reverse: 0xABC0 ==  most-significant

			if (fitsInLs3Bytes && !sourcePixelFormat.bigEndian) ||
			   (fitsInMs3Bytes && sourcePixelFormat.bigEndian) {
				// The pixel conversion algorithm automatically puts the three bytes first in memory (with 1 trash byte after), but we know,
				// that only the relevant bytes are used because of the correct shifting.
				return .init(bitsPerPixel: 24,
							 depth: sourcePixelFormat.depth,
							 bigEndian: sourcePixelFormat.bigEndian,
							 trueColor: true,
							 redMax: sourcePixelFormat.redMax,
							 greenMax: sourcePixelFormat.greenMax,
							 blueMax: sourcePixelFormat.blueMax,
							 redShift: sourcePixelFormat.redShift,
							 greenShift: sourcePixelFormat.greenShift,
							 blueShift: sourcePixelFormat.blueShift)
			}

			// Should the received bytes be put last in memory, when reconstructing the pixel value? memory(LE): 0___ (0x___0)
			//    big-endian received as A,B,C --> memory(LE): 0ABC (0xCBA0) --> reverse: 0x0ABC == least-significant
			// little-endian received as C,B,A --> memory(LE): 0CBA (0xABC0)                     == most-significant
			if (fitsInLs3Bytes && sourcePixelFormat.bigEndian) || (fitsInMs3Bytes && !sourcePixelFormat.bigEndian) {
				// The pixel conversion algorithm automatically puts the three bytes first in memory (with 1 trash byte after), which is not what we want:
				//    big-endian received as A,B,C --> memory(LE): ABC0 (0x0CBA) --> reverse: 0xABC0  SHOULD BE  0x0ABC == least-significant
				// little-endian received as C,B,A --> memory(LE): CBA0 (0x0ABC)                      SHOULD BE  0xABC0 == most-significant
				// To fix this, we can add/subtract 8 to/from the shift values, to make them read the correct bits again.
				let shiftOffset = fitsInLs3Bytes
					? 8
					: -8

				return .init(bitsPerPixel: 24,
							 depth: sourcePixelFormat.depth,
							 bigEndian: sourcePixelFormat.bigEndian,
							 trueColor: true,
							 redMax: sourcePixelFormat.redMax,
							 greenMax: sourcePixelFormat.greenMax,
							 blueMax: sourcePixelFormat.blueMax,
							 redShift: .init(Int(sourcePixelFormat.redShift) + shiftOffset),
							 greenShift: .init(Int(sourcePixelFormat.greenShift) + shiftOffset),
							 blueShift: .init(Int(sourcePixelFormat.blueShift) + shiftOffset))
			}
		}

		return sourcePixelFormat
	}
}

// MARK: - Decoding
private extension VNCProtocol.ZRLEEncoding {
	func readTile(_ tile: VNCRegion,
				  cPixelFormat: VNCProtocol.PixelFormat,
				  stream: AnyStream,
				  framebuffer: VNCFramebuffer,
				  logger: VNCLogger) throws {
		// Read one byte for the subencoding type
		let subencodingType = try stream.readUInt8()

		// Top bit defines if this tile is run-length encoded, bottom 7 bits define the palette size
		let isRunLengthEncoded = subencodingType & 128 != 0
		let paletteSize = subencodingType & 127

		// Create a cursor for this tile on the target framebuffer, if any framebuffer reference is available
//		FramebufferCursor framebufferCursor = new FramebufferCursor(targetFramebuffer, tile)

		// Read tile based on the subencoding type
		if !isRunLengthEncoded {
			if paletteSize == 0 { // Raw
				try readRawTile(tile,
								cPixelFormat: cPixelFormat,
								stream: stream,
								framebuffer: framebuffer,
								logger: logger)
			} else if paletteSize == 1 { // Solid color
				try readSolidTile(tile,
								  cPixelFormat: cPixelFormat,
								  stream: stream,
								  framebuffer: framebuffer,
								  logger: logger)
			} else if paletteSize >= 2 && paletteSize <= 16 { // Packed palette
				try readPackedPaletteTile(tile,
										  paletteSize: paletteSize,
										  cPixelFormat: cPixelFormat,
										  stream: stream,
										  framebuffer: framebuffer,
										  logger: logger)
			} else {
				throw VNCError.protocol(.zrleUnexpectedPaletteSize(paletteSize: paletteSize))
			}
		} else {
			if paletteSize == 0 { // Plain RLE
				try readRLETile(tile,
								cPixelFormat: cPixelFormat,
								stream: stream,
								framebuffer: framebuffer,
								logger: logger)
			} else if paletteSize >= 2 && paletteSize <= 127 {
				try readPaletteRLETile(tile,
									   paletteSize: paletteSize,
									   cPixelFormat: cPixelFormat,
									   stream: stream,
									   framebuffer: framebuffer,
									   logger: logger)
			} else {
				throw VNCError.protocol(.zrleUnexpectedRLEPaletteSize(paletteSize: paletteSize))
			}
		}
	}

	func readRawTile(_ tile: VNCRegion,
					 cPixelFormat: VNCProtocol.PixelFormat,
					 stream: AnyStream,
					 framebuffer: VNCFramebuffer,
					 logger: VNCLogger) throws {
		// Calculate how many bytes we're going to receive
		let bytesPerPixel = cPixelFormat.bytesPerPixel
		let totalBytesToRead = Int(tile.width) * Int(tile.height) * Int(bytesPerPixel)

		// Read raw data
		var buffer = try stream.read(length: totalBytesToRead)

		// Process all bytes and draw to the framebuffer
		framebuffer.update(region: tile, data: &buffer)
	}

	func readSolidTile(_ tile: VNCRegion,
					   cPixelFormat: VNCProtocol.PixelFormat,
					   stream: AnyStream,
					   framebuffer: VNCFramebuffer,
					   logger: VNCLogger) throws {
		// Read a single color value
		let bytesPerPixel = cPixelFormat.bytesPerPixel
		var buffer = try stream.read(length: .init(bytesPerPixel))

		// Fill the tile with a solid color
		framebuffer.fill(region: tile, withPixel: &buffer)
	}

	func readPackedPaletteTile(_ tile: VNCRegion,
							   paletteSize: UInt8,
							   cPixelFormat: VNCProtocol.PixelFormat,
							   stream: AnyStream,
							   framebuffer: VNCFramebuffer,
							   logger: VNCLogger) throws {
		// Calculate how many bytes we're going to receive
		let bytesPerPixel = cPixelFormat.bytesPerPixel
		let paletteBytes = Int(paletteSize) * Int(bytesPerPixel)

		let bitsPerPackedPixel = paletteSize > 4
			? 4
			: paletteSize > 2
				? 2
				: 1

		let packedPixelBytes: Int

		switch bitsPerPackedPixel {
			case 1:
				packedPixelBytes = (Int(tile.width) + 7) / 8 * Int(tile.height)
			case 2:
				packedPixelBytes = (Int(tile.width) + 3) / 4 * Int(tile.height)
			case 4:
				packedPixelBytes = (Int(tile.width) + 1) / 2 * Int(tile.height)
			default:
				throw VNCError.protocol(.zrleUnexpectedPaletteSize(paletteSize: paletteSize))
		}

		let totalBytesToRead = paletteBytes + packedPixelBytes

		// Read all data. Buffer is always large enough: 16 * 4 + (64 + 1) / 2 * 64 = 2144 < 16384 = 64 * 64 * 4
		let buffer = try stream.read(length: totalBytesToRead)

		let palette = buffer[0..<paletteBytes]
		let packedPixels = buffer[paletteBytes..<paletteBytes + packedPixelBytes]

		let indexMask = UInt8(((1 << bitsPerPackedPixel) - 1) & 127)

		// See: https://github.com/TigerVNC/tigervnc/blob/a356a706526ac4182b3ae144166ae04271b85258/java/com/tigervnc/rfb/ZRLEDecoder.java#L213

		var pixelOffset = 0

		// Process the pixels line by line
		for yPos in 0..<tile.height {
			var pixelsByte: UInt8 = 0
			var remainingBits = 0

			// Write pixels left to right
			for xPos in 0..<tile.width {
				// Read next byte?
				if remainingBits == 0 {
					// TODO: Correct?
					pixelsByte = packedPixels[pixelOffset]
					pixelOffset += 1

					remainingBits = 8
				}

				// Get palette index
				remainingBits -= bitsPerPackedPixel

				let paletteIndex = ((Int(pixelsByte) >> remainingBits) & Int(indexMask)) * Int(bytesPerPixel)

				guard paletteIndex < paletteBytes else {
					throw VNCError.protocol(.zrlePaletteIndexOverflow(paletteIndex: paletteIndex, paletteSize: paletteSize))
				}

				// TODO: Correct?
				var pixelData = palette[paletteIndex..<paletteIndex + Int(bytesPerPixel)]

				// Set the pixel
				// TODO: Correct?
				let pixelRegion = VNCRegion(x: xPos + tile.x, y: yPos + tile.y,
											width: 1, height: 1)

				framebuffer.fill(region: pixelRegion, withPixel: &pixelData)
			}
		}
	}

	func readRLETile(_ tile: VNCRegion,
					 cPixelFormat: VNCProtocol.PixelFormat,
					 stream: AnyStream,
					 framebuffer: VNCFramebuffer,
					 logger: VNCLogger) throws {
//		let bytesPerPixel = cPixelFormat.bytesPerPixel
//
//		// We need to read on demand, because we cannot tell the number of bytes to read in advance
////		Span<byte> runLengthReadBuffer = stackalloc byte[1];
//
//		// TODO: That whole thing is wonky
//
//		let tileSize = Int(tile.width) * Int(tile.height)
//		var idx = 0
//
//		while idx < tileSize {
//			// Read pixel data
//			let pixelData = try stream.read(length: 3)
//			let length = try readRLELength(stream: stream)
//
//			for _ in 0..<length {
//				let sourceStartIdx = idx * 4
//
//				guard let target = tileBufferPtr.baseAddress?.advanced(by: sourceStartIdx).assumingMemoryBound(to: UInt8.self) else {
//					throw VNCError.protocol(.invalidData)
//				}
//
//				pixel.copyBytes(to: target,
//								count: 4)
//
//				idx += 1
//			}
//		}
	}

	func readPaletteRLETile(_ tile: VNCRegion,
							paletteSize: UInt8,
							cPixelFormat: VNCProtocol.PixelFormat,
							stream: AnyStream,
							framebuffer: VNCFramebuffer,
							logger: VNCLogger) throws {
		// TODO
	}

	func readRLELength(stream: AnyStream) throws -> Int {
		var length = 0
		var current = 0

		repeat {
			current = .init(try stream.readUInt8())
			length += current
		} while (current == 255)

		return length + 1
	}
} */
