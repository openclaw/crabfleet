#if canImport(FoundationEssentials)
import FoundationEssentials
#else
import Foundation
#endif

enum VideoAnnexBCodec: Equatable {
	case h264
	case hevc

	var encodingType: VNCEncodingType {
		switch self {
			case .h264: VNCFrameEncodingType.openH264.rawValue
			case .hevc: VNCFrameEncodingType.crabfleetHEVC.rawValue
		}
	}

	func nalType(_ unit: Data) -> UInt8 {
		guard let first = unit.first else { return 0xff }
		switch self {
			case .h264: return first & 0x1f
			case .hevc: return (first >> 1) & 0x3f
		}
	}

	func isSlice(_ type: UInt8) -> Bool {
		switch self {
			case .h264: (1...5).contains(type)
			case .hevc: type <= 31
		}
	}

	func isIDR(_ type: UInt8) -> Bool {
		switch self {
			case .h264: type == 5
			case .hevc: (16...21).contains(type)
		}
	}
}

struct OpenH264AnnexB {
	static let maximumNALUnitCount = 4_096
	static let maximumParameterSetBytes = 64 * 1_024

	static func nalUnits(from data: Data) -> [Data] {
		func startCode(at offset: Int) -> Int? {
			guard offset + 3 <= data.count,
				  data[offset] == 0,
				  data[offset + 1] == 0 else { return nil }
			if data[offset + 2] == 1 { return 3 }
			guard offset + 4 <= data.count,
				  data[offset + 2] == 0,
				  data[offset + 3] == 1 else { return nil }
			return 4
		}

		var starts: [(offset: Int, length: Int)] = []
		var offset = 0
		while offset + 3 <= data.count {
			if let length = startCode(at: offset) {
				starts.append((offset, length))
				guard starts.count <= maximumNALUnitCount else { return [] }
				offset += length
			} else {
				offset += 1
			}
		}

		return starts.enumerated().compactMap { index, start in
			let payloadStart = start.offset + start.length
			let payloadEnd = index + 1 < starts.count ? starts[index + 1].offset : data.count
			guard payloadStart < payloadEnd else { return nil }
			return Data(data[payloadStart..<payloadEnd])
		}
	}

	static func parameterSets(in nalUnits: [Data]) -> (sps: Data?, pps: Data?) {
		var sps: Data?
		var pps: Data?
		for unit in nalUnits {
			guard let first = unit.first else { continue }
			switch first & 0x1f {
				case 7: sps = unit
				case 8: pps = unit
				default: break
			}
		}
		return (sps, pps)
	}

	static func videoParameterSets(
		in nalUnits: [Data],
		codec: VideoAnnexBCodec
	) -> (vps: Data?, sps: Data?, pps: Data?) {
		var vps: Data?
		var sps: Data?
		var pps: Data?
		for unit in nalUnits {
			switch (codec, codec.nalType(unit)) {
				case (.h264, 7), (.hevc, 33): sps = unit
				case (.h264, 8), (.hevc, 34): pps = unit
				case (.hevc, 32): vps = unit
				default: break
			}
		}
		return (vps, sps, pps)
	}

	static func parameterSetsFitLimit(sps: Data?, pps: Data?) -> Bool {
		let spsCount = sps?.count ?? 0
		let ppsCount = pps?.count ?? 0
		guard spsCount <= maximumParameterSetBytes,
			  ppsCount <= maximumParameterSetBytes else { return false }
		return spsCount <= maximumParameterSetBytes - ppsCount
	}

	static func parameterSetsFitLimit(vps: Data?, sps: Data?, pps: Data?) -> Bool {
		let counts = [vps, sps, pps].map { $0?.count ?? 0 }
		guard counts.allSatisfy({ $0 <= maximumParameterSetBytes }) else { return false }
		return counts.reduce(0, +) <= maximumParameterSetBytes
	}

	static func containsIDR(_ nalUnits: [Data]) -> Bool {
		nalUnits.contains { ($0.first ?? 0) & 0x1f == 5 }
	}

	static func containsIDR(_ nalUnits: [Data], codec: VideoAnnexBCodec) -> Bool {
		nalUnits.contains { codec.isIDR(codec.nalType($0)) }
	}

