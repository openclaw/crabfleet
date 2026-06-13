#if canImport(FoundationEssentials)
import FoundationEssentials
#else
import Foundation
#endif

#if canImport(CoreGraphics)
import CoreGraphics
#endif

#if canImport(CoreImage)
import CoreImage
#endif

#if canImport(IOSurface)
import IOSurface
#endif

#if os(macOS)
import AppKit
#endif

/// Represents a framebuffer for a VNC session, managing pixel data, updates, and screen layout.
#if canImport(ObjectiveC)
@objc(VNCFramebuffer)
#endif
public final class VNCFramebuffer: NSObjectOrAnyObject {
	// MARK: - Public Properties
    /// The framebuffer's size in pixels.
	public let size: VNCSize

    /// The framebuffer's size in pixels.
#if canImport(CoreGraphics)
#if canImport(ObjectiveC)
	@objc(size)
#endif
	public let cgSize: CGSize
#endif

    /// A `VNCRegion` that covers the entire framebuffer.
    public let fullRegion: VNCRegion

    /// A `CGRect` that covers the entire framebuffer.
#if canImport(CoreGraphics)
#if canImport(ObjectiveC)
	@objc(fullRegion)
#endif
	public let cgFullRegion: CGRect
#endif

    /// The memory allocator used to manage the framebuffer's pixel data.
    public let allocator: VNCFramebufferAllocator

    /// A pointer to the start of the framebuffer's pixel memory.
    public let surfaceAddress: UnsafeMutableRawPointer

    /// The total number of bytes in the framebuffer's pixel memory.
    public let surfaceByteCount: Int

    /// The list of logical screens represented in this framebuffer.
#if canImport(ObjectiveC)
	@objc
#endif
	public private(set) var screens: [VNCScreen]

    /// The color depth of the framebuffer.
#if canImport(ObjectiveC)
	@objc
#endif
	public var colorDepth: VNCConnection.Settings.ColorDepth {
		guard let depth = VNCConnection.Settings.ColorDepth(rawValue: .init(sourceProperties.colorDepth)) else {
			fatalError("Failed to convert color depth")
		}

		return depth
	}

	// MARK: - Internal Properties
	let sourcePixelFormat: VNCProtocol.PixelFormat
	weak var delegate: VNCFramebufferDelegate?
	let logger: VNCLogger

	let sourceProperties: Properties
	let destinationProperties: Properties

	let needsColorConversion: Bool

#if canImport(IOSurface) && canImport(CoreVideo)
    var ioSurface: IOSurface? {
        guard let surfaceAllocator = allocator as? VNCFramebufferIOSurfaceAllocator else {
            return nil
        }

        let surface = surfaceAllocator.surface

        return surface
    }
#endif

    private(set) var colorMap: ColorMap?

    // MARK: - Private Properties
    private var isBatchingUpdates = false
    private var regionsUpdatedInBatch = [VNCRegion]()

#if canImport(CoreGraphics)
	private static let rgbColorSpace = CGColorSpaceCreateDeviceRGB()
#endif

#if canImport(IOSurface)
	private static let surfaceLockOptionsReadOnly: IOSurfaceLockOptions = [ .readOnly ]
	private static let surfaceLockOptionsReadWrite: IOSurfaceLockOptions = [ ]
#endif

	private let width: Int
	private let height: Int

#if canImport(CoreImage)
	private let ciContext: CIContext
	private let ciImageOptions: [CIImageOption: Any]?
#endif

	private var framebufferHasBeenUpdatedAtLeastOnce = false

