import Foundation
import Testing

@testable import CrabfleetMac

struct VideoPipelineTests {
  @Test
  func openH264UpdateMatchesWireFormat() throws {
    let payload = Data([0, 0, 0, 1, 0x65, 0xAA])
    let update = try RFBWire.openH264Update(
      width: 1_280,
      height: 720,
      payload: payload,
      flags: 0x2)

    #expect(
      update == Data([
        0, 0, 0, 1,
        0, 0, 0, 0, 0x05, 0x00, 0x02, 0xD0,
        0, 0, 0, 50,
        0, 0, 0, 6,
        0, 0, 0, 2,
        0, 0, 0, 1, 0x65, 0xAA,
      ]))
  }

  @Test
  func openH264UpdateRejectsInvalidFrames() {
    #expect(throws: (any Error).self) {
      _ = try RFBWire.openH264Update(width: 1, height: 1, payload: Data(), flags: 0)
    }
    #expect(throws: (any Error).self) {
      _ = try RFBWire.openH264Update(
        width: 1, height: 1, payload: Data(count: 16 * 1_024 * 1_024), flags: 0)
    }
    #expect(throws: (any Error).self) {
      _ = try RFBWire.openH264Update(
        width: Int(UInt16.max) + 1, height: 1, payload: Data([1]), flags: 0)
    }
  }

  @Test
  func convertsLengthPrefixedNALUnitsToAnnexB() throws {
    let input = Data([0, 0, 0, 2, 0x41, 0x01, 0, 0, 0, 3, 0x65, 0x02, 0x03])
    let output = try MacVideoEncoder.annexBData(
      lengthPrefixedData: input,
      nalUnitHeaderLength: 4)

    #expect(
      output == Data([
        0, 0, 0, 1, 0x41, 0x01,
        0, 0, 0, 1, 0x65, 0x02, 0x03,
      ]))
  }

  @Test
  func keyframeConversionPrependsParameterSets() throws {
    let output = try MacVideoEncoder.annexBData(
      lengthPrefixedData: Data([0, 2, 0x65, 0x09]),
      nalUnitHeaderLength: 2,
      parameterSets: [Data([0x67, 0x64]), Data([0x68, 0xEE])],
      isKeyframe: true)

    #expect(
      output == Data([
        0, 0, 0, 1, 0x67, 0x64,
        0, 0, 0, 1, 0x68, 0xEE,
        0, 0, 0, 1, 0x65, 0x09,
      ]))
  }

  @Test
  func keyframePolicyRecoversDropsAndForcesPeriodicIDRs() {
    var recovery = VideoKeyframePolicy()
    var decision = recovery.shouldForceKeyframe(
      explicit: false, recovery: true, presentationSeconds: 1)
    #expect(decision)

    var frameInterval = VideoKeyframePolicy()
    for frame in 0..<1_799 {
      decision = frameInterval.shouldForceKeyframe(
        explicit: false,
        recovery: false,
        presentationSeconds: Double(frame) / 60)
      #expect(!decision)
    }
    decision = frameInterval.shouldForceKeyframe(
      explicit: false, recovery: false, presentationSeconds: 30)
    #expect(decision)

    var timeInterval = VideoKeyframePolicy()
    decision = timeInterval.shouldForceKeyframe(
      explicit: false, recovery: false, presentationSeconds: 10)
    #expect(!decision)
    decision = timeInterval.shouldForceKeyframe(
      explicit: false, recovery: false, presentationSeconds: 40)
    #expect(decision)
  }

  @Test
  func rateControllerDecreasesWithCooldownAndFloor() {
    var controller = VideoRateController()
    #expect(controller.recordFrame(byteCount: 1, sendSeconds: 0.09, timestamp: 0) == 5_600_000)
    #expect(controller.recordFrame(byteCount: 1, sendSeconds: 0.09, timestamp: 0.5) == nil)
    #expect(controller.recordFrame(byteCount: 1, sendSeconds: 0.09, timestamp: 1) == 3_920_000)
    _ = controller.recordFrame(byteCount: 1, sendSeconds: 0.09, timestamp: 2)
    _ = controller.recordFrame(byteCount: 1, sendSeconds: 0.09, timestamp: 3)
    #expect(controller.recordFrame(byteCount: 1, sendSeconds: 0.09, timestamp: 4) == 1_500_000)
    #expect(controller.recordFrame(byteCount: 1, sendSeconds: 0.09, timestamp: 5) == nil)
    #expect(controller.averageBitrate == 1_500_000)
  }

  @Test
  func rateControllerIncreasesAfterSixtyFastFramesAndCaps() {
    var controller = VideoRateController()
    var change: Int?
    for frame in 0..<60 {
      change = controller.recordFrame(
        byteCount: 1,
        sendSeconds: 0.01,
        timestamp: Double(frame) / 60)
    }
    #expect(change == 8_800_000)

    for cycle in 1...20 {
      for frame in 0..<60 {
        _ = controller.recordFrame(
          byteCount: 1,
          sendSeconds: 0.01,
          timestamp: Double(cycle) + Double(frame) / 60)
      }
    }
    #expect(controller.averageBitrate == 30_000_000)
  }

  @Test
  func rateControllerReportsTwoSecondWindow() {
    var controller = VideoRateController()
    for timestamp in [0.5, 1.0, 2.0, 2.5] {
      _ = controller.recordFrame(
        byteCount: 250_000,
        sendSeconds: 0.04,
        timestamp: timestamp)
    }
    let stats = controller.statsSnapshot(now: 2.5)
    #expect(stats.fps == 2)
    #expect(stats.megabitsPerSecond == 4)
  }

  @Test
  func emptyUpdateIsARectangleFreeFramebufferUpdate() {
    #expect(RFBWire.emptyUpdate() == Data([0, 0, 0, 0]))
  }

  @Test
  func mailboxDeliversPendingElementImmediately() async {
    let mailbox = VideoMailbox<Int>()
    mailbox.offer(7)
    #expect(await mailbox.next(timeout: .milliseconds(10)) == 7)
  }

  @Test
  func mailboxKeepsLatestAndReportsDrops() async {
    let mailbox = VideoMailbox<Int>()
    var droppedCount = 0
    mailbox.offer(1, onDrop: { droppedCount += 1 })
    mailbox.offer(2, onDrop: { droppedCount += 1 })
    #expect(droppedCount == 1)
    #expect(await mailbox.next(timeout: .milliseconds(10)) == 2)
  }

  @Test
  func mailboxWakesWaiterOnOffer() async {
    let mailbox = VideoMailbox<Int>()
    async let waited = mailbox.next(timeout: .seconds(5))
    try? await Task.sleep(for: .milliseconds(20))
    mailbox.offer(9)
    #expect(await waited == 9)
  }

  @Test
  func mailboxTimesOutAndFinishes() async {
    let mailbox = VideoMailbox<Int>()
    #expect(await mailbox.next(timeout: .milliseconds(10)) == nil)
    #expect(!mailbox.isFinished)
    mailbox.finish()
    #expect(mailbox.isFinished)
    mailbox.offer(3)
    #expect(await mailbox.next(timeout: .milliseconds(10)) == nil)
  }

  @Test
  func openH264NegotiationPrefersVideoAndFallsBackToTight() {
    #expect(
      RFBWire.preferredFrameEncoding(
        from: [RFBWire.tightEncoding, RFBWire.openH264Encoding]) == .openH264)
    #expect(
      RFBWire.preferredFrameEncoding(
        from: [RFBWire.tightEncoding, RFBWire.openH264Encoding],
        videoPathBroken: true) == .tight)
    #expect(RFBWire.preferredFrameEncoding(from: [RFBWire.tightEncoding]) == .tight)
    #expect(RFBWire.preferredFrameEncoding(from: [5]) == nil)
  }
}
