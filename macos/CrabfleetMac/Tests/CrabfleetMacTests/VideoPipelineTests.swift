import CoreMedia
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
  func crabfleetHEVCUpdateMatchesVideoWireFormat() throws {
    let payload = Data([0, 0, 0, 1, 0x26, 0x01, 0xAA])
    let update = try RFBWire.crabfleetHEVCUpdate(
      width: 1_280,
      height: 720,
      payload: payload,
      flags: 0x2)

    #expect(update.readInt32(at: 12) == RFBWire.crabfleetHEVCEncoding)
    #expect(update.readUInt32(at: 16) == UInt32(payload.count))
    #expect(update.readUInt32(at: 20) == 0x2)
    #expect(update.suffix(payload.count) == payload)
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
  func hevcKeyframeConversionPrependsVpsSpsPps() throws {
    let parameterSets = [
      Data([0x40, 0x01]),
      Data([0x42, 0x01]),
      Data([0x44, 0x01]),
    ]
    let output = try MacVideoEncoder.annexBData(
      lengthPrefixedData: Data([0, 2, 0x26, 0x01]),
      nalUnitHeaderLength: 2,
      parameterSets: parameterSets,
      isKeyframe: true)

    #expect(output == parameterSets.reduce(into: Data()) { result, set in
      result.append(contentsOf: [0, 0, 0, 1])
      result.append(set)
    } + Data([0, 0, 0, 1, 0x26, 0x01]))
    #expect(MacVideoCodec.hevc.videoToolboxType == kCMVideoCodecType_HEVC)
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
  func rateControllerCongestionTracksMeasuredThroughput() {
    var controller = VideoRateController()
    let first = controller.recordFrame(
      byteCount: 100_000, sendSeconds: 0.1, timestamp: 0)
    #expect(first == 6_400_000)
    #expect(controller.recordFrame(
      byteCount: 50_000, sendSeconds: 0.1, timestamp: 0.5) == nil)
    let second = controller.recordFrame(
      byteCount: 50_000, sendSeconds: 0.1, timestamp: 1)
    #expect(second == 5_248_000)
  }

  @Test
  func rateControllerRecoveryIsAdditiveAndDirtyScaled() {
    var controller = VideoRateController()
    #expect(controller.recordFrame(
      byteCount: 1, sendSeconds: 0.01, dirtyAreaFraction: 1, timestamp: 0) == nil)
    #expect(controller.recordFrame(
      byteCount: 1, sendSeconds: 0.01, dirtyAreaFraction: 1, timestamp: 1) == 9_000_000)
    #expect(controller.recordFrame(
      byteCount: 1, sendSeconds: 0.01, dirtyAreaFraction: 0, timestamp: 2) == 9_800_000)
  }

  @Test
  func rateControllerRespectsQualityModeBounds() {
    var controller = VideoRateController(mode: .sharp)
    #expect(controller.averageBitrate == 8_000_000)
    #expect(controller.recordFrame(
      byteCount: 1, sendSeconds: 0.1, timestamp: 0) == nil)
    for second in 1...25 {
      _ = controller.recordFrame(
        byteCount: 1, sendSeconds: 0.01, timestamp: Double(second))
    }
    #expect(controller.averageBitrate <= 40_000_000)
    #expect(controller.setMode(.smooth) == 20_000_000)
    #expect(controller.mode.framesPerSecond == 60)
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
    #expect(stats.dirtyAreaPercent == 100)
  }

  @Test
  func dirtyRectPolicySkipsStaticFramesUnlessKeyframeIsOwed() {
    let content = CGRect(x: 0, y: 0, width: 100, height: 100)
    let fraction = MacScreenCapture.dirtyAreaFraction(
      dirtyRects: [CGRect(x: 0, y: 0, width: 25, height: 20)],
      contentRect: content)
    #expect(fraction == 0.05)
    #expect(MacScreenCapture.dirtyAreaFraction(dirtyRects: [], contentRect: content) == 0)
    #expect(!MacScreenCapture.shouldOfferVideoFrame(dirtyRects: [], keyframeOwed: false))
    #expect(MacScreenCapture.shouldOfferVideoFrame(dirtyRects: [], keyframeOwed: true))
    #expect(MacScreenCapture.shouldOfferVideoFrame(dirtyRects: nil, keyframeOwed: false))
  }

  @Test
  func dirtyAreaUsesOutputContentBoundsAndRectangleUnion() {
    let content = MacScreenCapture.clippedContentRect(
      CGRect(x: 0, y: 0, width: 1_280, height: 800),
      pixelWidth: 2_560,
      pixelHeight: 1_600)
    let fraction = MacScreenCapture.dirtyAreaFraction(
      dirtyRects: [
        CGRect(x: 1_200, y: 720, width: 80, height: 80),
        CGRect(x: 1_240, y: 760, width: 40, height: 40),
      ],
      contentRect: content)

    #expect(content == CGRect(x: 0, y: 0, width: 1_280, height: 800))
    #expect(fraction == 0.00625)
    #expect(
      MacScreenCapture.dirtyAreaFraction(
        dirtyRects: [CGRect(x: 0, y: 0, width: 10, height: 10)],
        contentRect: nil) == 1)
  }

  @Test
  func screenCaptureRectAttachmentsDecodeDictionaryRepresentations() {
    let first = CGRect(x: 1, y: 2, width: 30, height: 40)
    let second = CGRect(x: 4, y: 5, width: 6, height: 7)
    let firstDictionary = first.dictionaryRepresentation
    let secondDictionary = second.dictionaryRepresentation

    #expect(MacScreenCapture.attachmentRect(firstDictionary) == first)
    #expect(
      MacScreenCapture.attachmentRects([firstDictionary, secondDictionary]) == [first, second])
  }

  @Test
  func idleRefreshFiresOnceAfterTwoStaticSeconds() {
    var policy = VideoIdleRefreshPolicy(timestamp: 0)
    var decision = policy.shouldRefresh(mode: .auto, timestamp: 1.99)
    #expect(!decision)
    decision = policy.shouldRefresh(mode: .auto, timestamp: 2)
    #expect(decision)
    decision = policy.shouldRefresh(mode: .auto, timestamp: 4)
    #expect(!decision)
    policy.recordDirtyArea(0.01, timestamp: 5)
    decision = policy.shouldRefresh(mode: .sharp, timestamp: 6)
    #expect(!decision)
    decision = policy.shouldRefresh(mode: .sharp, timestamp: 7)
    #expect(decision)
    policy.recordDirtyArea(1, timestamp: 8)
    decision = policy.shouldRefresh(mode: .smooth, timestamp: 20)
    #expect(!decision)
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
  func videoNegotiationPrefersHEVCThenH264ThenTight() {
    let offered = [
      RFBWire.tightEncoding,
      RFBWire.openH264Encoding,
      RFBWire.crabfleetHEVCEncoding,
    ]
    #expect(
      RFBWire.preferredFrameEncoding(from: offered) == .crabfleetHEVC)
    #expect(
      RFBWire.preferredFrameEncoding(
        from: offered,
        hevcPathBroken: true) == .openH264)
    #expect(
      RFBWire.preferredFrameEncoding(
        from: offered,
        hevcPathBroken: true,
        h264PathBroken: true) == .tight)
    #expect(RFBWire.preferredFrameEncoding(from: [RFBWire.tightEncoding]) == .tight)
    #expect(RFBWire.preferredFrameEncoding(from: [5]) == nil)
  }
}