	init(logger: VNCLogger,
		 size: VNCSize,
		 screens: [VNCScreen],
		 pixelFormat: VNCProtocol.PixelFormat,
         allocator: VNCFramebufferAllocator?) throws {
		let width = Int(size.width)
		let height = Int(size.height)

		self.size = size

#if canImport(CoreGraphics)
		self.cgSize = size.cgSize
#endif

		self.fullRegion = .init(location: .zero, size: size)

#if canImport(CoreGraphics)
		self.cgFullRegion = .init(origin: .zero, size: size.cgSize)
#endif

		self.width = width
		self.height = height

		self.screens = screens.isEmpty
			? [ .init(id: 1, frame: .init(location: .zero, size: size)) ]
			: screens

		self.logger = logger
		self.sourcePixelFormat = pixelFormat

		let sourceProperties = Properties(pixelFormat: pixelFormat,
										  width: width)

		let destinationProperties = Properties.internalProperties(width: width)

		self.sourceProperties = sourceProperties
		self.destinationProperties = destinationProperties

		self.needsColorConversion = sourceProperties.bytesPerPixel != destinationProperties.bytesPerPixel ||
									sourceProperties.bitsPerPixel != destinationProperties.bitsPerPixel

#if canImport(CoreImage)
		self.ciContext = .init(options: [
			.allowLowPower: true,
			.outputColorSpace: Self.rgbColorSpace,
			.outputPremultiplied: false
		])

		self.ciImageOptions = [
			.colorSpace: Self.rgbColorSpace
		]
#endif

        let surfaceByteCount = width * height * destinationProperties.bytesPerPixel
        guard width > 0,
              height > 0,
              width <= VNCProtocolLimits.maximumFramebufferDimension,
              height <= VNCProtocolLimits.maximumFramebufferDimension,
              surfaceByteCount <= VNCProtocolLimits.maximumFramebufferBytes else {
            throw VNCError.protocol(.invalidData)
        }
        self.surfaceByteCount = surfaceByteCount

        if let allocator {
            self.allocator = allocator
        } else {
#if canImport(IOSurface)
            self.allocator = VNCFramebufferIOSurfaceAllocator(
                width: width,
                height: height,
                bytesPerPixel: destinationProperties.bytesPerPixel,
                bytesPerRow: destinationProperties.bytesPerRow
            )
#elseif canImport(Glibc) || canImport(Android) || canImport(WinSDK)
            self.allocator = VNCFramebufferMallocAllocator()
#else
            fatalError("Unsupported platform")
#endif
        }

        self.surfaceAddress = try self.allocator.allocate(size: surfaceByteCount)
	}

	deinit {
        allocator.deallocate(buffer: surfaceAddress)
	}
}

// MARK: - Public APIs
public extension VNCFramebuffer {
#if canImport(CoreImage) && canImport(IOSurface) && canImport(CoreVideo)
    /// A Core Image representation of the framebuffer contents, if available.
#if canImport(ObjectiveC)
	@objc
#endif
	var ciImage: CIImage? {
		guard framebufferHasBeenUpdatedAtLeastOnce else {
			return nil
		}

        lockSurfaceReadOnly()
        defer { unlockSurfaceReadOnly() }

        let image: CIImage

        if let ioSurfaceAllocator = self.allocator as? VNCFramebufferIOSurfaceAllocator,
           let surface = ioSurfaceAllocator.surface {
            image = .init(ioSurface: surface,
                          options: ciImageOptions)
        } else {
            let data = Data(bytes: surfaceAddress,
                            count: surfaceByteCount)

            image = .init(bitmapData: data,
                          bytesPerRow: destinationProperties.bytesPerRow,
                          size: self.size.cgSize,
                          format: .BGRA8,
                          colorSpace: Self.rgbColorSpace)
        }

        return image
	}
#endif

#if canImport(CoreImage)
    /// A Core Graphics image representation of the framebuffer contents, if available.
#if canImport(ObjectiveC)
	@objc
#endif
	var cgImage: CGImage? {
		guard let ciImage = ciImage else {
			return nil
		}

		guard let finalImage = ciContext.createCGImage(ciImage,
                                                       from: ciImage.extent,
                                                       format: .BGRA8,
                                                       colorSpace: Self.rgbColorSpace,
													   deferred: false) else {
			return nil
		}

//		logger.logDebug("CGImage.alphaInfo: \(finalImage.alphaInfo.rawValue)")

		return finalImage
	}
#endif

#if os(macOS)
    /// An AppKit image representation of the framebuffer contents, for macOS.
    @objc
    var nsImage: NSImage? {
        guard let ciImage = ciImage else {
            return nil
        }

        let rep = NSCIImageRep(ciImage: ciImage)

        let finalImage = NSImage(size: rep.size)
        finalImage.addRepresentation(rep)

        return finalImage
    }

