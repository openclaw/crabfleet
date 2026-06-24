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

struct CapturedDisplayDescriptor: Equatable, Sendable {
  let displayID: CGDirectDisplayID
  let displayBounds: CGRect
  let frameWidth: Int
  let frameHeight: Int
}

final class MacScreenCapture: NSObject, @unchecked Sendable {
  let frameStore = CapturedDesktopFrameStore()

  private let captureQueue = DispatchQueue(
    label: "org.openclaw.crabfleet.screen-capture",
    qos: .userInteractive
  )
  private let imageContext = CIContext(options: [
    .cacheIntermediates: false
  ])
  private let frameLock = NSLock()
  private var sequence: UInt64 = 0
  private var consumerActive = false
  private var stream: SCStream?

  func start() async throws -> CapturedDisplayDescriptor {
    guard CGPreflightScreenCaptureAccess() else {
      throw PrivateMacShareError.screenRecordingDenied
    }

    let displayID = CGMainDisplayID()
    let shareableContent = try await SCShareableContent.current
    guard let display = shareableContent.displays.first(where: { $0.displayID == displayID }) else {
      throw PrivateMacShareError.captureUnavailable
    }

    let dimensions = Self.captureDimensions(
      sourceWidth: display.width, sourceHeight: display.height)
    let configuration = SCStreamConfiguration()
    configuration.width = dimensions.width
    configuration.height = dimensions.height
    configuration.pixelFormat = kCVPixelFormatType_32BGRA
    configuration.minimumFrameInterval = CMTime(value: 1, timescale: 15)
    configuration.queueDepth = 3
    configuration.showsCursor = true
    configuration.capturesAudio = false
    configuration.colorSpaceName = CGColorSpace.sRGB

    let filter = SCContentFilter(display: display, excludingWindows: [])
    let stream = SCStream(filter: filter, configuration: configuration, delegate: self)
    try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: captureQueue)
    try await stream.startCapture()
    self.stream = stream

    return CapturedDisplayDescriptor(
      displayID: displayID,
      displayBounds: CGDisplayBounds(displayID),
      frameWidth: dimensions.width,
      frameHeight: dimensions.height
    )
  }

  func stop() async {
    guard let stream else { return }
    self.stream = nil
    try? await stream.stopCapture()
    await frameStore.clear()
  }

  func setConsumerActive(_ isActive: Bool) {
    frameLock.lock()
    consumerActive = isActive
    frameLock.unlock()
  }

  static func captureDimensions(sourceWidth: Int, sourceHeight: Int) -> (
    width: Int,
    height: Int
  ) {
    let maximumWidth = 1_600.0
    let maximumHeight = 1_000.0
    let width = max(Double(sourceWidth), 1)
    let height = max(Double(sourceHeight), 1)
    let scale = min(1, maximumWidth / width, maximumHeight / height)
    let scaledWidth = max(2, Int((width * scale).rounded(.down)) & ~1)
    let scaledHeight = max(2, Int((height * scale).rounded(.down)) & ~1)
    return (scaledWidth, scaledHeight)
  }

  private func nextSequence() -> UInt64 {
    frameLock.lock()
    defer { frameLock.unlock() }
    sequence &+= 1
    return sequence
  }

  private func shouldEncodeFrame() -> Bool {
    frameLock.lock()
    defer { frameLock.unlock() }
    return consumerActive
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
      let pixelBuffer = sampleBuffer.imageBuffer,
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
