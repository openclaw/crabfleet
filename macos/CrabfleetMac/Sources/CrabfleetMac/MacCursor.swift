import AppKit
import CoreGraphics
import CryptoKit
import Foundation

struct RFBCursorImage: Equatable, Sendable {
  static let maximumDimension = 128

  let width: Int
  let height: Int
  let hotspotX: Int
  let hotspotY: Int
  let rgba: Data

  func validate() throws {
    guard
      (1...Self.maximumDimension).contains(width),
      (1...Self.maximumDimension).contains(height),
      (0..<width).contains(hotspotX),
      (0..<height).contains(hotspotY),
      rgba.count == width * height * 4
    else {
      throw PrivateMacShareError.protocolError("invalid cursor image")
    }
  }

  var contentHash: Data {
    var payload = Data()
    payload.appendBigEndian(UInt16(width))
    payload.appendBigEndian(UInt16(height))
    payload.appendBigEndian(UInt16(hotspotX))
    payload.appendBigEndian(UInt16(hotspotY))
    payload.append(rgba)
    return Data(SHA256.hash(data: payload))
  }
}

struct SystemCursorSnapshot: Equatable, Sendable {
  let image: SystemCursorImage?
  let position: CGPoint
}

struct SystemCursorImage: Equatable, Sendable {
  let width: Int
  let height: Int
  let pointWidth: CGFloat
  let pointHeight: CGFloat
  let hotspot: CGPoint
  let rgba: Data
  let contentHash: Data
}

struct CursorCaptureNegotiationState: Equatable, Sendable {
  private(set) var sessions: [UUID: Bool] = [:]

  var showsCursor: Bool {
    sessions.isEmpty || sessions.values.contains(false)
  }

  mutating func join(_ id: UUID) {
    sessions[id] = false
  }

  mutating func setNegotiated(_ negotiated: Bool, for id: UUID) {
    guard sessions[id] != nil else { return }
    sessions[id] = negotiated
  }

  mutating func leave(_ id: UUID) {
    sessions.removeValue(forKey: id)
  }
}

struct CursorImageDeduplicator: Sendable {
  private(set) var lastHash: Data?

  mutating func shouldSend(hash: Data) -> Bool {
    guard lastHash != hash else { return false }
    lastHash = hash
    return true
  }
}

enum CursorEchoPolicy {
  static let suppressionWindow: TimeInterval = 0.25

  static func shouldSendPointerPosition(
    positionChanged: Bool,
    lastLocalInput: TimeInterval?,
    now: TimeInterval
  ) -> Bool {
    guard positionChanged else { return false }
    guard let lastLocalInput else { return true }
    return now - lastLocalInput >= suppressionWindow
  }
}

enum CursorCoordinateMapper {
  static func pointerPosition(
    _ position: CGPoint,
    descriptor: CapturedDisplayDescriptor,
    frameWidth: Int,
    frameHeight: Int
  ) -> (x: UInt16, y: UInt16)? {
    guard frameWidth > 0, frameHeight > 0,
      frameWidth <= Int(UInt16.max) + 1, frameHeight <= Int(UInt16.max) + 1,
      descriptor.displayBounds.width > 0, descriptor.displayBounds.height > 0,
      descriptor.displayBounds.contains(position)
    else { return nil }
    let width = frameWidth - 1
    let height = frameHeight - 1
    let xRatio = min(max((position.x - descriptor.displayBounds.minX) / descriptor.displayBounds.width, 0), 1)
    let yRatio = min(max((position.y - descriptor.displayBounds.minY) / descriptor.displayBounds.height, 0), 1)
    return (
      UInt16(min(width, max(0, Int((xRatio * CGFloat(width)).rounded())))),
      UInt16(min(height, max(0, Int((yRatio * CGFloat(height)).rounded()))))
    )
  }