    /// Creates a bounded, materialized preview that does not retain the full IOSurface.
    func snapshot(maxPixelSize: CGSize) -> NSImage? {
        guard framebufferHasBeenUpdatedAtLeastOnce,
              maxPixelSize.width > 0,
              maxPixelSize.height > 0 else {
            return nil
        }

        lockSurfaceReadOnly()
        defer { unlockSurfaceReadOnly() }

        let sourceImage: CIImage
        if let ioSurfaceAllocator = allocator as? VNCFramebufferIOSurfaceAllocator,
           let surface = ioSurfaceAllocator.surface {
            sourceImage = CIImage(ioSurface: surface, options: ciImageOptions)
        } else {
            let data = Data(bytes: surfaceAddress, count: surfaceByteCount)
            sourceImage = CIImage(
                bitmapData: data,
                bytesPerRow: destinationProperties.bytesPerRow,
                size: size.cgSize,
                format: .BGRA8,
                colorSpace: Self.rgbColorSpace
            )
        }

        let scale = min(
            1,
            maxPixelSize.width / size.cgSize.width,
            maxPixelSize.height / size.cgSize.height
        )
        let targetSize = CGSize(
            width: max(1, floor(size.cgSize.width * scale)),
            height: max(1, floor(size.cgSize.height * scale))
        )
        let scaledImage = sourceImage.transformed(
            by: CGAffineTransform(scaleX: scale, y: scale)
        )
        let renderRect = CGRect(origin: .zero, size: targetSize)

        guard let image = ciContext.createCGImage(
            scaledImage,
            from: renderRect,
            format: .BGRA8,
            colorSpace: Self.rgbColorSpace,
            deferred: false
        ) else {
            return nil
        }

        return NSImage(cgImage: image, size: targetSize)
    }
#endif
}

// MARK: - Internal API
extension VNCFramebuffer {
	func update(region: VNCRegion,
				data: inout Data) {
		logger.logDebug("Framebuffer Update Region \(region)")

		guard isValidRegion(region) else {
			logger.logError("Invalid region: \(region)")

			return
		}

		lockSurfaceReadWrite()
		updatePixelBufferWithData(&data, forRegion: region)
		unlockSurfaceReadWrite()
	}

	func copy(region sourceRegion: VNCRegion,
			  to destinationRegion: VNCRegion) {
		logger.logDebug("Framebuffer Copy Region \(sourceRegion) to \(destinationRegion)")

		guard isValidRegion(sourceRegion) else {
			logger.logError("Invalid region: \(sourceRegion)")

			return
		}

		guard isValidRegion(destinationRegion) else {
			logger.logError("Invalid region: \(destinationRegion)")

			return
		}

		lockSurfaceReadWrite()
		copyPixelBufferRegion(sourceRegion, to: destinationRegion)
		unlockSurfaceReadWrite()
	}

	func fill(region: VNCRegion,
			  withPixel pixelData: inout Data) {
		logger.logDebug("Framebuffer Fill Region \(region)")

		guard isValidRegion(region) else {
			logger.logError("Invalid region: \(region)")

			return
		}

		lockSurfaceReadWrite()
		fillPixelBufferWithPixel(&pixelData, forRegion: region)
		unlockSurfaceReadWrite()
	}

	func updateColorMap(_ entries: VNCProtocol.SetColourMapEntries) {
		let colorMap = ColorMap(entries: entries, existing: colorMap)

		self.colorMap = colorMap
	}

