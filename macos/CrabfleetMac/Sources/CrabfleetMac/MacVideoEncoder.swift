import CoreMedia
import Foundation
import VideoToolbox

struct EncodedVideoFrame: Sendable {
  let data: Data
  let isKeyframe: Bool
  let width: Int
  let height: Int
}

enum MacVideoCodec: Equatable, Sendable {
  case h264
  case hevc

  var videoToolboxType: CMVideoCodecType {
    switch self {
    case .h264: kCMVideoCodecType_H264
    case .hevc: kCMVideoCodecType_HEVC
    }
  }

  var profileLevel: CFString {
    switch self {
    case .h264: kVTProfileLevel_H264_ConstrainedBaseline_AutoLevel
    case .hevc: kVTProfileLevel_HEVC_Main_AutoLevel
    }
  }
}

enum MacVideoEncoderError: Error {
  case creationFailed(OSStatus)
  case propertyRejected(OSStatus)
  case invalidSample
  case malformedNALUnits
}

struct VideoKeyframePolicy: Sendable {
  private var framesSinceKeyframe = 0
  private var lastKeyframeTime: Double?

  mutating func shouldForceKeyframe(
    explicit: Bool,
    recovery: Bool,
    presentationSeconds: Double
  ) -> Bool {
    if lastKeyframeTime == nil, presentationSeconds.isFinite {
      lastKeyframeTime = presentationSeconds
    }
    let intervalElapsed = presentationSeconds.isFinite
      && presentationSeconds - (lastKeyframeTime ?? presentationSeconds) >= 30
    let shouldForce = explicit || recovery || framesSinceKeyframe >= 1_799 || intervalElapsed
    if shouldForce {
      framesSinceKeyframe = 0
      if presentationSeconds.isFinite { lastKeyframeTime = presentationSeconds }
    } else {
      framesSinceKeyframe += 1
    }
    return shouldForce
  }
}

final class MacVideoEncoder: @unchecked Sendable {
  let codec: MacVideoCodec
  let isHardwareAccelerated: Bool
  let frames: AsyncStream<EncodedVideoFrame>

  private let lock = NSLock()
  private let continuation: AsyncStream<EncodedVideoFrame>.Continuation
  private let callbackContext: CallbackContext
  private let configuredWidth: Int
  private let configuredHeight: Int
  private var session: VTCompressionSession?
  private var invalidated = false
  private var keyframePolicy = VideoKeyframePolicy()
  private var lastPresentationTime: CMTime?
  private var configuredMaximumFrameQP: Int?
  private var maximumFrameQPUnavailable = false

  var isMaximumFrameQPAvailable: Bool {
    withLock { !maximumFrameQPUnavailable }
  }