	/// Groups NAL units into access units: an Open H.264 rectangle may carry
	/// several whole frames glued together, and each must be decoded in order.
	/// A slice with first_mb_in_slice == 0 begins a new primary picture, while
	/// non-VCL units (SPS/PPS/SEI/AUD) after a slice belong to the next one.
	static func accessUnits(
		from nalUnits: [Data],
		codec: VideoAnnexBCodec = .h264
	) -> [[Data]] {
		var units: [[Data]] = []
		var current: [Data] = []
		var currentHasSlice = false
		for nalUnit in nalUnits {
			let nalType = codec.nalType(nalUnit)
			let isSlice = codec.isSlice(nalType)
			let beginsNewUnit = currentHasSlice
				&& (!isSlice || firstSliceIsZero(nalUnit, codec: codec))
			if beginsNewUnit {
				units.append(current)
				current = []
				currentHasSlice = false
			}
			current.append(nalUnit)
			if isSlice { currentHasSlice = true }
		}
		if !current.isEmpty { units.append(current) }
		return units
	}

	/// first_mb_in_slice is the slice header's leading ue(v); the value 0 is
	/// encoded as a single '1' bit, so continuation slices of the same frame
	/// (first_mb_in_slice > 0) start with a '0' bit instead.
	static func firstMacroblockInSliceIsZero(_ nalUnit: Data) -> Bool {
		guard nalUnit.count >= 2 else { return true }
		return nalUnit[nalUnit.index(after: nalUnit.startIndex)] & 0x80 != 0
	}

	static func firstSliceIsZero(_ nalUnit: Data, codec: VideoAnnexBCodec) -> Bool {
		switch codec {
			case .h264: return firstMacroblockInSliceIsZero(nalUnit)
			case .hevc:
				guard nalUnit.count >= 3 else { return true }
				return nalUnit[nalUnit.index(nalUnit.startIndex, offsetBy: 2)] & 0x80 != 0
		}
	}

	static func avccData(from nalUnits: [Data]) -> Data? {
		guard !nalUnits.isEmpty else { return nil }
		var data = Data()
		for unit in nalUnits {
			guard !unit.isEmpty, unit.count <= Int(UInt32.max) else { return nil }
			var length = UInt32(unit.count).bigEndian
			Swift.withUnsafeBytes(of: &length) { data.append(contentsOf: $0) }
			data.append(unit)
		}
		return data
	}
}

struct OpenH264DecodeGate {
	let codec: VideoAnnexBCodec
	private(set) var waitingForIDR = true

	init(codec: VideoAnnexBCodec = .h264) {
		self.codec = codec
	}

	mutating func reset() {
		waitingForIDR = true
	}

	mutating func shouldDecode(_ nalUnits: [Data]) -> Bool {
		guard waitingForIDR else { return true }
		guard OpenH264AnnexB.containsIDR(nalUnits, codec: codec) else { return false }
		waitingForIDR = false
		return true
	}

	mutating func decodeFailed() {
		waitingForIDR = true
	}
}

#if canImport(VideoToolbox)
import CoreMedia
import CoreVideo
import VideoToolbox

extension VNCProtocol {
	final class OpenH264Encoding: VNCFrameEncoding {
		let encodingType: VNCEncodingType
		let codec: VideoAnnexBCodec

		init(codec: VideoAnnexBCodec = .h264) {
			self.codec = codec
			encodingType = codec.encodingType
		}

		private struct Geometry: Hashable {
			let x: UInt16
			let y: UInt16
			let width: UInt16
			let height: UInt16
		}

		private final class DecoderContext {
			var decoderSession: VTDecompressionSession?
			var formatDescription: CMVideoFormatDescription?
			var vps: Data?
			var sps: Data?
			var pps: Data?
			var decodeGate: OpenH264DecodeGate
			var codedByteCount = 0

			init(codec: VideoAnnexBCodec) {
				decodeGate = OpenH264DecodeGate(codec: codec)
			}
		}

		private var contexts: [Geometry: DecoderContext] = [:]
		private var contextOrder: [Geometry] = []
		private static let maximumContextCount = 64

		deinit {
			invalidateAllDecoders()
		}