  static func cursorImage(
    _ image: SystemCursorImage,
    descriptor: CapturedDisplayDescriptor,
    frameWidth: Int,
    frameHeight: Int
  ) -> RFBCursorImage? {
    guard descriptor.displayBounds.width > 0, descriptor.displayBounds.height > 0 else { return nil }
    let targetWidth = min(
      RFBCursorImage.maximumDimension,
      max(1, Int((image.pointWidth * CGFloat(frameWidth) / descriptor.displayBounds.width).rounded())))
    let targetHeight = min(
      RFBCursorImage.maximumDimension,
      max(1, Int((image.pointHeight * CGFloat(frameHeight) / descriptor.displayBounds.height).rounded())))
    guard let rgba = resizeRGBA(
      image.rgba,
      sourceWidth: image.width,
      sourceHeight: image.height,
      targetWidth: targetWidth,
      targetHeight: targetHeight)
    else { return nil }
    let hotspotX = min(
      targetWidth - 1,
      max(0, Int((image.hotspot.x / max(image.pointWidth, 1) * CGFloat(targetWidth)).rounded())))
    let hotspotY = min(
      targetHeight - 1,
      max(0, Int((image.hotspot.y / max(image.pointHeight, 1) * CGFloat(targetHeight)).rounded())))
    return RFBCursorImage(
      width: targetWidth,
      height: targetHeight,
      hotspotX: hotspotX,
      hotspotY: hotspotY,
      rgba: rgba)
  }

  private static func resizeRGBA(
    _ source: Data,
    sourceWidth: Int,
    sourceHeight: Int,
    targetWidth: Int,
    targetHeight: Int
  ) -> Data? {
    guard source.count == sourceWidth * sourceHeight * 4 else { return nil }
    if sourceWidth == targetWidth, sourceHeight == targetHeight { return source }
    var target = Data(repeating: 0, count: targetWidth * targetHeight * 4)
    target.withUnsafeMutableBytes { targetBytes in
      source.withUnsafeBytes { sourceBytes in
        guard let targetBase = targetBytes.baseAddress?.assumingMemoryBound(to: UInt8.self),
          let sourceBase = sourceBytes.baseAddress?.assumingMemoryBound(to: UInt8.self)
        else { return }
        for y in 0..<targetHeight {
          let sourceY = min(sourceHeight - 1, y * sourceHeight / targetHeight)
          for x in 0..<targetWidth {
            let sourceX = min(sourceWidth - 1, x * sourceWidth / targetWidth)
            let sourceOffset = (sourceY * sourceWidth + sourceX) * 4
            let targetOffset = (y * targetWidth + x) * 4
            targetBase[targetOffset] = sourceBase[sourceOffset]
            targetBase[targetOffset + 1] = sourceBase[sourceOffset + 1]
            targetBase[targetOffset + 2] = sourceBase[sourceOffset + 2]
            targetBase[targetOffset + 3] = sourceBase[sourceOffset + 3]
          }
        }
      }
    }
    return target
  }
}

final class MacCursorMonitor: @unchecked Sendable {
  typealias Handler = @Sendable (SystemCursorSnapshot) -> Void

  private let queue = DispatchQueue(
    label: "org.openclaw.crabfleet.cursor-poll",
    qos: .userInteractive)
  private let lock = NSLock()
  private var handlers: [UUID: Handler] = [:]
  private var latestSnapshot: SystemCursorSnapshot?
  private var timer: DispatchSourceTimer?
  private var pollInFlight = false
  private var generation: UInt64 = 0

  func start() {
    let shouldStart = withLock { () -> Bool in
      guard timer == nil else { return false }
      generation &+= 1
      let timer = DispatchSource.makeTimerSource(queue: queue)
      timer.schedule(deadline: .now(), repeating: .nanoseconds(16_666_667), leeway: .milliseconds(1))
      timer.setEventHandler { [weak self] in self?.poll() }
      self.timer = timer
      timer.resume()
      return true
    }
    if !shouldStart { return }
  }

  func stop() {
    let timer = withLock { () -> DispatchSourceTimer? in
      defer {
        generation &+= 1
        self.timer = nil
        latestSnapshot = nil
        handlers.removeAll()
      }
      return self.timer
    }
    timer?.setEventHandler {}
    timer?.cancel()
  }