  init(
    width: Int,
    height: Int,
    codec: MacVideoCodec = .h264,
    maximumFrameQP: Int? = 40
  ) throws {
    let stream = AsyncStream<EncodedVideoFrame>.makeStream(
      bufferingPolicy: .bufferingNewest(2))
    frames = stream.stream
    continuation = stream.continuation
    self.codec = codec
    callbackContext = CallbackContext(continuation: stream.continuation, codec: codec)
    configuredWidth = width
    configuredHeight = height

    let lowLatencySpecification: CFDictionary = [
      kVTVideoEncoderSpecification_EnableLowLatencyRateControl: true
    ] as CFDictionary
    let hardwareSpecification: CFDictionary = [
      kVTVideoEncoderSpecification_EnableHardwareAcceleratedVideoEncoder: true
    ] as CFDictionary

    var createdSession: VTCompressionSession?
    var usedLowLatency = false
    var status = VTCompressionSessionCreate(
      allocator: kCFAllocatorDefault,
      width: Int32(width),
      height: Int32(height),
      codecType: codec.videoToolboxType,
      encoderSpecification: lowLatencySpecification,
      imageBufferAttributes: nil,
      compressedDataAllocator: nil,
      outputCallback: Self.outputCallback,
      refcon: Unmanaged.passUnretained(callbackContext).toOpaque(),
      compressionSessionOut: &createdSession
    )
    if status == noErr {
      usedLowLatency = true
    } else {
      status = VTCompressionSessionCreate(
        allocator: kCFAllocatorDefault,
        width: Int32(width),
        height: Int32(height),
        codecType: codec.videoToolboxType,
        encoderSpecification: hardwareSpecification,
        imageBufferAttributes: nil,
        compressedDataAllocator: nil,
        outputCallback: Self.outputCallback,
        refcon: Unmanaged.passUnretained(callbackContext).toOpaque(),
        compressionSessionOut: &createdSession
      )
    }
    if status != noErr {
      status = VTCompressionSessionCreate(
        allocator: kCFAllocatorDefault,
        width: Int32(width),
        height: Int32(height),
        codecType: codec.videoToolboxType,
        encoderSpecification: nil,
        imageBufferAttributes: nil,
        compressedDataAllocator: nil,
        outputCallback: Self.outputCallback,
        refcon: Unmanaged.passUnretained(callbackContext).toOpaque(),
        compressionSessionOut: &createdSession
      )
    }
    guard status == noErr, let createdSession else {
      stream.continuation.finish()
      throw MacVideoEncoderError.creationFailed(status)
    }

    session = createdSession
    Self.setProperty(createdSession, key: kVTCompressionPropertyKey_RealTime, value: true)
    Self.setProperty(
      createdSession,
      key: kVTCompressionPropertyKey_ProfileLevel,
      value: codec.profileLevel)
    Self.setProperty(
      createdSession, key: kVTCompressionPropertyKey_AllowFrameReordering, value: false)
    Self.setProperty(
      createdSession, key: kVTCompressionPropertyKey_MaxKeyFrameInterval, value: 1_800)
    Self.setProperty(
      createdSession, key: kVTCompressionPropertyKey_MaxKeyFrameIntervalDuration, value: 30)
    Self.setProperty(
      createdSession, key: kVTCompressionPropertyKey_ExpectedFrameRate, value: 60)
    Self.setProperty(
      createdSession, key: kVTCompressionPropertyKey_AverageBitRate, value: 8_000_000)
    if let maximumFrameQP {
      let qpStatus = VTSessionSetProperty(
        createdSession,
        key: kVTCompressionPropertyKey_MaxAllowedFrameQP,
        value: NSNumber(value: maximumFrameQP))
      if qpStatus == kVTPropertyNotSupportedErr {
        maximumFrameQPUnavailable = true
      } else if qpStatus != noErr {
        session = nil
        VTCompressionSessionInvalidate(createdSession)
        stream.continuation.finish()
        throw MacVideoEncoderError.propertyRejected(qpStatus)
      } else {
        configuredMaximumFrameQP = maximumFrameQP
      }
    }
    _ = VTCompressionSessionPrepareToEncodeFrames(createdSession)

    var hardwareValuePointer: UnsafeRawPointer?
    let queryStatus = VTSessionCopyProperty(
      createdSession,
      key: kVTCompressionPropertyKey_UsingHardwareAcceleratedVideoEncoder,
      allocator: kCFAllocatorDefault,
      valueOut: &hardwareValuePointer)
    let hardwareValue = hardwareValuePointer.map {
      CFBooleanGetValue(Unmanaged<CFBoolean>.fromOpaque($0).takeRetainedValue())
    } ?? false
    isHardwareAccelerated = usedLowLatency
      || (queryStatus == noErr && hardwareValue)
  }

  deinit {
    invalidate()
  }