	func decodeCursor(image: inout Data,
					  mask: inout Data,
					  size: VNCSize,
					  hotspot: VNCPoint) -> VNCCursor {
		let destinationBitsPerPixel = destinationProperties.bitsPerPixel
		let destinationBytesPerPixel = destinationProperties.bytesPerPixel

		let bitsPerComponent = Int(8)

		let cursorWidth = Int(size.width)
		let cursorHeight = Int(size.height)

		let destinationLength = cursorWidth * cursorHeight * destinationBytesPerPixel
		let destinationMaxAlpha = UInt8(destinationProperties.alphaMax)

		// Decode to RGBA
		var destinationData = Data(repeating: 0, count: destinationLength)

		var fullyTransparent = true

		image.withUnsafeBytes { sourcePixelDataPtr in
			for row in 0..<cursorHeight {
				let sourceRowOffset = sourceOffsetOf(row: row, width: cursorWidth)
				let destinationRowOffset = destinationOffsetOf(row: row, width: cursorWidth)

				for column in 0..<cursorWidth {
					let sourceColumnOffset = sourceOffsetOf(column: column)
					let destinationColumnOffset = destinationOffsetOf(column: column)

					let sourceOffset = sourceRowOffset + sourceColumnOffset
					let destinationOffset = destinationRowOffset + destinationColumnOffset

					let destinationPixel = destinationPixelWith(sourcePixelData: sourcePixelDataPtr,
																sourcePixelDataOffset: sourceOffset)

                    let maskIdx = row * Int((Double(cursorWidth) / 8.0).rounded(.up)) + Int((Double(column) / 8.0).rounded(.down))

					let destinationAlpha: UInt8 = (mask[maskIdx] << (column % 8)) & 0x80 != 0
						? destinationMaxAlpha
						: 0

					destinationData[destinationOffset + 0] = destinationPixel.red
					destinationData[destinationOffset + 1] = destinationPixel.green
					destinationData[destinationOffset + 2] = destinationPixel.blue
					destinationData[destinationOffset + 3] = destinationAlpha

					if fullyTransparent && destinationAlpha > 0 {
						fullyTransparent = false
					}
				}
			}
		}

		guard !fullyTransparent else {
			return .empty
		}

		return .init(imageData: destinationData,
					 size: size,
					 hotspot: hotspot,
					 bitsPerComponent: bitsPerComponent,
					 bitsPerPixel: destinationBitsPerPixel,
					 bytesPerPixel: destinationBytesPerPixel)
	}

	func didUpdate(region: VNCRegion) {
        guard !isBatchingUpdates else {
            regionsUpdatedInBatch.append(region)

            return
        }

		notifyDelegateFramebufferDidUpdate(region: region)
	}

	func updateDesktopName(_ newDesktopName: String) {
		notifyDelegateDesktopNameDidUpdate(newDesktopName)
	}

	func updateCursor(_ cursor: VNCCursor) {
		notifyDelegateCursorDidUpdate(cursor)
	}

	func resize(to newSize: VNCSize) {
		let newScreens: [VNCScreen] = [
			.init(id: 0,
				  frame: .init(location: .zero, size: newSize))
		]

		resize(to: newSize,
			   screens: newScreens)
	}

	func resize(to newSize: VNCSize,
				screens newScreens: [VNCProtocol.Screen]) {
		let newVNCScreens = newScreens.map({ VNCScreen(screen: $0) })

		resize(to: newSize,
			   screens: newVNCScreens)
	}

	func resize(to newSize: VNCSize,
				screens newScreens: [VNCScreen]) {
		let sizeDidChange = newSize != size
		let screensDidChange = newScreens != screens

		guard sizeDidChange || screensDidChange else {
			// If the framebuffer size and screens are the same as before, there's nothing to do
			return
		}

		logger.logInfo("Desktop Size changed to \(newSize), number of screens: \(newScreens.count)")

		notifyDelegateSizeDidChange(newSize,
									screens: newScreens)
	}

    func beginBatchUpdates() {
        isBatchingUpdates = true
        regionsUpdatedInBatch = .init()
    }

    func endBatchUpdates() {
        guard isBatchingUpdates else {
            return
        }

        isBatchingUpdates = false

        // NOTE: Only for debugging!
//        logger.logInfo("regionsUpdatedInBatch: \(regionsUpdatedInBatch.count)")

        for region in regionsUpdatedInBatch {
            notifyDelegateFramebufferDidUpdate(region: region)
        }
    }
}

