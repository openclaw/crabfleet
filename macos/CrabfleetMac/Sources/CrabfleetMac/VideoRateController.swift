import Foundation

enum ShareQualityMode: String, CaseIterable, Identifiable, Sendable {
  case auto
  case sharp
  case smooth

  var id: String { rawValue }

  var title: String {
    switch self {
    case .auto: "Auto"
    case .sharp: "Sharp"
    case .smooth: "Smooth"
    }
  }

  var bitrateFloor: Int {
    switch self {
    case .auto, .smooth: 1_500_000
    case .sharp: 8_000_000
    }
  }

  var bitrateCeiling: Int {
    switch self {
    case .auto: 30_000_000
    case .sharp: 40_000_000
    case .smooth: 20_000_000
    }
  }

  var framesPerSecond: Int {
    switch self {
    case .auto, .smooth: 60
    case .sharp: 30
    }
  }

  var maximumFrameQP: Int? {
    switch self {
    case .auto: 40
    case .sharp: 30
    case .smooth: nil
    }
  }

  var settlesStaticContent: Bool { self != .smooth }
}

struct VideoIdleRefreshPolicy: Sendable {
  private var lastDirtyTimestamp: Double
  private var hasSentRefresh = false

  init(timestamp: Double) {
    lastDirtyTimestamp = timestamp
  }

  mutating func recordDirtyArea(_ fraction: Double, timestamp: Double) {
    guard fraction > 0 else { return }
    lastDirtyTimestamp = timestamp
    hasSentRefresh = false
  }

  mutating func shouldRefresh(mode: ShareQualityMode, timestamp: Double) -> Bool {
    guard mode.settlesStaticContent, !hasSentRefresh,
      timestamp - lastDirtyTimestamp >= 2
    else { return false }
    hasSentRefresh = true
    return true
  }

  mutating func refreshFailed() {
    hasSentRefresh = false
  }
}

struct VideoRateController: Sendable {
  private struct FrameMeasurement: Sendable {
    let byteCount: Int
    let dirtyAreaFraction: Double
    let timestamp: Double
  }

  private static let ewmaAlpha = 0.2

  private(set) var mode: ShareQualityMode
  private(set) var averageBitrate: Int
  private(set) var throughputEWMA: Double?
  private(set) var sendLatencyEWMA: Double?
  private(set) var dirtyAreaFractionEWMA: Double?
  private var clearSince: Double?
  private var lastAdjustmentTimestamp = -Double.infinity
  private var measurements: [FrameMeasurement] = []

  init(mode: ShareQualityMode = .auto) {
    self.mode = mode
    averageBitrate = min(max(8_000_000, mode.bitrateFloor), mode.bitrateCeiling)
  }

  var targetBitrate: Int { averageBitrate }

  @discardableResult
  mutating func setMode(_ mode: ShareQualityMode) -> Int {
    self.mode = mode
    clearSince = nil
    averageBitrate = min(max(averageBitrate, mode.bitrateFloor), mode.bitrateCeiling)
    return averageBitrate
  }

  mutating func recordFrame(
    byteCount: Int,
    sendSeconds: Double,
    dirtyAreaFraction: Double = 1,
    timestamp: Double
  ) -> Int? {
    let bytes = max(0, byteCount)
    let latency = max(0, sendSeconds)
    let dirty = min(max(dirtyAreaFraction, 0), 1)
    measurements.append(
      FrameMeasurement(byteCount: bytes, dirtyAreaFraction: dirty, timestamp: timestamp))
    measurements.removeAll { $0.timestamp < timestamp - 2 }

    if latency > 0 {
      throughputEWMA = ewma(
        previous: throughputEWMA,
        sample: Double(bytes) * 8 / latency)
    }
    sendLatencyEWMA = ewma(previous: sendLatencyEWMA, sample: latency)
    dirtyAreaFractionEWMA = ewma(previous: dirtyAreaFractionEWMA, sample: dirty)

    guard let latencyEWMA = sendLatencyEWMA else { return nil }
    if latencyEWMA > 0.05 {
      clearSince = nil
      guard timestamp - lastAdjustmentTimestamp >= 1, let throughputEWMA else { return nil }
      lastAdjustmentTimestamp = timestamp
      let measuredTarget = Int(throughputEWMA * 0.8)
      let target = min(
        averageBitrate,
        min(max(measuredTarget, mode.bitrateFloor), mode.bitrateCeiling))
      guard target != averageBitrate else { return nil }
      averageBitrate = target
      return target
    }

    guard latencyEWMA < 0.02 else {
      clearSince = nil
      return nil
    }
    if clearSince == nil {
      clearSince = timestamp
      return nil
    }
    guard timestamp - (clearSince ?? timestamp) >= 1,
      timestamp - lastAdjustmentTimestamp >= 1
    else { return nil }

    clearSince = timestamp
    lastAdjustmentTimestamp = timestamp
    let dirtyScale = dirtyAreaFractionEWMA ?? dirty
    let increment = Int(1_000_000 * dirtyScale)
    guard increment > 0 else { return nil }
    let target = min(mode.bitrateCeiling, averageBitrate + increment)
    guard target != averageBitrate else { return nil }
    averageBitrate = target
    return target
  }

  func statsSnapshot(now: Double) -> (
    fps: Double,
    megabitsPerSecond: Double,
    dirtyAreaPercent: Double
  ) {
    let recent = measurements.filter { $0.timestamp >= now - 2 && $0.timestamp <= now }
    let bytes = recent.reduce(0) { $0 + $1.byteCount }
    let dirtyArea = recent.isEmpty
      ? 0
      : recent.reduce(0) { $0 + $1.dirtyAreaFraction } / Double(recent.count)
    return (
      fps: Double(recent.count) / 2,
      megabitsPerSecond: Double(bytes) * 8 / 2 / 1_000_000,
      dirtyAreaPercent: dirtyArea * 100
    )
  }

  private func ewma(previous: Double?, sample: Double) -> Double {
    guard let previous else { return sample }
    return Self.ewmaAlpha * sample + (1 - Self.ewmaAlpha) * previous
  }
}