		static func supportsPixelFormat(_ pixelFormat: VNCProtocol.PixelFormat) -> Bool {
			pixelFormat.trueColor &&
			pixelFormat.bitsPerPixel == 32 &&
			pixelFormat.depth == 24 &&
			pixelFormat.redMax == 255 &&
			pixelFormat.greenMax == 255 &&
			pixelFormat.blueMax == 255
		}

		func decodeRectangle(_ rectangle: VNCProtocol.Rectangle,
						 framebuffer: VNCFramebuffer,
						 connection: NetworkConnectionReading,
						 logger: VNCLogger) async throws {
			let length = Int(try await connection.readUInt32())
			guard length <= 16 * 1_024 * 1_024 else {
				throw VNCError.protocol(.invalidData)
			}
			let flags = try await connection.readUInt32()
			let payload = try await connection.read(length: length)
			let nalUnits = OpenH264AnnexB.nalUnits(from: payload)

			let newGeometry = Geometry(
				x: rectangle.xPosition,
				y: rectangle.yPosition,
				width: rectangle.width,
				height: rectangle.height)
			if flags & 0x2 != 0 {
				invalidateAllDecoders()
			} else if flags & 0x1 != 0, let context = contexts.removeValue(forKey: newGeometry) {
				invalidateDecoder(context)
				contextOrder.removeAll { $0 == newGeometry }
			}
			let context = context(for: newGeometry)
			guard !nalUnits.isEmpty else {
				logger.logError("Video frame has no Annex-B NAL units")
				context.decodeGate.decodeFailed()
				return
			}
			// A rectangle may contain several whole frames; decode all of them
			// in order to keep the decoder's reference state, display the last.
			var lastImageBuffer: CVPixelBuffer?
			for accessUnit in OpenH264AnnexB.accessUnits(from: nalUnits, codec: codec) {
				guard updateParameterSets(in: accessUnit, context: context, logger: logger) else {
					return
				}
				guard context.decodeGate.shouldDecode(accessUnit) else { continue }

				do {
					if context.formatDescription == nil {
						let formatDescription = try makeFormatDescription(context: context)
						let codedByteCount = try validateCodedDimensions(
							formatDescription,
							rectangleWidth: Int(rectangle.width),
							rectangleHeight: Int(rectangle.height))
						let aggregateByteCount = contexts.values.reduce(0) {
							$0 + $1.codedByteCount
						}
						guard aggregateByteCount <= VNCProtocolLimits.maximumFramebufferBytes - codedByteCount else {
							throw OpenH264DecodeError.resourceLimit
						}
						context.codedByteCount = codedByteCount
						context.formatDescription = formatDescription
					}
					guard let formatDescription = context.formatDescription else {
						throw OpenH264DecodeError.missingParameterSets
					}
					if context.decoderSession == nil {
						context.decoderSession = try makeDecoder(formatDescription: formatDescription)
					}
					guard let decoderSession = context.decoderSession,
						  let avccData = OpenH264AnnexB.avccData(from: accessUnit) else {
						throw OpenH264DecodeError.invalidSample
					}
					let sampleBuffer = try makeSampleBuffer(
						data: avccData, formatDescription: formatDescription)
					lastImageBuffer = try decode(sampleBuffer, with: decoderSession)
				} catch {
					logger.logError("VideoToolbox decode failed: \(error.localizedDescription)")
					context.decodeGate.decodeFailed()
					invalidateDecoder(context)
					break
				}
			}

			guard let lastImageBuffer else { return }
			do {
				var pixels = try tightlyPackedBGRA(
					lastImageBuffer,
					width: Int(rectangle.width),
					height: Int(rectangle.height))
				framebuffer.update(region: rectangle.region, data: &pixels)
				framebuffer.didUpdate(region: rectangle.region)
			} catch {
				logger.logError("VideoToolbox blit failed: \(error.localizedDescription)")
				context.decodeGate.decodeFailed()
				invalidateDecoder(context)
			}
		}