// MARK: - Update Framebuffer
private extension VNCFramebuffer {
	func updatePixelBufferWithData(_ data: inout Data,
								   forRegion region: VNCRegion) {
		guard width > 0,
			  height > 0,
			  region.size.width > 0,
			  region.size.height > 0 else {
			// Nothing to do for empty rect
			return
		}

		let frameBufferWidth = width

		let regionWidth = Int(region.size.width)
		let regionHeight = Int(region.size.height)

		let regionX = Int(region.location.x)
		let regionY = Int(region.location.y)

		let sourceBytesPerPixel = sourceProperties.bytesPerPixel
		let destinationBytesPerPixel = destinationProperties.bytesPerPixel

		let needsColorConversion = self.needsColorConversion
		let logger = self.logger

		let fixedAlpha = UInt8(destinationProperties.alphaMax)
		let alphaOffset = destinationBytesPerPixel - 1

		let sourceColumnLength = regionWidth * sourceBytesPerPixel
		let destinationColumnLength = regionWidth * destinationBytesPerPixel

        let targetBase = surfaceAddress

		data.withUnsafeBytes { sourcePixelDataPtr in
			for row in 0..<regionHeight {
				let sourceRowOffset = sourceOffsetOf(row: row, width: regionWidth)
				let destinationRowOffset = destinationOffsetOf(row: row + regionY, width: frameBufferWidth)

				if !needsColorConversion { // Fast Path
					let sourceColumnOffsetStart = sourceOffsetOf(column: 0)
					let destinationColumnOffsetStart = destinationOffsetOf(column: 0 + regionX)

					let sourceOffset = sourceRowOffset + sourceColumnOffsetStart
					let destinationOffset = destinationRowOffset + destinationColumnOffsetStart

					guard let source = sourcePixelDataPtr.baseAddress?.advanced(by: sourceOffset) else {
						logger.logError("Failed to get baseAddress of data to update framebuffer with")

						return
					}

					let target = targetBase.advanced(by: destinationOffset)

					target.copyMemory(from: source,
									  byteCount: sourceColumnLength)

					let targetArr = target.assumingMemoryBound(to: UInt8.self)

                    var idx = alphaOffset

                    while idx < destinationColumnLength {
                        targetArr[idx] = fixedAlpha

                        idx += destinationBytesPerPixel
                    }
				} else { // Slow Path
					for column in 0..<regionWidth {
						let sourceColumnOffset = sourceOffsetOf(column: column)
						let destinationColumnOffset = destinationOffsetOf(column: column + regionX)

						let sourceOffset = sourceRowOffset + sourceColumnOffset
						let destinationOffset = destinationRowOffset + destinationColumnOffset

						let destinationPixel = destinationPixelWith(sourcePixelData: sourcePixelDataPtr,
																	sourcePixelDataOffset: sourceOffset)

						let target = targetBase.advanced(by: destinationOffset).assumingMemoryBound(to: UInt8.self)

						target[0] = destinationPixel.blue
						target[1] = destinationPixel.green
						target[2] = destinationPixel.red
						target[3] = fixedAlpha
					}
				}
			}
		}

		if !framebufferHasBeenUpdatedAtLeastOnce {
			framebufferHasBeenUpdatedAtLeastOnce = true
		}
	}

	func fillPixelBufferWithPixel(_ pixelData: inout Data,
								  forRegion region: VNCRegion) {
		guard width > 0,
			  height > 0,
			  region.size.width > 0,
			  region.size.height > 0 else {
			// Nothing to do for empty rect
			return
		}

		let sourceBytesPerPixel = sourceProperties.bytesPerPixel
		let destinationBytesPerPixel = destinationProperties.bytesPerPixel

#if DEBUG
        guard pixelData.count == sourceBytesPerPixel else {
            return
        }
#endif

        let fixedAlpha = UInt8(destinationProperties.alphaMax)

		let frameBufferWidth = width

		let regionWidth = Int(region.size.width)
		let regionHeight = Int(region.size.height)

		let regionX = Int(region.location.x)
		let regionY = Int(region.location.y)

		let destinationColumnLength = regionWidth * destinationBytesPerPixel

		let destinationPixelData: Data

		if !needsColorConversion { // Fast Path
			destinationPixelData = .init([
				pixelData[0],
				pixelData[1],
				pixelData[2],
				fixedAlpha
			])
		} else { // Slow Path
			destinationPixelData = pixelData.withUnsafeBytes { sourcePixelDataPtr in
				let destinationPixel = destinationPixelWith(sourcePixelData: sourcePixelDataPtr,
															sourcePixelDataOffset: 0)

				return .init([
					destinationPixel.blue,
					destinationPixel.green,
					destinationPixel.red,
					fixedAlpha
				])
			}
		}

		let targetBase = surfaceAddress

		destinationPixelData.withUnsafeBytes { destinationPixelDataBytesPtr in
			guard let destinationPixelDataBytes = destinationPixelDataBytesPtr.baseAddress else { return }

			for row in 0..<regionHeight {
				let destinationRowOffset = destinationOffsetOf(row: row + regionY, width: frameBufferWidth)
				let destinationColumnOffsetStart = destinationOffsetOf(column: 0 + regionX)

				let destinationOffset = destinationRowOffset + destinationColumnOffsetStart

                var idx = destinationOffset

                while idx < destinationOffset + destinationColumnLength {
                    let target = targetBase.advanced(by: idx)

                    target.copyMemory(from: destinationPixelDataBytes,
                                      byteCount: destinationBytesPerPixel)

                    idx += destinationBytesPerPixel
                }
			}
		}

		if !framebufferHasBeenUpdatedAtLeastOnce {
			framebufferHasBeenUpdatedAtLeastOnce = true
		}
	}