  /// Submits one frame; the encoded output arrives on `frames`. Returns false
  /// when the frame is rejected (stale size, non-monotonic timestamp, or an
  /// invalidated session) so callers can tell "no output coming" from failure.
  @discardableResult
  func encode(
    _ pixelBuffer: CVPixelBuffer,
    presentationTime: CMTime,
    forceKeyframe: Bool
  ) -> Bool {
    lock.lock()
    guard !invalidated, let activeSession = session,
      CVPixelBufferGetWidth(pixelBuffer) == configuredWidth,
      CVPixelBufferGetHeight(pixelBuffer) == configuredHeight,
      presentationTime.isValid,
      CMTimeGetSeconds(presentationTime).isFinite,
      lastPresentationTime.map({ CMTimeCompare(presentationTime, $0) > 0 }) ?? true
    else {
      lock.unlock()
      return false
    }
    let shouldForceKeyframe = keyframePolicy.shouldForceKeyframe(
      explicit: forceKeyframe,
      recovery: callbackContext.consumeKeyframeRequest(),
      presentationSeconds: CMTimeGetSeconds(presentationTime))
    lastPresentationTime = presentationTime
    let properties: CFDictionary? = shouldForceKeyframe
      ? [kVTEncodeFrameOptionKey_ForceKeyFrame: true] as CFDictionary
      : nil
    let status = VTCompressionSessionEncodeFrame(
      activeSession,
      imageBuffer: pixelBuffer,
      presentationTimeStamp: presentationTime,
      duration: .invalid,
      frameProperties: properties,
      sourceFrameRefcon: nil,
      infoFlagsOut: nil)
    lock.unlock()
    if status != noErr {
      fail()
      return false
    }
    return true
  }

  func setAverageBitrate(_ bitsPerSecond: Int) {
    guard let activeSession = withLock({ invalidated ? nil : session }) else { return }
    Self.setProperty(
      activeSession,
      key: kVTCompressionPropertyKey_AverageBitRate,
      value: bitsPerSecond)
  }

  func setMaximumFrameQP(_ maximum: Int?) -> OSStatus {
    withLock {
      guard !invalidated, let activeSession = session else { return kVTInvalidSessionErr }
      guard configuredMaximumFrameQP != maximum else { return noErr }
      if maximumFrameQPUnavailable { return noErr }
      let value: CFTypeRef? = maximum.map { NSNumber(value: $0) }
      let status = VTSessionSetProperty(
        activeSession,
        key: kVTCompressionPropertyKey_MaxAllowedFrameQP,
        value: value)
      if status == kVTPropertyNotSupportedErr, configuredMaximumFrameQP == nil {
        maximumFrameQPUnavailable = true
        return noErr
      }
      if status == noErr { configuredMaximumFrameQP = maximum }
      return status
    }
  }

  func invalidate() {
    let activeSession = withLock { () -> VTCompressionSession? in
      guard !invalidated else { return nil }
      invalidated = true
      defer { session = nil }
      return session
    }
    guard let activeSession else { return }
    VTCompressionSessionCompleteFrames(activeSession, untilPresentationTimeStamp: .invalid)
    VTCompressionSessionInvalidate(activeSession)
    continuation.finish()
  }

  static func annexBData(
    lengthPrefixedData: Data,
    nalUnitHeaderLength: Int,
    parameterSets: [Data] = [],
    isKeyframe: Bool = false
  ) throws -> Data {
    guard (1...4).contains(nalUnitHeaderLength) else {
      throw MacVideoEncoderError.malformedNALUnits
    }
    var output = Data()
    if isKeyframe {
      for parameterSet in parameterSets where !parameterSet.isEmpty {
        output.append(contentsOf: [0, 0, 0, 1])
        output.append(parameterSet)
      }
    }

    var offset = 0
    while offset < lengthPrefixedData.count {
      guard offset + nalUnitHeaderLength <= lengthPrefixedData.count else {
        throw MacVideoEncoderError.malformedNALUnits
      }
      var length = 0
      for byte in lengthPrefixedData[offset..<(offset + nalUnitHeaderLength)] {
        length = (length << 8) | Int(byte)
      }
      offset += nalUnitHeaderLength
      guard length > 0, offset + length <= lengthPrefixedData.count else {
        throw MacVideoEncoderError.malformedNALUnits
      }
      output.append(contentsOf: [0, 0, 0, 1])
      output.append(lengthPrefixedData[offset..<(offset + length)])
      offset += length
    }
    return output
  }