  func addHandler(id: UUID, handler: @escaping Handler) {
    let latest = withLock { () -> SystemCursorSnapshot? in
      handlers[id] = handler
      return latestSnapshot
    }
    if let latest { handler(latest) }
  }

  func removeHandler(id: UUID) {
    withLock { handlers.removeValue(forKey: id) }
  }

  func currentSnapshot() -> SystemCursorSnapshot? {
    withLock { latestSnapshot }
  }

  private func poll() {
    let pollGeneration = withLock { () -> UInt64? in
      guard timer != nil, !handlers.isEmpty, !pollInFlight else { return nil }
      pollInFlight = true
      return generation
    }
    guard let pollGeneration else { return }
    Task { @MainActor [weak self] in
      let snapshot = Self.captureSnapshot()
      self?.queue.async { [weak self] in
        self?.publish(snapshot, generation: pollGeneration)
      }
    }
  }

  @MainActor
  private static func captureSnapshot() -> SystemCursorSnapshot? {
    guard let event = CGEvent(source: nil) else { return nil }
    return SystemCursorSnapshot(
      image: NSCursor.currentSystem.flatMap(render),
      position: event.location)
  }

  private func publish(_ snapshot: SystemCursorSnapshot?, generation pollGeneration: UInt64) {
    let currentHandlers = withLock { () -> [Handler] in
      pollInFlight = false
      guard timer != nil, generation == pollGeneration, let snapshot else { return [] }
      latestSnapshot = snapshot
      return Array(handlers.values)
    }
    guard let snapshot else { return }
    for handler in currentHandlers { handler(snapshot) }
  }

  @MainActor
  private static func render(_ cursor: NSCursor) -> SystemCursorImage? {
    let image = cursor.image
    var proposedRect = CGRect(origin: .zero, size: image.size)
    guard image.size.width > 0, image.size.height > 0,
      let source = image.cgImage(forProposedRect: &proposedRect, context: nil, hints: nil)
    else { return nil }
    let scale = min(
      1,
      CGFloat(RFBCursorImage.maximumDimension) / CGFloat(source.width),
      CGFloat(RFBCursorImage.maximumDimension) / CGFloat(source.height))
    let width = max(1, Int((CGFloat(source.width) * scale).rounded(.down)))
    let height = max(1, Int((CGFloat(source.height) * scale).rounded(.down)))
    var rgba = Data(repeating: 0, count: width * height * 4)
    let rendered = rgba.withUnsafeMutableBytes { bytes -> Bool in
      guard let baseAddress = bytes.baseAddress,
        let context = CGContext(
          data: baseAddress,
          width: width,
          height: height,
          bitsPerComponent: 8,
          bytesPerRow: width * 4,
          space: CGColorSpaceCreateDeviceRGB(),
          bitmapInfo: CGBitmapInfo.byteOrder32Big.rawValue
            | CGImageAlphaInfo.premultipliedLast.rawValue)
      else { return false }
      context.interpolationQuality = .high
      context.translateBy(x: 0, y: CGFloat(height))
      context.scaleBy(x: 1, y: -1)
      context.draw(source, in: CGRect(x: 0, y: 0, width: width, height: height))
      return true
    }
    guard rendered else { return nil }

    var hashPayload = Data()
    hashPayload.appendBigEndian(UInt16(width))
    hashPayload.appendBigEndian(UInt16(height))
    hashPayload.append(rgba)
    return SystemCursorImage(
      width: width,
      height: height,
      pointWidth: image.size.width,
      pointHeight: image.size.height,
      hotspot: cursor.hotSpot,
      rgba: rgba,
      contentHash: Data(SHA256.hash(data: hashPayload)))
  }

  @discardableResult
  private func withLock<T>(_ body: () -> T) -> T {
    lock.lock()
    defer { lock.unlock() }
    return body()
  }
}
