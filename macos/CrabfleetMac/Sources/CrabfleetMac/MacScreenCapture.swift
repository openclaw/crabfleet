import AppKit
import CoreImage
import Foundation
import ImageIO
import ScreenCaptureKit
import UniformTypeIdentifiers

struct CapturedDesktopFrame: Sendable {
  let jpegData: Data
  let sequence: UInt64
  let width: Int
  let height: Int
}

actor CapturedDesktopFrameStore {
  private var latestFrame: CapturedDesktopFrame?

  func update(_ frame: CapturedDesktopFrame) {
    guard frame.sequence >= (latestFrame?.sequence ?? 0) else { return }
    latestFrame = frame
  }

  func latest() -> CapturedDesktopFrame? {
    latestFrame
  }

  func clear() {
    latestFrame = nil
  }
}

private actor CaptureConfigurationGate {
  private var tail = Task<Void, Never> {}

  func run<T: Sendable>(
    _ operation: @escaping @Sendable () async throws -> T
  ) async throws -> T {
    let predecessor = tail
    let result = Task<Result<T, Error>, Never> {
      await predecessor.value
      do {
        return .success(try await operation())
      } catch {
        return .failure(error)
      }
    }
    tail = Task { _ = await result.value }
    return try await result.value.get()
  }
}

/// A captured frame handed from the ScreenCaptureKit callback to the encode
/// path. CVPixelBuffer is thread-safe to retain and read across queues.
struct VideoPixelSource: @unchecked Sendable {
  let pixelBuffer: CVPixelBuffer
  let presentationTime: CMTime
  let dirtyRects: [CGRect]?
  let contentRect: CGRect?

  var dirtyAreaFraction: Double {
    MacScreenCapture.dirtyAreaFraction(
      dirtyRects: dirtyRects,
      contentRect: contentRect
        ?? CGRect(
          x: 0,
          y: 0,
          width: CVPixelBufferGetWidth(pixelBuffer),
          height: CVPixelBufferGetHeight(pixelBuffer)))
  }
}

struct CapturedDisplayDescriptor: Equatable, Sendable {
  let displayID: CGDirectDisplayID
  let displayBounds: CGRect
  let frameWidth: Int
  let frameHeight: Int
  let sourcePixelWidth: Int
  let sourcePixelHeight: Int
}

struct ShareableDisplayOption: Identifiable, Equatable, Sendable {
  let id: CGDirectDisplayID
  let label: String
  let width: Int
  let height: Int

  var detail: String {
    "\(label) · \(width)×\(height)"
  }
}

final class MacScreenCapture: NSObject, @unchecked Sendable {
  let frameStore = CapturedDesktopFrameStore()
  private let cursorMonitor = MacCursorMonitor()

  private let captureQueue = DispatchQueue(
    label: "org.openclaw.crabfleet.screen-capture",
    qos: .userInteractive
  )
  private let audioCaptureQueue = DispatchQueue(
    label: "org.openclaw.crabfleet.audio-capture",
    qos: .userInteractive
  )
  private let imageContext = CIContext(options: [
    .cacheIntermediates: false
  ])
  private let frameLock = NSLock()
  private let configurationGate = CaptureConfigurationGate()
  private var sequence: UInt64 = 0
  private var consumerIDs: Set<UUID> = []
  private var audioConsumerIDs: Set<UUID> = []
  private var cursorNegotiationState = CursorCaptureNegotiationState()
  private var cursorReconcileTask: Task<Void, Never>?
  private var cursorReconcileGeneration: UInt64 = 0
  private var videoFrameHandlers: [UUID: @Sendable (VideoPixelSource) -> Void] = [:]
  private var audioSampleHandlers: [UUID: @Sendable (CMSampleBuffer) -> Void] = [:]
  private var frameRateRequirements: [UUID: Int] = [:]
  private var appliedFrameRate = 15
  private var latestVideoSource: VideoPixelSource?
  private var stream: SCStream?
  private var configuration: SCStreamConfiguration?
  private var contentFilter: SCContentFilter?
  private var audioOutputAvailable = false

