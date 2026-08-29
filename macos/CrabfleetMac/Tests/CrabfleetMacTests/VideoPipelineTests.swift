import CoreMedia
import Foundation
import Testing
import VideoToolbox

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
  func crabfleetHEVC444FlagRoundTripsInEnvelope() throws {
    let payload = Data([0, 0, 0, 1, 0x26, 0x01, 0xAA])
    let update = try RFBWire.crabfleetHEVCUpdate(
      width: 1_280,
      height: 720,
      payload: payload,
      flags: 0x2 | 0x4)

    #expect(update.readUInt32(at: 20) == 0x6)
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
  func parsesHEVCChromaFormatFromSPSFixtures() throws {
    let main420 = Data([
      0x42, 0x01, 0x01, 0x04, 0x08, 0x00, 0x00, 0x03, 0x00, 0x9f, 0xa8, 0x00,
      0x00, 0x03, 0x00, 0x00, 0x1e, 0xa0, 0x20, 0x81, 0x05, 0x96, 0xea, 0x49,
      0x32, 0xbc, 0x05, 0xa0, 0x20, 0x00, 0x00, 0x03, 0x00, 0x20, 0x00, 0x00,
      0x03, 0x00, 0x21, 0x00,
    ])
    let main444 = Data([
      0x42, 0x01, 0x01, 0x04, 0x08, 0x00, 0x00, 0x03, 0x00, 0x9e, 0x28, 0x00,
      0x00, 0x03, 0x00, 0x00, 0x1e, 0x90, 0x04, 0x10, 0x20, 0xb2, 0xdd, 0x49,
      0x26, 0x57, 0x80, 0xb4, 0x04, 0x00, 0x00, 0x03, 0x00, 0x04, 0x00, 0x00,
      0x03, 0x00, 0x04, 0x20,
    ])

    #expect(try HEVCSPSParser.chromaFormatIDC(from: main420) == 1)
    #expect(try HEVCSPSParser.chromaFormatIDC(from: main444) == 3)
    #expect(throws: (any Error).self) {
      _ = try HEVCSPSParser.chromaFormatIDC(from: Data([0x42, 0x01]))
    }
  }

  @Test
  func rejectedMain444ProfileFallsBackToMain() {
    var profiles: [CFString] = []
    let selection = MacVideoEncoder.selectProfile(codec: .hevc, requestedChroma: .chroma444) {
      profile in
      profiles.append(profile)
      return profile == hevcMain444AutoLevel ? kVTPropertyNotSupportedErr : noErr
    }

    #expect(selection.chroma == .chroma420)
    #expect(!selection.chroma444Available)
    #expect(profiles == [hevcMain444AutoLevel, kVTProfileLevel_HEVC_Main_AutoLevel])
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
  func chroma444RateControllerRaisesBounds() {
    var auto = VideoRateController(mode: .auto, chroma: .chroma444)
    #expect(ShareQualityMode.auto.bitrateFloor(chroma: .chroma444) == 2_250_000)
    #expect(ShareQualityMode.auto.bitrateCeiling(chroma: .chroma444) == 45_000_000)
    #expect(ShareQualityMode.sharp.bitrateCeiling(chroma: .chroma444) == 48_000_000)
    #expect(auto.setMode(.sharp) == 12_000_000)
    #expect(auto.chroma == .chroma444)
  }

  @Test
  func qualityModesSelectTextSharpnessQPCaps() {
    #expect(ShareQualityMode.sharp.maximumFrameQP == 30)
    #expect(ShareQualityMode.auto.maximumFrameQP == 40)
    #expect(ShareQualityMode.smooth.maximumFrameQP == nil)
    #expect(
      TailnetStreamStats.codecDetail(
        codec: "HEVC",
        hardwareAccelerated: true,
        maximumFrameQPAvailable: false,
        maximumFrameQPRequested: true) == "HEVC hw · QP cap unavailable")
    #expect(
      TailnetStreamStats.codecDetail(
        codec: "HEVC",
        hardwareAccelerated: true,
        maximumFrameQPAvailable: false,
        maximumFrameQPRequested: false) == "HEVC hw")
    #expect(MacVideoEncoderOutput.dropped.requiresKeyframeRecovery)
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
    policy.rearmImmediately(timestamp: 4)
    decision = policy.shouldRefresh(mode: .sharp, timestamp: 4)
    #expect(decision)
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
  func mailboxCancelledWaiterReturnsPromptlyWithoutResumingTwice() async {
    let mailbox = VideoMailbox<Int>()
    let startedAt = ContinuousClock().now
    let task = Task {
      withUnsafeCurrentTask { $0?.cancel() }
      return await mailbox.next(timeout: .seconds(5))
    }
    let result = await task.value
    #expect(result == nil)
    #expect(ContinuousClock().now - startedAt < .milliseconds(500))

    mailbox.offer(4)
    #expect(await mailbox.next(timeout: .milliseconds(50)) == 4)
  }

  @Test
  func mailboxCancellationRacingOfferLeavesMailboxUsable() async {
    for value in 0..<100 {
      let mailbox = VideoMailbox<Int>()
      let waiter = Task { await mailbox.next(timeout: .seconds(5)) }
      async let cancellation: Void = Task { waiter.cancel() }.value
      async let offer: Void = Task { mailbox.offer(value) }.value
      _ = await (cancellation, offer)
      let received = await waiter.value
      #expect(received == nil || received == value)
      mailbox.offer(value + 1)
      #expect(await mailbox.next(timeout: .milliseconds(50)) == value + 1)
      mailbox.finish()
    }
  }

  @Test
  func mailboxCancelledWaitDoesNotRetainTimeout() async {
    weak var releasedMailbox: VideoMailbox<Int>?
    let task = Task {
      let mailbox = VideoMailbox<Int>()
      releasedMailbox = mailbox
      withUnsafeCurrentTask { $0?.cancel() }
      #expect(await mailbox.next(timeout: .seconds(5)) == nil)
    }
    await task.value
    let deadline = ContinuousClock.now.advanced(by: .milliseconds(500))
    while releasedMailbox != nil, ContinuousClock.now < deadline {
      await Task.yield()
    }
    #expect(releasedMailbox == nil)
  }

  @Test
  func cursorCancellationErrorStopsReconciliation() async {
    var attempts = 0
    await MacScreenCapture.reconcileCursorConfigurationWithRetry {
      attempts += 1
      if attempts == 1 { throw CancellationError() }
    }
    #expect(attempts == 1)
  }

  @Test
  func cursorTransientFailureRetriesReconciliation() async {
    var attempts = 0
    await MacScreenCapture.reconcileCursorConfigurationWithRetry {
      attempts += 1
      if attempts == 1 { throw NSError(domain: "CrabfleetMacTests", code: 1) }
    }
    #expect(attempts == 2)
  }

  @Test
  func cursorCancelledTaskDoesNotStartReconciliation() async {
    let task = Task {
      withUnsafeCurrentTask { $0?.cancel() }
      var attempts = 0
      await MacScreenCapture.reconcileCursorConfigurationWithRetry { attempts += 1 }
      return attempts
    }
    #expect(await task.value == 0)
  }

  @Test
  func cursorCancellationStopsRetryBackoff() async {
    let startedAt = ContinuousClock.now
    let task = Task {
      var attempts = 0
      await MacScreenCapture.reconcileCursorConfigurationWithRetry {
        attempts += 1
        withUnsafeCurrentTask { $0?.cancel() }
        throw NSError(domain: "CrabfleetMacTests", code: 1)
      }
      return attempts
    }
    #expect(await task.value == 1)
    #expect(startedAt.duration(to: .now) < .milliseconds(500))
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

  @Test
  func videoNegotiationGatesChroma444ByCodecModeAndCapability() {
    let capable = [RFBWire.crabfleetChroma444Encoding]
    #expect(
      RFBWire.preferredChroma(codec: .hevc, qualityMode: .sharp, encodings: capable)
        == .chroma444)
    #expect(
      RFBWire.preferredChroma(codec: .hevc, qualityMode: .auto, encodings: capable)
        == .chroma444)
    #expect(
      RFBWire.preferredChroma(codec: .hevc, qualityMode: .smooth, encodings: capable)
        == .chroma420)
    #expect(
      RFBWire.preferredChroma(codec: .hevc, qualityMode: .sharp, encodings: [])
        == .chroma420)
    #expect(
      RFBWire.preferredChroma(codec: .h264, qualityMode: .sharp, encodings: capable)
        == .chroma420)
    #expect(
      RFBWire.preferredChroma(
        codec: .hevc,
        qualityMode: .sharp,
        encodings: capable,
        chroma444Unavailable: true) == .chroma420)
  }

  @Test
  func nativeControllerAdvertisesC444OnlyAfterDecodeProbe() {
    #expect(
      !VNCSessionController.preferredFrameEncodings(supportsHEVC444: false)
        .contains(.crabfleetChroma444))
    #expect(
      VNCSessionController.preferredFrameEncodings(supportsHEVC444: true)
        .contains(.crabfleetChroma444))
  }

  @Test
  @MainActor
  func nativeViewerPersistsQualityPerHost() throws {
    let suiteName = "CrabfleetMacTests.\(UUID().uuidString)"
    let defaults = try #require(UserDefaults(suiteName: suiteName))
    defaults.removePersistentDomain(forName: suiteName)

    let first = VNCSessionController(targetID: "host-1", defaults: defaults)
    first.qualityMode = .sharp
    let sameHost = VNCSessionController(targetID: "host-1", defaults: defaults)
    let otherHost = VNCSessionController(targetID: "host-2", defaults: defaults)

    #expect(sameHost.qualityMode == .sharp)
    #expect(otherHost.qualityMode == .auto)
    #expect(
      VNCSessionController.preferredFrameEncodings(supportsHEVC444: false)
        .contains(.crabfleetQualityControl))
    #expect(
      VNCSessionController.preferredFrameEncodings(supportsHEVC444: false)
        .contains(.crabfleetFileSharing))
  }

  @Test
  func captureFansOutFramesAndReferenceCountsConsumers() throws {
    let capture = MacScreenCapture()
    let firstID = UUID()
    let secondID = UUID()
    capture.retainConsumer(id: firstID)
    capture.retainConsumer(id: firstID)
    capture.retainConsumer(id: secondID)
    #expect(capture.activeConsumerCount == 2)

    let recorders = (0..<3).map { _ in FrameFanoutRecorder() }
    for recorder in recorders {
      capture.addVideoFrameHandler(id: UUID()) { _ in recorder.record() }
    }
    var pixelBuffer: CVPixelBuffer?
    #expect(
      CVPixelBufferCreate(
        nil,
        2,
        2,
        kCVPixelFormatType_32BGRA,
        nil,
        &pixelBuffer) == kCVReturnSuccess)
    capture.deliverVideoFrame(
      VideoPixelSource(
        pixelBuffer: try #require(pixelBuffer),
        presentationTime: .zero,
        dirtyRects: nil,
        contentRect: nil))
    #expect(recorders.allSatisfy { $0.count == 1 })

    capture.releaseConsumer(id: firstID)
    #expect(capture.activeConsumerCount == 1)
    capture.releaseConsumer(id: secondID)
    #expect(capture.activeConsumerCount == 0)
  }

  @Test
  func captureUsesTheHighestSessionFrameRate() {
    #expect(MacScreenCapture.effectiveFrameRate([]) == 15)
    #expect(MacScreenCapture.effectiveFrameRate([15, 60, 30]) == 60)
    #expect(MacScreenCapture.effectiveFrameRate([15, 30]) == 30)
  }

  @Test
  func serverEnforcesSessionCapAndSingleViewerResizePolicy() {
    #expect(TailnetRFBServer.canAdmitSession(currentCount: 3))
    #expect(!TailnetRFBServer.canAdmitSession(currentCount: 4))
    #expect(!TailnetRFBServer.canAdmitSession(currentCount: -1))
    #expect(TailnetRFBServer.resizeStatus(sessionCount: 1) == 0)
    #expect(TailnetRFBServer.resizeStatus(sessionCount: 2) == 3)
  }
}

private final class FrameFanoutRecorder: @unchecked Sendable {
  private let lock = NSLock()
  private var value = 0

  var count: Int {
    lock.withLock { value }
  }

  func record() {
    lock.withLock { value += 1 }
  }
}