    func copyPixelBufferRegion(_ sourceRegion: VNCRegion,
                              to destinationRegion: VNCRegion) {
		guard width > 0,
			  height > 0,
			  sourceRegion.size.width > 0,
			  sourceRegion.size.height > 0 else {
			// Nothing to do for empty rect
			return
		}

		var data = bufferData(ofRegion: sourceRegion)

		updatePixelBufferWithData(&data,
								  forRegion: destinationRegion)
    }

	func bufferData(ofRegion region: VNCRegion) -> Data {
		let frameBufferWidth = width

		let regionWidth = Int(region.size.width)
		let regionHeight = Int(region.size.height)

		let regionX = Int(region.location.x)
		let regionY = Int(region.location.y)

		let buffer = surfaceAddress.assumingMemoryBound(to: UInt8.self)

		let bytesPerPixel = destinationProperties.bytesPerPixel

		let dataLength = regionWidth * regionHeight * bytesPerPixel
		var data = Data(count: dataLength)

		let columnLength = regionWidth * bytesPerPixel

		let logger = self.logger

		data.withUnsafeMutableBytes {
			guard let targetBase = $0.baseAddress else {
				logger.logError("Failed to get baseAddress of target data to store framebuffer data in")

				return
			}

			var idx = 0

			for row in regionY..<regionY + regionHeight {
				let rowOffset = destinationOffsetOf(row: row, width: frameBufferWidth)

				let columnOffsetStart = destinationOffsetOf(column: regionX)
				let offset = rowOffset + columnOffsetStart

				let source = buffer.advanced(by: offset)
				let target = targetBase.advanced(by: idx)

				target.copyMemory(from: source,
								  byteCount: columnLength)

				idx += columnLength
			}
		}

		return data
	}
}

// MARK: Color/Pixel conversions
private extension VNCFramebuffer {
	func destinationPixelWith(sourcePixelData: UnsafeRawBufferPointer,
							  sourcePixelDataOffset: Int) -> LocalPixel {
        PixelUtils.destinationPixelWith(sourcePixelData: sourcePixelData,
                                        sourcePixelDataOffset: sourcePixelDataOffset,
                                        sourceProperties: sourceProperties,
                                        destinationProperties: destinationProperties,
                                        colorMap: colorMap)
    }
}

// MARK: - Source Offsets
private extension VNCFramebuffer {
	func sourceOffsetOf(row: Int,
						width: Int) -> Int {
		PixelUtils.offsetOf(row: row,
							width: width,
							bytesPerPixel: sourceProperties.bytesPerPixel)
	}

	func sourceOffsetOf(column: Int) -> Int {
		PixelUtils.offsetOf(column: column,
							bytesPerPixel: sourceProperties.bytesPerPixel)
	}

	func sourceOffsetOf(point: VNCPoint) -> Int {
		PixelUtils.offsetOf(point: point,
							bytesPerRow: sourceProperties.bytesPerRow,
							bitsPerPixel: sourceProperties.bitsPerPixel)
	}
}

// MARK: - Destination Offsets
private extension VNCFramebuffer {
    func destinationOffsetOf(row: Int,
							 width: Int) -> Int {
		PixelUtils.offsetOf(row: row,
							width: width,
							bytesPerPixel: destinationProperties.bytesPerPixel)
    }

    func destinationOffsetOf(column: Int) -> Int {
		PixelUtils.offsetOf(column: column,
							bytesPerPixel: destinationProperties.bytesPerPixel)
    }

    func destinationOffsetOf(point: VNCPoint) -> Int {
		PixelUtils.offsetOf(point: point,
							bytesPerRow: destinationProperties.bytesPerRow,
							bitsPerPixel: destinationProperties.bitsPerPixel)
    }
}