		/// Applies codec parameter sets carried by one access unit, resetting the decoder
		/// on change. Returns false when resource limits are exceeded and the
		/// rest of the rectangle payload should be dropped.
		private func updateParameterSets(
			in accessUnit: [Data],
			context: DecoderContext,
			logger: VNCLogger
		) -> Bool {
			let parameterSets = OpenH264AnnexB.videoParameterSets(in: accessUnit, codec: codec)
			let candidateVPS = parameterSets.vps ?? context.vps
			let candidateSPS = parameterSets.sps ?? context.sps
			let candidatePPS = parameterSets.pps ?? context.pps
			guard OpenH264AnnexB.parameterSetsFitLimit(
				vps: candidateVPS,
				sps: candidateSPS,
				pps: candidatePPS) else {
				logger.logError("Video parameter sets exceed the resource limit")
				context.decodeGate.decodeFailed()
				invalidateDecoder(context)
				context.vps = nil
				context.sps = nil
				context.pps = nil
				return false
			}
			var needsReset = false
			if let newVPS = parameterSets.vps, newVPS != context.vps {
				context.vps = newVPS
				needsReset = true
			}
			if let newSPS = parameterSets.sps, newSPS != context.sps {
				context.sps = newSPS
				needsReset = true
			}
			if let newPPS = parameterSets.pps, newPPS != context.pps {
				context.pps = newPPS
				needsReset = true
			}
			if needsReset {
				invalidateDecoder(context)
				context.decodeGate.reset()
			}
			return true
		}

		private func invalidateDecoder(_ context: DecoderContext) {
			if let decoderSession = context.decoderSession {
				VTDecompressionSessionInvalidate(decoderSession)
			}
			context.decoderSession = nil
			context.formatDescription = nil
			context.codedByteCount = 0
		}

		private func invalidateAllDecoders() {
			for context in contexts.values { invalidateDecoder(context) }
			contexts.removeAll()
			contextOrder.removeAll()
		}

		private func context(for geometry: Geometry) -> DecoderContext {
			if let context = contexts[geometry] {
				contextOrder.removeAll { $0 == geometry }
				contextOrder.append(geometry)
				return context
			}
			if contexts.count >= Self.maximumContextCount,
				  let oldestGeometry = contextOrder.first,
				  let oldestContext = contexts.removeValue(forKey: oldestGeometry) {
				contextOrder.removeFirst()
				invalidateDecoder(oldestContext)
			}
			let context = DecoderContext(codec: codec)
			contexts[geometry] = context
			contextOrder.append(geometry)
			return context
		}

		private func makeFormatDescription(context: DecoderContext) throws
			-> CMVideoFormatDescription {
			guard let sps = context.sps, let pps = context.pps else {
				throw OpenH264DecodeError.missingParameterSets
			}
			if codec == .hevc {
				guard let vps = context.vps else {
					throw OpenH264DecodeError.missingParameterSets
				}
				return try makeHEVCFormatDescription(vps: vps, sps: sps, pps: pps)
			}
			return try sps.withUnsafeBytes { spsBytes in
				try pps.withUnsafeBytes { ppsBytes in
					guard let spsBase = spsBytes.bindMemory(to: UInt8.self).baseAddress,
						  let ppsBase = ppsBytes.bindMemory(to: UInt8.self).baseAddress else {
						throw OpenH264DecodeError.invalidParameterSets
					}
					var pointers: [UnsafePointer<UInt8>] = [spsBase, ppsBase]
					var sizes = [sps.count, pps.count]
					var description: CMFormatDescription?
					let status = CMVideoFormatDescriptionCreateFromH264ParameterSets(
						allocator: kCFAllocatorDefault,
						parameterSetCount: 2,
						parameterSetPointers: &pointers,
						parameterSetSizes: &sizes,
						nalUnitHeaderLength: 4,
						formatDescriptionOut: &description)
					guard status == noErr, let description else {
						throw OpenH264DecodeError.videoToolbox(status)
					}
					return description
				}
			}
		}