  private static let outputCallback: VTCompressionOutputCallback = {
    outputCallbackRefCon, _, status, infoFlags, sampleBuffer in
    guard let outputCallbackRefCon else { return }
    let context = Unmanaged<CallbackContext>.fromOpaque(outputCallbackRefCon)
      .takeUnretainedValue()
    guard status == noErr else {
      context.continuation.finish()
      return
    }
    guard !infoFlags.contains(.frameDropped), let sampleBuffer else { return }
    do {
      let frame = try MacVideoEncoder.encodedFrame(from: sampleBuffer, codec: context.codec)
      context.yield(frame)
    } catch {
      context.continuation.finish()
    }
  }

  private final class CallbackContext: @unchecked Sendable {
    let continuation: AsyncStream<EncodedVideoFrame>.Continuation
    let codec: MacVideoCodec
    private let lock = NSLock()
    private var needsKeyframe = false

    init(
      continuation: AsyncStream<EncodedVideoFrame>.Continuation,
      codec: MacVideoCodec
    ) {
      self.continuation = continuation
      self.codec = codec
    }

    func yield(_ frame: EncodedVideoFrame) {
      lock.lock()
      defer { lock.unlock() }
      switch continuation.yield(frame) {
      case .enqueued, .terminated:
        break
      case .dropped:
        // The consumer never saw this frame, so later deltas would reference
        // pixels the client is missing; resync at the next submitted frame.
        needsKeyframe = true
      @unknown default:
        needsKeyframe = true
      }
    }

    func consumeKeyframeRequest() -> Bool {
      lock.lock()
      defer { lock.unlock() }
      defer { needsKeyframe = false }
      return needsKeyframe
    }
  }

  private static func encodedFrame(
    from sampleBuffer: CMSampleBuffer,
    codec: MacVideoCodec
  ) throws
    -> EncodedVideoFrame
  {
    guard CMSampleBufferDataIsReady(sampleBuffer),
      let dataBuffer = CMSampleBufferGetDataBuffer(sampleBuffer),
      let formatDescription = CMSampleBufferGetFormatDescription(sampleBuffer)
    else {
      throw MacVideoEncoderError.invalidSample
    }

    let dataLength = CMBlockBufferGetDataLength(dataBuffer)
    guard dataLength > 0 else { throw MacVideoEncoderError.invalidSample }
    var lengthPrefixedData = Data(count: dataLength)
    let copyStatus = lengthPrefixedData.withUnsafeMutableBytes { bytes in
      CMBlockBufferCopyDataBytes(
        dataBuffer,
        atOffset: 0,
        dataLength: dataLength,
        destination: bytes.baseAddress!)
    }
    guard copyStatus == kCMBlockBufferNoErr else {
      throw MacVideoEncoderError.invalidSample
    }

    let attachments = CMSampleBufferGetSampleAttachmentsArray(
      sampleBuffer, createIfNecessary: false) as? [[CFString: Any]]
    let isKeyframe = !(attachments?.first?[kCMSampleAttachmentKey_NotSync] as? Bool ?? false)
    let parameterSetInfo = try parameterSets(from: formatDescription, codec: codec)
    let data = try annexBData(
      lengthPrefixedData: lengthPrefixedData,
      nalUnitHeaderLength: parameterSetInfo.nalUnitHeaderLength,
      parameterSets: parameterSetInfo.parameterSets,
      isKeyframe: isKeyframe)
    let dimensions = CMVideoFormatDescriptionGetDimensions(formatDescription)
    return EncodedVideoFrame(
      data: data,
      isKeyframe: isKeyframe,
      width: Int(dimensions.width),
      height: Int(dimensions.height))
  }

