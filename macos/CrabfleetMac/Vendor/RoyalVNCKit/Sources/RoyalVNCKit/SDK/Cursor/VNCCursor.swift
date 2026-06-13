#if canImport(FoundationEssentials)
import FoundationEssentials
#else
import Foundation
#endif

#if canImport(CoreGraphics)
import CoreGraphics
#endif

#if canImport(ObjectiveC)
@objc(VNCCursor)
#endif
public final class VNCCursor: NSObjectOrAnyObject {
#if canImport(ObjectiveC)
    @objc
#endif
	public static let empty = VNCCursor()

#if canImport(ObjectiveC)
    @objc
#endif
	public let isEmpty: Bool

#if canImport(ObjectiveC)
    @objc
#endif
	public let imageData: Data

	public let size: VNCSize
	public let hotspot: VNCPoint

#if canImport(ObjectiveC)
    @objc
#endif
	public let bitsPerComponent: Int

#if canImport(ObjectiveC)
    @objc
#endif
	public let bitsPerPixel: Int

#if canImport(ObjectiveC)
    @objc
#endif
	public let bytesPerPixel: Int

#if canImport(ObjectiveC)
    @objc
#endif
	public let bytesPerRow: Int

#if canImport(CoreGraphics)
	private static let rgbColorSpace = CGColorSpaceCreateDeviceRGB()
#endif

	override init() {
		self.isEmpty = true

		self.imageData = .init()

		self.size = .zero
		self.hotspot = .zero

		self.bitsPerComponent = 0
		self.bitsPerPixel = 0
		self.bytesPerPixel = 0
		self.bytesPerRow = 0
	}

	init(imageData: Data,
		 size: VNCSize,
		 hotspot: VNCPoint,
		 bitsPerComponent: Int,
		 bitsPerPixel: Int,
		 bytesPerPixel: Int) {
		self.isEmpty = false

		self.imageData = imageData
		self.size = size
		self.hotspot = hotspot

		self.bitsPerComponent = bitsPerComponent
		self.bitsPerPixel = bitsPerPixel
		self.bytesPerPixel = bytesPerPixel
		self.bytesPerRow = Int(size.width) * bytesPerPixel
	}
}

public extension VNCCursor {
    func copyPixelDataToRGBA32(destinationPixelBuffer: UnsafeMutableRawPointer) {
        let byteCount = self.imageData.count

        self.imageData.withUnsafeBytes { ptr in
            guard let ptrAddr = ptr.baseAddress else {
                return
            }

            // TODO: This assumes BGRA32 which might not be the case.
            GraphicsUtils.copyBGRAtoRGBA(srcBuffer: ptrAddr,
                                         dstBuffer: destinationPixelBuffer,
                                         byteCount: byteCount)
        }
    }
}

#if canImport(CoreGraphics)
public extension VNCCursor {
#if canImport(ObjectiveC)
    @objc
#endif
	var cgSize: CGSize {
		size.cgSize
	}

#if canImport(ObjectiveC)
    @objc
#endif
	var cgHotspot: CGPoint {
		hotspot.cgPoint
	}

#if canImport(ObjectiveC)
    @objc
#endif
	var cgImage: CGImage? {
		guard !imageData.isEmpty else {
			return nil
		}

		guard let dataProvider = CGDataProvider(data: imageData as CFData) else {
			return nil
		}

		let bitmapInfo: CGBitmapInfo = .init(rawValue: CGBitmapInfo.byteOrder32Big.rawValue | CGImageAlphaInfo.last.rawValue)

		let image = CGImage(width: .init(size.width),
							height: .init(size.height),
							bitsPerComponent: bitsPerComponent,
							bitsPerPixel: bitsPerPixel,
							bytesPerRow: bytesPerRow,
							space: Self.rgbColorSpace,
							bitmapInfo: bitmapInfo,
							provider: dataProvider,
							decode: nil,
							shouldInterpolate: false,
							intent: .defaultIntent)

		return image
	}
}
#endif
