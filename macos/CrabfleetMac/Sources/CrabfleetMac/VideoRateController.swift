import Foundation

struct VideoRateController: Sendable {
  private struct FrameMeasurement: Sendable {
    let byteCount: Int
    let timestamp: Double
  }

  private(set) var averageBitrate = 8_000_000
  private var fastFrameStreak = 0
  private var lastDecreaseTimestamp = -Double.infinity
  private var measurements: [FrameMeasurement] = []

  mutating func recordFrame(
    byteCount: Int,
    sendSeconds: Double,
    timestamp: Double
  ) -> Int? {
    measurements.append(
      FrameMeasurement(byteCount: max(0, byteCount), timestamp: timestamp))
    measurements.removeAll { $0.timestamp < timestamp - 2 }

    if sendSeconds > 0.08 {
      fastFrameStreak = 0
      guard timestamp - lastDecreaseTimestamp >= 1 else { return nil }
      lastDecreaseTimestamp = timestamp
      let bitrate = max(1_500_000, averageBitrate * 7 / 10)
      guard bitrate != averageBitrate else { return nil }
      averageBitrate = bitrate
      return bitrate
    }

    if sendSeconds < 0.025 {
      fastFrameStreak += 1
    } else {
      fastFrameStreak = 0
    }

    guard fastFrameStreak >= 60 else { return nil }
    fastFrameStreak = 0
    let bitrate = min(30_000_000, averageBitrate * 11 / 10)
    guard bitrate != averageBitrate else { return nil }
    averageBitrate = bitrate
    return bitrate
  }

  func statsSnapshot(now: Double) -> (fps: Double, megabitsPerSecond: Double) {
    let recent = measurements.filter { $0.timestamp >= now - 2 && $0.timestamp <= now }
    let bytes = recent.reduce(0) { $0 + $1.byteCount }
    return (
      fps: Double(recent.count) / 2,
      megabitsPerSecond: Double(bytes) * 8 / 2 / 1_000_000
    )
  }
}
