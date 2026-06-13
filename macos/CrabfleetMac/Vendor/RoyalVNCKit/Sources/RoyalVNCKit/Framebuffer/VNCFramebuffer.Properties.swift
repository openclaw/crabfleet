#if canImport(FoundationEssentials)
import FoundationEssentials
#else
import Foundation
#endif

extension VNCFramebuffer {
	struct Properties: Equatable {
		let colorDepth: Int
		let usesColorMap: Bool

		let bitsPerPixel: Int
		let bytesPerPixel: Int
		let bytesPerRow: Int

		let redMax: Int
		let greenMax: Int
		let blueMax: Int
		let alphaMax: Int

		let redShift: Int
		let greenShift: Int
		let blueShift: Int
		let alphaShift: Int

		init(colorDepth: Int,
			 usesColorMap: Bool,
			 bitsPerPixel: Int,
			 bytesPerPixel: Int,
			 bytesPerRow: Int,
			 redMax: Int,
			 greenMax: Int,
			 blueMax: Int,
			 alphaMax: Int,
			 redShift: Int,
			 greenShift: Int,
			 blueShift: Int,
			 alphaShift: Int) {
			self.colorDepth = colorDepth
			self.usesColorMap = usesColorMap

			self.bitsPerPixel = bitsPerPixel
			self.bytesPerPixel = bytesPerPixel
			self.bytesPerRow = bytesPerRow

			self.redMax = redMax
			self.greenMax = greenMax
			self.blueMax = blueMax
			self.alphaMax = alphaMax

			self.redShift = redShift
			self.greenShift = greenShift
			self.blueShift = blueShift
			self.alphaShift = alphaShift
		}

		init(pixelFormat: VNCProtocol.PixelFormat,
			 width: Int) {
			self.init(colorDepth: .init(pixelFormat.depth),
					  usesColorMap: !pixelFormat.trueColor,
					  bitsPerPixel: .init(pixelFormat.bitsPerPixel),
					  bytesPerPixel: .init(pixelFormat.bytesPerPixel),
					  bytesPerRow: pixelFormat.bytesPerRow(width: width),
					  redMax: .init(pixelFormat.redMax),
					  greenMax: .init(pixelFormat.greenMax),
					  blueMax: .init(pixelFormat.blueMax),
					  alphaMax: 0,
					  redShift: .init(pixelFormat.redShift),
					  greenShift: .init(pixelFormat.greenShift),
					  blueShift: .init(pixelFormat.blueShift),
					  alphaShift: 0)
		}

		static func internalProperties(width: Int) -> Self {
			let colorDepth = 24
			let usesColorMap = false

			let bitsPerPixel = 32
			let bytesPerPixel = 4
			let bytesPerRow = width * bytesPerPixel

            let bits = Int((Double(colorDepth) / 3.0).rounded(.down))
			let colorMax = Int((1 << bits) - 1)

			let redMax = colorMax
			let greenMax = colorMax
			let blueMax = colorMax
			let alphaMax = colorMax

			let blueShift = bits * 0
			let greenShift = bits * 1
			let redShift = bits * 2
			let alphaShift = bits * 3

			return .init(colorDepth: colorDepth,
						 usesColorMap: usesColorMap,
						 bitsPerPixel: bitsPerPixel,
						 bytesPerPixel: bytesPerPixel,
						 bytesPerRow: bytesPerRow,
						 redMax: redMax,
						 greenMax: greenMax,
						 blueMax: blueMax,
						 alphaMax: alphaMax,
						 redShift: redShift,
						 greenShift: greenShift,
						 blueShift: blueShift,
						 alphaShift: alphaShift)
		}
	}
}