  static func availableDisplays() async -> [ShareableDisplayOption] {
    guard let shareableContent = try? await SCShareableContent.current else { return [] }
    return shareableContent.displays.enumerated().map { index, display in
      ShareableDisplayOption(
        id: display.displayID,
        label: Self.displayName(for: display.displayID) ?? "Display \(index + 1)",
        width: display.width,
        height: display.height
      )
    }
  }

  static func effectiveFrameRate<S: Sequence>(_ requirements: S) -> Int where S.Element == Int {
    max(requirements.max() ?? 15, 15)
  }

  func start(displayID requestedDisplayID: CGDirectDisplayID? = nil) async throws
    -> CapturedDisplayDescriptor
  {
    guard CGPreflightScreenCaptureAccess() else {
      throw PrivateMacShareError.screenRecordingDenied
    }

    let shareableContent = try await SCShareableContent.current
    // Fall back to the main display when a saved selection is disconnected.
    let display =
      shareableContent.displays.first(where: { $0.displayID == requestedDisplayID })
      ?? shareableContent.displays.first(where: { $0.displayID == CGMainDisplayID() })
    guard let display else {
      throw PrivateMacShareError.captureUnavailable
    }
    let displayID = display.displayID

    let sourcePixels = Self.sourcePixelDimensions(
      displayID: displayID,
      pointWidth: display.width,
      pointHeight: display.height
    )
    let dimensions = Self.captureDimensions(
      sourceWidth: display.width, sourceHeight: display.height)
    let configuration = SCStreamConfiguration()
    configuration.width = dimensions.width
    configuration.height = dimensions.height
    configuration.pixelFormat = kCVPixelFormatType_32BGRA
    configuration.minimumFrameInterval = CMTime(value: 1, timescale: 15)
    configuration.queueDepth = 3
    configuration.showsCursor = withFrameLock { cursorNegotiationState.showsCursor }
    configuration.capturesAudio = false
    configuration.excludesCurrentProcessAudio = true
    configuration.colorSpaceName = CGColorSpace.sRGB

    let filter = SCContentFilter(display: display, excludingWindows: [])
    let stream = SCStream(filter: filter, configuration: configuration, delegate: self)
    try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: captureQueue)
    let audioOutputAvailable: Bool
    do {
      try stream.addStreamOutput(self, type: .audio, sampleHandlerQueue: audioCaptureQueue)
      audioOutputAvailable = true
    } catch {
      audioOutputAvailable = false
    }
    try await stream.startCapture()
    do {
      try await configurationGate.run { [self] in
        let desiredShowsCursor = self.withFrameLock { self.cursorNegotiationState.showsCursor }
        if configuration.showsCursor != desiredShowsCursor {
          let previousShowsCursor = configuration.showsCursor
          configuration.showsCursor = desiredShowsCursor
          do {
            try await stream.updateConfiguration(configuration)
          } catch {
            configuration.showsCursor = previousShowsCursor
            throw error
          }
        }
        self.stream = stream
        self.configuration = configuration
        self.contentFilter = filter
        self.audioOutputAvailable = audioOutputAvailable
        self.withFrameLock { self.appliedFrameRate = 15 }
        self.cursorMonitor.start()
      }
    } catch {
      try? await stream.stopCapture()
      throw error
    }