		private func makeHEVCFormatDescription(vps: Data, sps: Data, pps: Data) throws
			-> CMVideoFormatDescription {
			try vps.withUnsafeBytes { vpsBytes in
				try sps.withUnsafeBytes { spsBytes in
					try pps.withUnsafeBytes { ppsBytes in
						guard let vpsBase = vpsBytes.bindMemory(to: UInt8.self).baseAddress,
							  let spsBase = spsBytes.bindMemory(to: UInt8.self).baseAddress,
							  let ppsBase = ppsBytes.bindMemory(to: UInt8.self).baseAddress else {
							throw OpenH264DecodeError.invalidParameterSets
						}
						var pointers: [UnsafePointer<UInt8>] = [vpsBase, spsBase, ppsBase]
						var sizes = [vps.count, sps.count, pps.count]
						var description: CMFormatDescription?
						let status = CMVideoFormatDescriptionCreateFromHEVCParameterSets(
							allocator: kCFAllocatorDefault,
							parameterSetCount: 3,
							parameterSetPointers: &pointers,
							parameterSetSizes: &sizes,
							nalUnitHeaderLength: 4,
							extensions: nil,
							formatDescriptionOut: &description)
						guard status == noErr, let description else {
							throw OpenH264DecodeError.videoToolbox(status)
						}
						return description
					}
				}
			}
		}

		private func makeDecoder(formatDescription: CMVideoFormatDescription) throws
			-> VTDecompressionSession {
			let attributes: CFDictionary = [
				kCVPixelBufferPixelFormatTypeKey: kCVPixelFormatType_32BGRA,
				kCVPixelBufferIOSurfacePropertiesKey: [:] as CFDictionary
			] as CFDictionary
			var session: VTDecompressionSession?
			let status = VTDecompressionSessionCreate(
				allocator: kCFAllocatorDefault,
				formatDescription: formatDescription,
				decoderSpecification: nil,
				imageBufferAttributes: attributes,
				outputCallback: nil,
				decompressionSessionOut: &session)
			guard status == noErr, let session else {
				throw OpenH264DecodeError.videoToolbox(status)
			}
			return session
		}

		private func validateCodedDimensions(
			_ formatDescription: CMVideoFormatDescription,
			rectangleWidth: Int,
			rectangleHeight: Int
		) throws -> Int {
			let dimensions = CMVideoFormatDescriptionGetDimensions(formatDescription)
			let width = Int(dimensions.width)
			let height = Int(dimensions.height)
			guard width >= rectangleWidth,
				  height >= rectangleHeight,
				  width <= rectangleWidth + 15,
				  height <= rectangleHeight + 15,
				  width <= VNCProtocolLimits.maximumFramebufferDimension,
				  height <= VNCProtocolLimits.maximumFramebufferDimension else {
				throw OpenH264DecodeError.invalidDimensions
			}
			let (pixelCount, pixelOverflow) = width.multipliedReportingOverflow(by: height)
			let (byteCount, byteOverflow) = pixelCount.multipliedReportingOverflow(by: 4)
			guard !pixelOverflow,
				  !byteOverflow,
				  byteCount <= VNCProtocolLimits.maximumFramebufferBytes else {
				throw OpenH264DecodeError.invalidDimensions
			}
			return byteCount
		}

		private func makeSampleBuffer(
			data: Data,
			formatDescription: CMVideoFormatDescription
		) throws -> CMSampleBuffer {
			var blockBuffer: CMBlockBuffer?
			var status = CMBlockBufferCreateWithMemoryBlock(
				allocator: kCFAllocatorDefault,
				memoryBlock: nil,
				blockLength: data.count,
				blockAllocator: kCFAllocatorDefault,
				customBlockSource: nil,
				offsetToData: 0,
				dataLength: data.count,
				flags: 0,
				blockBufferOut: &blockBuffer)
			guard status == kCMBlockBufferNoErr, let blockBuffer else {
				throw OpenH264DecodeError.videoToolbox(status)
			}
			status = data.withUnsafeBytes { bytes in
				CMBlockBufferReplaceDataBytes(
					with: bytes.baseAddress!, blockBuffer: blockBuffer, offsetIntoDestination: 0,
					dataLength: data.count)
			}
			guard status == kCMBlockBufferNoErr else {
				throw OpenH264DecodeError.videoToolbox(status)
			}

			var sampleBuffer: CMSampleBuffer?
			var sampleSize = data.count
			status = CMSampleBufferCreateReady(
				allocator: kCFAllocatorDefault,
				dataBuffer: blockBuffer,
				formatDescription: formatDescription,
				sampleCount: 1,
				sampleTimingEntryCount: 0,
				sampleTimingArray: nil,
				sampleSizeEntryCount: 1,
				sampleSizeArray: &sampleSize,
				sampleBufferOut: &sampleBuffer)
			guard status == noErr, let sampleBuffer else {
				throw OpenH264DecodeError.videoToolbox(status)
			}
			return sampleBuffer
		}