  private static func parameterSets(
    from formatDescription: CMFormatDescription,
    codec: MacVideoCodec
  ) throws -> (parameterSets: [Data], nalUnitHeaderLength: Int) {
    switch codec {
    case .h264:
      try h264ParameterSets(from: formatDescription)
    case .hevc:
      try hevcParameterSets(from: formatDescription)
    }
  }

  private static func h264ParameterSets(from formatDescription: CMFormatDescription) throws
    -> (parameterSets: [Data], nalUnitHeaderLength: Int)
  {
    var parameterSetCount = 0
    var nalUnitHeaderLength: Int32 = 0
    var pointer: UnsafePointer<UInt8>?
    var size = 0
    let firstStatus = CMVideoFormatDescriptionGetH264ParameterSetAtIndex(
      formatDescription,
      parameterSetIndex: 0,
      parameterSetPointerOut: &pointer,
      parameterSetSizeOut: &size,
      parameterSetCountOut: &parameterSetCount,
      nalUnitHeaderLengthOut: &nalUnitHeaderLength)
    guard firstStatus == noErr else { throw MacVideoEncoderError.invalidSample }

    var parameterSets: [Data] = []
    for index in 0..<parameterSetCount {
      pointer = nil
      size = 0
      let status = CMVideoFormatDescriptionGetH264ParameterSetAtIndex(
        formatDescription,
        parameterSetIndex: index,
        parameterSetPointerOut: &pointer,
        parameterSetSizeOut: &size,
        parameterSetCountOut: nil,
        nalUnitHeaderLengthOut: nil)
      guard status == noErr, let pointer, size > 0 else {
        throw MacVideoEncoderError.invalidSample
      }
      parameterSets.append(Data(bytes: pointer, count: size))
    }
    return (parameterSets, Int(nalUnitHeaderLength))
  }

  private static func hevcParameterSets(from formatDescription: CMFormatDescription) throws
    -> (parameterSets: [Data], nalUnitHeaderLength: Int)
  {
    var parameterSetCount = 0
    var nalUnitHeaderLength: Int32 = 0
    var pointer: UnsafePointer<UInt8>?
    var size = 0
    let firstStatus = CMVideoFormatDescriptionGetHEVCParameterSetAtIndex(
      formatDescription,
      parameterSetIndex: 0,
      parameterSetPointerOut: &pointer,
      parameterSetSizeOut: &size,
      parameterSetCountOut: &parameterSetCount,
      nalUnitHeaderLengthOut: &nalUnitHeaderLength)
    guard firstStatus == noErr else { throw MacVideoEncoderError.invalidSample }

    var parameterSets: [Data] = []
    for index in 0..<parameterSetCount {
      pointer = nil
      size = 0
      let status = CMVideoFormatDescriptionGetHEVCParameterSetAtIndex(
        formatDescription,
        parameterSetIndex: index,
        parameterSetPointerOut: &pointer,
        parameterSetSizeOut: &size,
        parameterSetCountOut: nil,
        nalUnitHeaderLengthOut: nil)
      guard status == noErr, let pointer, size > 0 else {
        throw MacVideoEncoderError.invalidSample
      }
      parameterSets.append(Data(bytes: pointer, count: size))
    }
    guard parameterSets.count >= 3 else { throw MacVideoEncoderError.invalidSample }
    return (Array(parameterSets.prefix(3)), Int(nalUnitHeaderLength))
  }

  private func fail() {
    invalidate()
  }

  private static func setProperty(
    _ session: VTCompressionSession,
    key: CFString,
    value: Any
  ) {
    _ = VTSessionSetProperty(session, key: key, value: value as CFTypeRef)
  }

  private func withLock<T>(_ body: () -> T) -> T {
    lock.lock()
    defer { lock.unlock() }
    return body()
  }
}