    return CapturedDisplayDescriptor(
      displayID: displayID,
      displayBounds: CGDisplayBounds(displayID),
      frameWidth: dimensions.width,
      frameHeight: dimensions.height,
      sourcePixelWidth: sourcePixels.width,
      sourcePixelHeight: sourcePixels.height
    )
  }

  /// Re-targets the running stream to a new output size for remote-resize.
  func updateOutputSize(width: Int, height: Int) async throws {
    try await configurationGate.run { [self] in
      guard let stream, let configuration else {
        throw PrivateMacShareError.captureUnavailable
      }
      configuration.width = width
      configuration.height = height
      try await stream.updateConfiguration(configuration)
    }
  }

  func updateFrameIntervalRequirement(
    id: UUID,
    framesPerSecond: Int,
    shouldApply: @escaping @Sendable () -> Bool = { true }
  ) async throws {
    try await configurationGate.run { [self] in
      guard framesPerSecond > 0, let stream, let configuration else {
        throw PrivateMacShareError.captureUnavailable
      }
      guard shouldApply() else { return }
      let previous = withFrameLock { frameRateRequirements[id] }
      let nextMaximum = withFrameLock { () -> Int in
        frameRateRequirements[id] = framesPerSecond
        return Self.effectiveFrameRate(frameRateRequirements.values)
      }
      let previousApplied = withFrameLock { appliedFrameRate }
      guard previousApplied != nextMaximum else { return }
      configuration.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(nextMaximum))
      do {
        try await stream.updateConfiguration(configuration)
        withFrameLock { appliedFrameRate = nextMaximum }
      } catch {
        withFrameLock { frameRateRequirements[id] = previous }
        configuration.minimumFrameInterval = CMTime(
          value: 1, timescale: CMTimeScale(previousApplied))
        throw error
      }
    }
  }

  func removeFrameIntervalRequirement(id: UUID) async throws {
    try await configurationGate.run { [self] in
      let removed = withFrameLock { frameRateRequirements.removeValue(forKey: id) }
      guard removed != nil else { return }
      guard let stream, let configuration else { return }
      let nextMaximum = withFrameLock {
        Self.effectiveFrameRate(frameRateRequirements.values)
      }
      let previousApplied = withFrameLock { appliedFrameRate }
      guard previousApplied != nextMaximum else { return }
      configuration.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(nextMaximum))
      do {
        try await stream.updateConfiguration(configuration)
        withFrameLock { appliedFrameRate = nextMaximum }
      } catch {
        configuration.minimumFrameInterval = CMTime(
          value: 1, timescale: CMTimeScale(previousApplied))
        throw error
      }
    }
  }

  func retainAudioConsumer(id: UUID) async throws {
    try await configurationGate.run { [self] in
      guard let stream, let configuration else {
        throw PrivateMacShareError.captureUnavailable
      }
      if !audioOutputAvailable {
        throw PrivateMacShareError.captureUnavailable
      }
      let inserted = withFrameLock { audioConsumerIDs.insert(id).inserted }
      guard inserted else { return }
      guard !configuration.capturesAudio else { return }
      configuration.capturesAudio = true
      configuration.excludesCurrentProcessAudio = true
      do {
        try await stream.updateConfiguration(configuration)
      } catch {
        withFrameLock { audioConsumerIDs.remove(id) }
        configuration.capturesAudio = false
        throw error
      }
    }
  }

  func releaseAudioConsumer(id: UUID) async throws {
    try await configurationGate.run { [self] in
      guard let stream, let configuration else {
        withFrameLock { audioConsumerIDs.remove(id) }
        return
      }
      let removed = withFrameLock { audioConsumerIDs.remove(id) }
      guard removed != nil else { return }
      let shouldDisable = withFrameLock { audioConsumerIDs.isEmpty }
      guard shouldDisable, configuration.capturesAudio else { return }
      configuration.capturesAudio = false
      do {
        try await stream.updateConfiguration(configuration)
      } catch {
        configuration.capturesAudio = true
        throw error
      }
    }
  }

  func addCursorSession(id: UUID) async throws {
    try await updateCursorNegotiation(allowsStoppedCapture: true) { $0.join(id) }
  }

  func updateCursorSession(id: UUID, negotiated: Bool) async throws {
    try await updateCursorNegotiation(allowsStoppedCapture: true) {
      $0.setNegotiated(negotiated, for: id)
    }
  }

  func removeCursorSession(id: UUID) async throws {
    do {
      try await updateCursorNegotiation(
        allowsStoppedCapture: true,
        preservesMutationOnFailure: true
      ) { $0.leave(id) }
    } catch {
      scheduleCursorReconciliation()
      throw error
    }
  }

  func addCursorHandler(id: UUID, handler: @escaping MacCursorMonitor.Handler) {
    cursorMonitor.addHandler(id: id, handler: handler)
  }

  func removeCursorHandler(id: UUID) {
    cursorMonitor.removeHandler(id: id)
  }

  func currentCursorSnapshot() -> SystemCursorSnapshot? {
    cursorMonitor.currentSnapshot()
  }

  private func updateCursorNegotiation(
    allowsStoppedCapture: Bool = false,
    preservesMutationOnFailure: Bool = false,
    _ mutation: @escaping @Sendable (inout CursorCaptureNegotiationState) -> Void
  ) async throws {
    try await configurationGate.run { [self] in
      guard let stream, let configuration else {
        if allowsStoppedCapture {
          withFrameLock { mutation(&cursorNegotiationState) }
          return
        }
        throw PrivateMacShareError.captureUnavailable
      }
      let previous = withFrameLock { cursorNegotiationState }
      var next = previous
      mutation(&next)
      let previousShowsCursor = configuration.showsCursor
      withFrameLock { cursorNegotiationState = next }
      guard previousShowsCursor != next.showsCursor else { return }
      configuration.showsCursor = next.showsCursor
      do {
        try await stream.updateConfiguration(configuration)
      } catch {
        if !preservesMutationOnFailure {
          withFrameLock { cursorNegotiationState = previous }
        }
        configuration.showsCursor = previousShowsCursor
        throw error
      }
    }
  }

  private func scheduleCursorReconciliation() {
    let task = withFrameLock { () -> Task<Void, Never> in
      cursorReconcileGeneration &+= 1
      let generation = cursorReconcileGeneration
      cursorReconcileTask?.cancel()
      let task = Task { [weak self] in
        guard let self else { return }
        var delay = Duration.milliseconds(100)
        while !Task.isCancelled {
          do {
            try await self.reconcileCursorConfiguration()
            break
          } catch {
            try? await Task.sleep(for: delay)
            delay = min(delay * 2, .seconds(5))
          }
        }
        self.withFrameLock {
          if self.cursorReconcileGeneration == generation {
            self.cursorReconcileTask = nil
          }
        }
      }
      cursorReconcileTask = task
      return task
    }
    _ = task
  }

  private func reconcileCursorConfiguration() async throws {
    try await configurationGate.run { [self] in
      guard let stream, let configuration else { return }
      let desiredShowsCursor = withFrameLock { cursorNegotiationState.showsCursor }
      guard configuration.showsCursor != desiredShowsCursor else { return }
      let previousShowsCursor = configuration.showsCursor
      configuration.showsCursor = desiredShowsCursor
      do {
        try await stream.updateConfiguration(configuration)
      } catch {
        configuration.showsCursor = previousShowsCursor
        throw error
      }
    }
  }

  func stop() async {
    _ = try? await configurationGate.run { [self] in
      let stream = self.stream
      self.stream = nil
      self.configuration = nil
      self.contentFilter = nil
      self.audioOutputAvailable = false
      cursorMonitor.stop()
      withFrameLock {
        cursorReconcileGeneration &+= 1
        cursorReconcileTask?.cancel()
        cursorReconcileTask = nil
        consumerIDs.removeAll()
        audioConsumerIDs.removeAll()
        cursorNegotiationState = CursorCaptureNegotiationState()
        videoFrameHandlers.removeAll()
        audioSampleHandlers.removeAll()
        frameRateRequirements.removeAll()
        appliedFrameRate = 15
      }
      if let stream {
        try? await stream.stopCapture()
      }
      clearLatestVideoSource()
      await frameStore.clear()
    }
  }

  var showsCapturedCursor: Bool {
    withFrameLock { cursorNegotiationState.showsCursor }
  }

  func retainConsumer(id: UUID) {
    withFrameLock { consumerIDs.insert(id) }
  }

  func releaseConsumer(id: UUID) {
    withFrameLock {
      consumerIDs.remove(id)
      videoFrameHandlers.removeValue(forKey: id)
    }
  }

  func addVideoFrameHandler(
    id: UUID,
    handler: @escaping @Sendable (VideoPixelSource) -> Void
  ) {
    withFrameLock { videoFrameHandlers[id] = handler }
  }

  func removeVideoFrameHandler(id: UUID) {
    withFrameLock { videoFrameHandlers.removeValue(forKey: id) }
  }

  func addAudioSampleHandler(
    id: UUID,
    handler: @escaping @Sendable (CMSampleBuffer) -> Void
  ) {
    withFrameLock { audioSampleHandlers[id] = handler }
  }

  func removeAudioSampleHandler(id: UUID) {
    withFrameLock { audioSampleHandlers.removeValue(forKey: id) }
  }

  var activeConsumerCount: Int {
    withFrameLock { consumerIDs.count }
  }

  func deliverVideoFrame(_ source: VideoPixelSource) {
    for handler in currentVideoFrameHandlers() { handler(source) }
  }

  func latestVideoFrame() -> VideoPixelSource? {
    frameLock.lock()
    defer { frameLock.unlock() }
    return latestVideoSource
  }

  /// Renders a one-shot screenshot into the JPEG frame store. The store goes
  /// stale while a video handler consumes capture output, so the Tight path
  /// needs this after an H.264 fallback on a static screen.
  func refreshJPEGFrame() async -> Bool {
    guard let source = await snapshotVideoFrame(),
      let jpegData = encodeJPEG(source.pixelBuffer),
      jpegData.count <= 4 * 1_024 * 1_024
    else {
      return false
    }
    let frame = CapturedDesktopFrame(
      jpegData: jpegData,
      sequence: nextSequence(),
      width: CVPixelBufferGetWidth(source.pixelBuffer),
      height: CVPixelBufferGetHeight(source.pixelBuffer)
    )
    await frameStore.update(frame)
    return true
  }

  /// One-shot capture for when a frame is needed but the stream has nothing
  /// cached — a fresh session or resize on a static screen delivers no stream
  /// output until content changes.
  func snapshotVideoFrame() async -> VideoPixelSource? {
    let source = try? await configurationGate.run { [self] in
      guard let contentFilter, let configuration else {
        throw PrivateMacShareError.captureUnavailable
      }
      let sampleBuffer = try await SCScreenshotManager.captureSampleBuffer(
        contentFilter: contentFilter,
        configuration: configuration)
      guard let pixelBuffer = sampleBuffer.imageBuffer else {
        throw PrivateMacShareError.captureUnavailable
      }
      return VideoPixelSource(
        pixelBuffer: pixelBuffer,
        presentationTime: sampleBuffer.presentationTimeStamp,
        dirtyRects: nil,
        contentRect: CGRect(
          x: 0,
          y: 0,
          width: CVPixelBufferGetWidth(pixelBuffer),
          height: CVPixelBufferGetHeight(pixelBuffer)))
    }
    guard let source else { return nil }
    retainVideoSource(source)
    return source
  }

  static func captureDimensions(sourceWidth: Int, sourceHeight: Int) -> (
    width: Int,
    height: Int
  ) {
    let maximumWidth = 2_560.0
    let maximumHeight = 1_600.0
    let width = max(Double(sourceWidth), 1)
    let height = max(Double(sourceHeight), 1)
    let scale = min(1, maximumWidth / width, maximumHeight / height)
    let scaledWidth = max(2, Int((width * scale).rounded(.down)) & ~1)
    let scaledHeight = max(2, Int((height * scale).rounded(.down)) & ~1)
    return (scaledWidth, scaledHeight)
  }

  /// Aspect-fits the captured display into a client-requested framebuffer
  /// size, bounded by the display's native pixel resolution and a global cap.
  static func resizedDimensions(
    requestedWidth: Int,
    requestedHeight: Int,
    sourcePixelWidth: Int,
    sourcePixelHeight: Int,
    maximumWidth: Double = 2_560,
    maximumHeight: Double = 1_600
  ) -> (width: Int, height: Int) {
    let requestWidth = min(max(Double(requestedWidth), 320), maximumWidth)
    let requestHeight = min(max(Double(requestedHeight), 240), maximumHeight)
    let sourceWidth = max(Double(sourcePixelWidth), 1)
    let sourceHeight = max(Double(sourcePixelHeight), 1)
    let scale = min(1, requestWidth / sourceWidth, requestHeight / sourceHeight)
    let width = max(2, Int((sourceWidth * scale).rounded(.down)) & ~1)
    let height = max(2, Int((sourceHeight * scale).rounded(.down)) & ~1)
    return (width, height)
  }

  static func dirtyAreaFraction(
    dirtyRects: [CGRect]?,
    contentRect: CGRect?
  ) -> Double {
    guard let dirtyRects else { return 1 }
    guard !dirtyRects.isEmpty else { return 0 }
    guard let content = contentRect else { return 1 }
    guard content.width > 0, content.height > 0 else { return 1 }
    let dirtyArea = unionArea(of: dirtyRects, within: content)
    return min(max(dirtyArea / (content.width * content.height), 0), 1)
  }

  static func clippedContentRect(
    _ contentRect: CGRect?,
    pixelWidth: Int,
    pixelHeight: Int
  ) -> CGRect {
    let pixelBounds = CGRect(x: 0, y: 0, width: pixelWidth, height: pixelHeight)
    guard let contentRect else { return pixelBounds }
    let clipped = contentRect.intersection(pixelBounds)
    return clipped.isNull || clipped.isEmpty ? pixelBounds : clipped
  }

  private static func unionArea(of rects: [CGRect], within bounds: CGRect) -> Double {
    let clipped = rects.map { $0.intersection(bounds) }.filter { !$0.isNull && !$0.isEmpty }
    let xCoordinates = Set(clipped.flatMap { [$0.minX, $0.maxX] }).sorted()
    return zip(xCoordinates, xCoordinates.dropFirst()).reduce(0) { area, edges in
      let (minX, maxX) = edges
      guard maxX > minX else { return area }
      let intervals = clipped.filter { $0.minX < maxX && $0.maxX > minX }
        .map { ($0.minY, $0.maxY) }
        .sorted { $0.0 < $1.0 }
      guard let first = intervals.first else { return area }
      var coveredHeight = 0.0
      var current = first
      for interval in intervals.dropFirst() {
        if interval.0 <= current.1 {
          current.1 = max(current.1, interval.1)
        } else {
          coveredHeight += current.1 - current.0
          current = interval
        }
      }
      coveredHeight += current.1 - current.0
      return area + (maxX - minX) * coveredHeight
    }
  }

  static func shouldOfferVideoFrame(dirtyRects: [CGRect]?, keyframeOwed: Bool) -> Bool {
    keyframeOwed || dirtyRects?.isEmpty != true
  }

  static func attachmentRect(_ value: Any?) -> CGRect? {
    if let rect = value as? CGRect { return rect }
    guard let dictionary = value as? NSDictionary else { return nil }
    return CGRect(dictionaryRepresentation: dictionary as CFDictionary)
  }

  static func attachmentRects(_ value: Any?) -> [CGRect]? {
    if let rects = value as? [CGRect] { return rects }
    guard let values = value as? [Any] else { return nil }
    let rects = values.compactMap(attachmentRect)
    return rects.count == values.count ? rects : nil
  }

  private static func sourcePixelDimensions(
    displayID: CGDirectDisplayID,
    pointWidth: Int,
    pointHeight: Int
  ) -> (width: Int, height: Int) {
    guard let mode = CGDisplayCopyDisplayMode(displayID) else {
      return (pointWidth, pointHeight)
    }
    return (mode.pixelWidth, mode.pixelHeight)
  }

  private static func displayName(for displayID: CGDirectDisplayID) -> String? {
    for screen in NSScreen.screens {
      let key = NSDeviceDescriptionKey("NSScreenNumber")
      guard let number = screen.deviceDescription[key] as? NSNumber,
        number.uint32Value == displayID
      else {
        continue
      }
      return screen.localizedName
    }
    return nil
  }

  private func nextSequence() -> UInt64 {
    frameLock.lock()
    defer { frameLock.unlock() }
    sequence &+= 1
    return sequence
  }

  private func shouldEncodeFrame() -> Bool {
    withFrameLock { !consumerIDs.isEmpty }
  }

  private func currentVideoFrameHandlers() -> [@Sendable (VideoPixelSource) -> Void] {
    withFrameLock { Array(videoFrameHandlers.values) }
  }

  private func currentAudioSampleHandlers() -> [@Sendable (CMSampleBuffer) -> Void] {
    withFrameLock { Array(audioSampleHandlers.values) }
  }

  private func needsJPEGFrame() -> Bool {
    withFrameLock { consumerIDs.count > videoFrameHandlers.count }
  }

  private func retainVideoSource(_ source: VideoPixelSource) {
    frameLock.lock()
    latestVideoSource = source
    frameLock.unlock()
  }

  private func clearLatestVideoSource() {
    frameLock.lock()
    latestVideoSource = nil
    frameLock.unlock()
  }

  @discardableResult
  private func withFrameLock<T>(_ body: () -> T) -> T {
    frameLock.lock()
    defer { frameLock.unlock() }
    return body()
  }

  private func encodeJPEG(_ pixelBuffer: CVPixelBuffer) -> Data? {
    let width = CVPixelBufferGetWidth(pixelBuffer)
    let height = CVPixelBufferGetHeight(pixelBuffer)
    let image = CIImage(cvPixelBuffer: pixelBuffer)
    guard
      let cgImage = imageContext.createCGImage(
        image,
        from: CGRect(x: 0, y: 0, width: width, height: height)
      )
    else {
      return nil
    }

    let data = NSMutableData()
    guard
      let destination = CGImageDestinationCreateWithData(
        data,
        UTType.jpeg.identifier as CFString,
        1,
        nil
      )
    else {
      return nil
    }
    let properties =
      [
        kCGImageDestinationLossyCompressionQuality: 0.72
      ] as CFDictionary
    CGImageDestinationAddImage(destination, cgImage, properties)
    guard CGImageDestinationFinalize(destination) else { return nil }
    return data as Data
  }
}