		private func decode(
			_ sampleBuffer: CMSampleBuffer,
			with session: VTDecompressionSession
		) throws -> CVPixelBuffer {
			let result = DecodeOutputBox()
			var infoFlags = VTDecodeInfoFlags()
			let status = VTDecompressionSessionDecodeFrame(
				session,
				sampleBuffer: sampleBuffer,
				flags: [],
				infoFlagsOut: &infoFlags
			) { status, _, imageBuffer, _, _ in
				result.set(status: status, imageBuffer: imageBuffer)
			}
			guard status == noErr else { throw OpenH264DecodeError.videoToolbox(status) }
			let output = result.get()
			guard output.status == noErr, let imageBuffer = output.imageBuffer else {
				throw OpenH264DecodeError.videoToolbox(output.status)
			}
			return imageBuffer
		}

		private func tightlyPackedBGRA(
			_ pixelBuffer: CVPixelBuffer,
			width: Int,
			height: Int
		) throws -> Data {
			guard CVPixelBufferGetWidth(pixelBuffer) >= width,
				  CVPixelBufferGetHeight(pixelBuffer) >= height,
				  CVPixelBufferGetPixelFormatType(pixelBuffer) == kCVPixelFormatType_32BGRA else {
				throw OpenH264DecodeError.invalidDimensions
			}
			CVPixelBufferLockBaseAddress(pixelBuffer, .readOnly)
			defer { CVPixelBufferUnlockBaseAddress(pixelBuffer, .readOnly) }
			guard let source = CVPixelBufferGetBaseAddress(pixelBuffer) else {
				throw OpenH264DecodeError.invalidSample
			}
			let sourceBytesPerRow = CVPixelBufferGetBytesPerRow(pixelBuffer)
			let packedBytesPerRow = width * 4
			guard sourceBytesPerRow >= packedBytesPerRow else {
				throw OpenH264DecodeError.invalidDimensions
			}
			var data = Data(count: packedBytesPerRow * height)
			data.withUnsafeMutableBytes { destination in
				guard let destinationBase = destination.baseAddress else { return }
				for row in 0..<height {
					destinationBase.advanced(by: row * packedBytesPerRow).copyMemory(
						from: source.advanced(by: row * sourceBytesPerRow),
						byteCount: packedBytesPerRow)
				}
			}
			return data
		}
	}
}

private enum OpenH264DecodeError: Error {
	case missingParameterSets
	case invalidParameterSets
	case invalidSample
	case invalidDimensions
	case resourceLimit
	case videoToolbox(OSStatus)
}

private final class DecodeOutputBox: @unchecked Sendable {
	private let lock = NSLock()
	private var status: OSStatus = -1
	private var imageBuffer: CVPixelBuffer?

	func set(status: OSStatus, imageBuffer: CVPixelBuffer?) {
		lock.lock()
		self.status = status
		self.imageBuffer = imageBuffer
		lock.unlock()
	}

	func get() -> (status: OSStatus, imageBuffer: CVPixelBuffer?) {
		lock.lock()
		defer { lock.unlock() }
		return (status, imageBuffer)
	}
}
#else
extension VNCProtocol {
	final class OpenH264Encoding: VNCFrameEncoding {
		let encodingType: VNCEncodingType

		init(codec: VideoAnnexBCodec = .h264) {
			encodingType = codec.encodingType
		}

		static func supportsPixelFormat(_ pixelFormat: VNCProtocol.PixelFormat) -> Bool {
			false
		}

		func decodeRectangle(_ rectangle: VNCProtocol.Rectangle,
						 framebuffer: VNCFramebuffer,
						 connection: NetworkConnectionReading,
						 logger: VNCLogger) async throws {
			throw VNCError.protocol(.notImplemented(feature: "Open H.264 encoding"))
		}
	}
}
#endif
