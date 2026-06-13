#if canImport(FoundationEssentials)
import FoundationEssentials
#else
import Foundation
#endif

extension VNCProtocol {
	struct PixelFormat {
		let bitsPerPixel: UInt8
		let depth: UInt8

		let bigEndian: Bool

		// When false, means that a color map is to be used
		let trueColor: Bool

		let redMax: UInt16
		let greenMax: UInt16
		let blueMax: UInt16

		let redShift: UInt8
		let greenShift: UInt8
		let blueShift: UInt8

		init(bitsPerPixel: UInt8,
			 depth: UInt8,
			 bigEndian: Bool,
			 trueColor: Bool,
			 redMax: UInt16,
			 greenMax: UInt16,
			 blueMax: UInt16,
			 redShift: UInt8,
			 greenShift: UInt8,
			 blueShift: UInt8) {
			self.bitsPerPixel = bitsPerPixel
			self.depth = depth

			self.bigEndian = bigEndian

			self.trueColor = trueColor

			self.redMax = redMax
			self.greenMax = greenMax
			self.blueMax = blueMax

			self.redShift = redShift
			self.greenShift = greenShift
			self.blueShift = blueShift
		}

		init(depth: UInt8,
			 trueColor: Bool) {
			let bpp: UInt8

			if depth > 16 {
				bpp = 32
			} else if depth > 8 {
				bpp = 16
			} else {
				bpp = 8
			}

            let bits = UInt8((Double(depth) / 3.0).rounded(.down))
			let colorMax = UInt16((1 << bits) - 1)

			self.init(bitsPerPixel: bpp,
					  depth: depth,
					  bigEndian: false,
					  trueColor: trueColor,
					  redMax: colorMax,
					  greenMax: colorMax,
					  blueMax: colorMax,
					  redShift: bits * 2,
					  greenShift: bits * 1,
					  blueShift: bits * 0)
		}

		init(depth: UInt8) {
			let trueColor = depth > 8

			self.init(depth: depth,
					  trueColor: trueColor)
		}
	}
}

extension VNCProtocol.PixelFormat {
	static func receive(connection: NetworkConnectionReading) async throws -> Self {
		let bitsPerPixel = try await connection.readUInt8()
		let depth = try await connection.readUInt8()

		let bigEndian = try await connection.readBool()
		let trueColor = try await connection.readBool()

		let redMax = try await connection.readUInt16()
		let greenMax = try await connection.readUInt16()
		let blueMax = try await connection.readUInt16()

		let redShift = try await connection.readUInt8()
		let greenShift = try await connection.readUInt8()
		let blueShift = try await connection.readUInt8()

		try await connection.readPadding(length: 3)

		return .init(bitsPerPixel: bitsPerPixel,
					 depth: depth,
					 bigEndian: bigEndian,
					 trueColor: trueColor,
					 redMax: redMax,
					 greenMax: greenMax,
					 blueMax: blueMax,
					 redShift: redShift,
					 greenShift: greenShift,
					 blueShift: blueShift)
	}

	var data: Data {
		let length = 16

		var data = Data(capacity: length)

		data.append(bitsPerPixel)
		data.append(depth)

		data.append(bigEndian)
		data.append(trueColor)

		data.append(redMax, bigEndian: true)
		data.append(greenMax, bigEndian: true)
		data.append(blueMax, bigEndian: true)

		data.append(redShift)
		data.append(greenShift)
		data.append(blueShift)

		data.appendPadding(length: 3)

		guard data.count == length else {
			fatalError("VNCProtocol.PixelFormat data.count (\(data.count)) != \(length)")
		}

		return data
	}

	var bytesPerPixel: UInt16 {
		.init(bitsPerPixel / 8)
	}

    func bytesPerRow(width: Int) -> Int {
        width * Int(bytesPerPixel)
    }
}