extension MacScreenCapture: SCStreamOutput, SCStreamDelegate {
  func stream(
    _ stream: SCStream,
    didOutputSampleBuffer sampleBuffer: CMSampleBuffer,
    of outputType: SCStreamOutputType
  ) {
    if outputType == .audio {
      guard sampleBuffer.isValid else { return }
      for handler in currentAudioSampleHandlers() { handler(sampleBuffer) }
      return
    }
    guard
      outputType == .screen,
      sampleBuffer.isValid,
      shouldEncodeFrame(),
      let attachmentsArray = CMSampleBufferGetSampleAttachmentsArray(
        sampleBuffer,
        createIfNecessary: false
      ) as? [[SCStreamFrameInfo: Any]],
      let attachments = attachmentsArray.first,
      let statusRawValue = attachments[.status] as? Int,
      SCFrameStatus(rawValue: statusRawValue) == .complete,
      let pixelBuffer = sampleBuffer.imageBuffer
    else {
      return
    }

    let dirtyRects = Self.attachmentRects(attachments[.dirtyRects])
    let contentRect = Self.clippedContentRect(
      Self.attachmentRect(attachments[.contentRect]),
      pixelWidth: CVPixelBufferGetWidth(pixelBuffer),
      pixelHeight: CVPixelBufferGetHeight(pixelBuffer))
    let source = VideoPixelSource(
      pixelBuffer: pixelBuffer,
      presentationTime: sampleBuffer.presentationTimeStamp,
      dirtyRects: dirtyRects,
      contentRect: contentRect)
    retainVideoSource(source)

    deliverVideoFrame(source)

    guard needsJPEGFrame(),
      let jpegData = encodeJPEG(pixelBuffer),
      jpegData.count <= 4 * 1_024 * 1_024
    else {
      return
    }

    let frame = CapturedDesktopFrame(
      jpegData: jpegData,
      sequence: nextSequence(),
      width: CVPixelBufferGetWidth(pixelBuffer),
      height: CVPixelBufferGetHeight(pixelBuffer)
    )
    Task { await frameStore.update(frame) }
  }
}