extension VNCFramebuffer {
    func copyPixelDataToRGBA32(pixelDataSize: inout Int) -> UnsafeMutableRawPointer {
        lockSurfaceReadOnly()
        defer { unlockSurfaceReadOnly() }

        pixelDataSize = surfaceByteCount

        let rgbaDataCopy = Self.copyBGRAtoRGBA(srcBuffer: surfaceAddress,
                                               byteCount: pixelDataSize)

        return rgbaDataCopy
    }

    func copyPixelDataToRGBA32(destinationPixelBuffer: UnsafeMutableRawPointer) {
        lockSurfaceReadOnly()
        defer { unlockSurfaceReadOnly() }

        GraphicsUtils.copyBGRAtoRGBA(
            srcBuffer: surfaceAddress,
            dstBuffer: destinationPixelBuffer,
            byteCount: surfaceByteCount
        )
    }

    func destroyRGBA32PixelData(_ buffer: UnsafeMutableRawPointer) {
        buffer.deallocate()
    }

    private static func copyBGRAtoRGBA(srcBuffer: UnsafeRawPointer,
                                       byteCount: Int) -> UnsafeMutableRawPointer {
        let dstBuffer = UnsafeMutableRawPointer.allocate(byteCount: byteCount,
                                                         alignment: MemoryLayout<UInt8>.alignment)

        GraphicsUtils.copyBGRAtoRGBA(
            srcBuffer: srcBuffer,
            dstBuffer: dstBuffer,
            byteCount: byteCount
        )

        return dstBuffer
    }
}

private extension VNCFramebuffer {
	func lockSurfaceReadOnly() {
        allocator.lockReadOnly()
	}

	func unlockSurfaceReadOnly() {
        allocator.unlockReadOnly()
	}

	func lockSurfaceReadWrite() {
        allocator.lockReadWrite()
	}

	func unlockSurfaceReadWrite() {
        allocator.unlockReadWrite()
	}
}

// MARK: - Validation
private extension VNCFramebuffer {
	func isValidRegion(_ region: VNCRegion) -> Bool {
		let regionX = Int(region.x)
		let regionY = Int(region.y)
		let regionWidth = Int(region.width)
		let regionHeight = Int(region.height)

		guard regionX >= 0,
			  regionY >= 0,
			  regionWidth >= 1,
			  regionHeight >= 1,
			  regionX + regionWidth <= width,
			  regionY + regionHeight <= height else {
			return false
		}

		return true
	}
}

// MARK: - Delegate Notifications
private extension VNCFramebuffer {
	func notifyDelegateFramebufferDidUpdate() {
		delegate?.framebuffer(self,
							  didUpdateRegion: fullRegion)
	}

	func notifyDelegateFramebufferDidUpdate(region: VNCRegion) {
		delegate?.framebuffer(self,
							  didUpdateRegion: region)
	}

	func notifyDelegateDesktopNameDidUpdate(_ newDesktopName: String) {
		delegate?.framebuffer(self,
							  didUpdateDesktopName: newDesktopName)
	}

	func notifyDelegateCursorDidUpdate(_ cursor: VNCCursor) {
		delegate?.framebuffer(self,
							  didUpdateCursor: cursor)
	}

	func notifyDelegateSizeDidChange(_ newSize: VNCSize,
									 screens newScreens: [VNCScreen]) {
		delegate?.framebuffer(self,
							  sizeDidChange: newSize,
							  screens: newScreens)
	}
}

/*
// MARK: - Debug API
extension VNCFramebuffer {
	// Write the raw data buffers to disk for verification purposes
	// The file name is of the format /tmp/framebuffer-{width}x{height}x{bytesPerPixel}.{timestamp}.raw
	// The file can be converted to a png using Imagemagick
	// > convert -size {width}x{height} -depth 8 BGRA:{filename} {output}.png
	func writeSurface() throws {
		lockSurfaceReadOnly()

		let url = URL(filePath: "/tmp/framebuffer-\(width)x\(height)x\(destinationProperties.bytesPerPixel).\(Int(Date().timeIntervalSince1970)).raw")
		let data = Data(bytes: buffer, count: width * height * destinationProperties.bytesPerPixel)
		try data.write(to: url)

		unlockSurfaceReadOnly()
	}
}
*/
