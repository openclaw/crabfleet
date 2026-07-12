import Foundation
import Testing

#if canImport(Network)
import Network
#endif

@testable import RoyalVNCKit

struct AuditFindingsTests {
  @Test
  func rejectsOutOfRangeZRLEPackedPaletteIndex() async throws {
    let framebuffer = try makeFramebuffer(width: 1, height: 1, depth: 24)
    let encoding = VNCProtocol.ZRLEEncoding(zStream: ZlibStream())
    let rectangle = VNCProtocol.Rectangle(
      xPosition: 0,
      yPosition: 0,
      width: 1,
      height: 1,
      encodingType: Int32(VNCFrameEncodingType.zrle.rawValue.rawValue)
    )

    var payload = Data([3])
    payload.append(contentsOf: [
      0, 0, 0,
      64, 64, 64,
      128, 128, 128,
      0xC0,
    ])
    let compressed = try ZlibOneShot.deflate(payload)
    var compressedLength = UInt32(compressed.count).bigEndian
    var wire = withUnsafeBytes(of: &compressedLength) { Data($0) }
    wire.append(compressed)

    await #expect(throws: (any Error).self) {
      try await encoding.decodeRectangle(
        rectangle,
        framebuffer: framebuffer,
        connection: AuditBufferConnection(wire),
        logger: VNCPrintLogger()
      )
    }
  }

  @Test
  func derivesZRLEInflationLimitFromRectangleGeometry() {
    #expect(VNCProtocol.ZRLEEncoding.maximumInflatedSize(width: 1, height: 1) == 384)
    #expect(VNCProtocol.ZRLEEncoding.maximumInflatedSize(width: 64, height: 64) == 16_385)
    #expect(VNCProtocol.ZRLEEncoding.maximumInflatedSize(width: 65, height: 1) == 894)
  }

  @Test
  func drainsPendingZlibOutputAfterConsumingAllInput() throws {
    let expected = Data(repeating: 0xA5, count: 204_800)
    let compressed = try ZlibOneShot.deflate(expected)

    let actual = try ZlibStream().decompressedData(
      compressedData: compressed,
      maximumOutputSize: expected.count
    )

    #expect(actual == expected)
  }

  @Test
  func rejectsInflatedChunkLargerThanOutputLimitWithoutTrapping() throws {
    let compressed = try ZlibOneShot.deflate(Data(repeating: 0xA5, count: 385))

    #expect(throws: (any Error).self) {
      _ = try ZlibStream().decompressedData(
        compressedData: compressed,
        maximumOutputSize: 384
      )
    }
  }

  @Test
  func consumesSyncFlushBytesAfterFixedSizeOutputIsFull() throws {
    let firstCompressed = Data([
      0x78, 0x9C, 0x72, 0x74, 0x1C, 0x05, 0xA3, 0x60, 0x14,
      0x0C, 0x77, 0x00, 0x00, 0x00, 0x00, 0xFF, 0xFF,
      0x00, 0x00, 0x00, 0xFF, 0xFF,
    ])
    let secondCompressed = Data([
      0x72, 0x1A, 0x05, 0xA3, 0x60, 0x14, 0x0C,
      0x7B, 0x00, 0x00, 0x00, 0x00, 0xFF, 0xFF,
    ])
    let stream = ZlibStream()

    let first = try stream.decompressedData(
      compressedData: firstCompressed,
      uncompressedSize: 1_000
    )
    let second = try stream.decompressedData(
      compressedData: secondCompressed,
      uncompressedSize: 1_000
    )

    #expect(first == Data(repeating: 0x41, count: 1_000))
    #expect(second == Data(repeating: 0x42, count: 1_000))
  }

  @Test
  func readsAllEightBitsOfThirdTightLengthByte() async throws {
    let encoding = VNCProtocol.TightEncoding()

    let length = try await encoding.readCompactLength(
      connection: AuditBufferConnection(Data([0x80, 0x80, 0xFF])),
      logger: VNCPrintLogger()
    )

    #expect(length == 0xFF << 14)
  }

  @Test
  func retainsLegacyPixelFormatTransitionUntilSlowFramebufferUpdateCompletes() async throws {
    let connection = VNCConnection(
      settings: makeSettings(),
      framebufferAllocator: VNCFramebufferMallocAllocator()
    )
    let framebuffer = try makeFramebuffer(width: 2, height: 2, depth: 24)
    connection.framebuffer = framebuffer
    connection.state.pixelFormat = framebuffer.sourcePixelFormat
    connection.connectionState = .connected
    connection._framebufferUpdatePolicy = .paused
    connection.framebufferUpdateRequestOutstanding = true

    connection.updateColorDepth(.depth8Bit)

    #expect(connection.pendingPixelFormatTransition?.depth == 8)
    #expect(connection.clientToServerMessageQueue.dequeue() == nil)
    #expect(connection.pixelFormatFenceNegotiationTask != nil)

    for _ in 0..<100 {
      guard connection.pixelFormatFenceNegotiationTask != nil else { break }
      try await Task.sleep(nanoseconds: 20_000_000)
    }

    #expect(connection.state.pixelFormat?.depth == 24)
    #expect(connection.state.pixelFormat?.depth == connection.framebuffer?.sourcePixelFormat.depth)
    #expect(connection.clientToServerMessageQueue.dequeue() == nil)
    #expect(connection.pixelFormatFenceNegotiationTask == nil)
    #expect(connection.pendingPixelFormatTransition?.depth == 8)

    connection.completeFramebufferUpdateRequest()

    let transition = try #require(connection.clientToServerMessageQueue.dequeue())
    try await transition.message.send(connection: AuditWritingConnection())
    #expect(connection.pendingPixelFormatTransition == nil)
    #expect(connection.state.pixelFormat?.depth == 8)
    #expect(connection.state.pixelFormat?.depth == connection.framebuffer?.sourcePixelFormat.depth)
  }

  @Test
  func preservesEarlyPixelFormatTransitionUntilFenceSupportArrives() throws {
    let connection = VNCConnection(
      settings: makeSettings(),
      framebufferAllocator: VNCFramebufferMallocAllocator()
    )
    let framebuffer = try makeFramebuffer(width: 2, height: 2, depth: 24)
    connection.framebuffer = framebuffer
    connection.state.pixelFormat = framebuffer.sourcePixelFormat
    connection.connectionState = .connected
    connection._framebufferUpdatePolicy = .paused
    connection.framebufferUpdateRequestOutstanding = true

    connection.updateColorDepth(.depth8Bit)

    #expect(connection.pendingPixelFormatTransition?.depth == 8)
    #expect(connection.clientToServerMessageQueue.dequeue() == nil)

    try connection.handleServerFence(
      VNCProtocol.ServerFence(
        messageType: VNCProtocol.ServerFence.messageType,
        flags: [.request, .blockAfter, .syncNext],
        payload: Data("support".utf8)
      )
    )

    #expect(connection.pendingPixelFormatTransition?.depth == 8)
    #expect(connection.clientToServerMessageQueue.dequeue() != nil)
    #expect(connection.clientToServerMessageQueue.dequeue() != nil)
  }

  @Test
  func publishesFenceNegotiationBeforeExposingSupport() async throws {
    let logger = AuditCallbackLogger()
    let connection = VNCConnection(
      settings: makeSettings(),
      logger: logger,
      framebufferAllocator: VNCFramebufferMallocAllocator(),
      context: nil
    )
    let framebuffer = try makeFramebuffer(width: 2, height: 2, depth: 24)
    connection.framebuffer = framebuffer
    connection.state.pixelFormat = framebuffer.sourcePixelFormat
    connection.state.areContinuousUpdatesEnabled = true
    connection.connectionState = .connected
    connection._framebufferUpdatePolicy = .paused
    logger.onDebug = { message in
      guard message == "Fence supported (server sent ServerFence)" else { return }
      connection.updateColorDepth(.depth8Bit)
    }

    try connection.handleServerFence(
      VNCProtocol.ServerFence(
        messageType: VNCProtocol.ServerFence.messageType,
        flags: [.request, .blockBefore, .syncNext],
        payload: Data("support".utf8)
      )
    )

    #expect(connection.state.areFencesSupported)
    #expect(connection.pixelFormatFenceCapabilityProbePayload != nil)
    #expect(connection.pendingPixelFormatTransition?.depth == 8)
    #expect(connection.state.pixelFormat?.depth == 24)

    _ = try #require(connection.clientToServerMessageQueue.dequeue())
    let capabilityProbe = try #require(connection.clientToServerMessageQueue.dequeue())
    let capabilityWriter = AuditWritingConnection()
    try await capabilityProbe.message.send(connection: capabilityWriter)
    let capabilityLength = Int(capabilityWriter.data[8])
    let capabilityPayload = Data(capabilityWriter.data[9..<(9 + capabilityLength)])

    try connection.handleServerFence(
      VNCProtocol.ServerFence(
        messageType: VNCProtocol.ServerFence.messageType,
        flags: [.blockBefore, .syncNext],
        payload: capabilityPayload
      )
    )

    #expect(connection.pendingPixelFormatTransition == nil)
    #expect(connection.clientToServerMessageQueue.dequeue() != nil)
    logger.onDebug = nil
    connection.cancelFramebufferUpdateScheduling()
  }

  @Test
  func startsFenceCapabilityTimeoutAfterDelayedProbeSend() async throws {
    let connection = VNCConnection(
      settings: makeSettings(),
      framebufferAllocator: VNCFramebufferMallocAllocator()
    )
    let framebuffer = try makeFramebuffer(width: 2, height: 2, depth: 24)
    connection.framebuffer = framebuffer
    connection.state.pixelFormat = framebuffer.sourcePixelFormat
    connection.connectionState = .connected
    connection._framebufferUpdatePolicy = .paused

    try connection.handleServerFence(
      VNCProtocol.ServerFence(
        messageType: VNCProtocol.ServerFence.messageType,
        flags: [.request, .blockBefore, .syncNext],
        payload: Data("support".utf8)
      )
    )
    _ = try #require(connection.clientToServerMessageQueue.dequeue())
    let capabilityProbe = try #require(connection.clientToServerMessageQueue.dequeue())

    #expect(connection.pixelFormatFenceCapabilityProbePayload != nil)
    #expect(connection.pixelFormatFenceNegotiationTask == nil)

    try await capabilityProbe.message.send(
      connection: AuditWritingConnection(delayNanoseconds: 1_100_000_000)
    )

    #expect(connection.pixelFormatFenceCapabilityProbePayload != nil)
    #expect(connection.pixelFormatFenceNegotiationTask != nil)
    connection.expirePixelFormatFenceNegotiation()
  }

  @Test
  func disconnectsWhenFenceCapabilityProbeIsUnanswered() async throws {
    let connection = VNCConnection(
      settings: makeSettings(),
      framebufferAllocator: VNCFramebufferMallocAllocator()
    )
    let framebuffer = try makeFramebuffer(width: 2, height: 2, depth: 24)
    connection.framebuffer = framebuffer
    connection.state.pixelFormat = framebuffer.sourcePixelFormat
    connection.connectionState = .connected
    connection._framebufferUpdatePolicy = .paused

    try connection.handleServerFence(
      VNCProtocol.ServerFence(
        messageType: VNCProtocol.ServerFence.messageType,
        flags: [.request, .blockBefore, .syncNext],
        payload: Data("support".utf8)
      )
    )
    _ = try #require(connection.clientToServerMessageQueue.dequeue())
    _ = try #require(connection.clientToServerMessageQueue.dequeue())

    connection.updateColorDepth(.depth8Bit)
    #expect(connection.pendingPixelFormatTransition?.depth == 8)

    connection.expirePixelFormatFenceNegotiation()

    #expect(connection.pixelFormatFenceCapabilityProbePayload == nil)
    #expect(connection.expiredPixelFormatFenceCapabilityProbePayload == nil)
    #expect(connection.connectionState.status == .disconnected)
    #expect(connection.pendingPixelFormatTransition == nil)
    #expect(connection.state.pixelFormat?.depth == 24)
    #expect(connection.clientToServerMessageQueue.dequeue() == nil)
  }

  @Test
  func lateFenceCapabilityResponseCannotReviveTimedOutConnection() async throws {
    let connection = VNCConnection(
      settings: makeSettings(),
      framebufferAllocator: VNCFramebufferMallocAllocator()
    )
    let framebuffer = try makeFramebuffer(width: 2, height: 2, depth: 24)
    connection.framebuffer = framebuffer
    connection.state.pixelFormat = framebuffer.sourcePixelFormat
    connection.connectionState = .connected
    connection._framebufferUpdatePolicy = .paused

    try connection.handleServerFence(
      VNCProtocol.ServerFence(
        messageType: VNCProtocol.ServerFence.messageType,
        flags: [.request, .blockBefore, .syncNext],
        payload: Data("support".utf8)
      )
    )
    _ = try #require(connection.clientToServerMessageQueue.dequeue())
    _ = try #require(connection.clientToServerMessageQueue.dequeue())
    let probePayload = try #require(connection.pixelFormatFenceCapabilityProbePayload)

    connection.updateColorDepth(.depth8Bit)
    connection.expirePixelFormatFenceNegotiation()
    #expect(connection.connectionState.status == .disconnected)

    try connection.handleServerFence(
      VNCProtocol.ServerFence(
        messageType: VNCProtocol.ServerFence.messageType,
        flags: [.blockBefore, .syncNext],
        payload: probePayload
      )
    )

    #expect(connection.expiredPixelFormatFenceCapabilityProbePayload == nil)
    #expect(connection.connectionState.status == .disconnected)
    #expect(connection.state.pixelFormatTransitionFenceFlags.isEmpty)
    #expect(connection.clientToServerMessageQueue.dequeue() == nil)
  }

  @Test
  func rejectsPartialFenceBoundariesDuringContinuousUpdates() throws {
    let connection = VNCConnection(
      settings: makeSettings(),
      framebufferAllocator: VNCFramebufferMallocAllocator()
    )
    let framebuffer = try makeFramebuffer(width: 2, height: 2, depth: 24)
    connection.framebuffer = framebuffer
    connection.state.pixelFormat = framebuffer.sourcePixelFormat
    connection.state.areFencesSupported = true
    connection.state.pixelFormatTransitionFenceFlags = [.blockAfter]
    connection.state.areContinuousUpdatesEnabled = true
    connection.connectionState = .connected
    connection._framebufferUpdatePolicy = .paused
    connection.framebufferUpdateRequestOutstanding = true

    connection.updateColorDepth(.depth8Bit)

    #expect(connection.clientToServerMessageQueue.dequeue() == nil)
    #expect(connection.pendingPixelFormatTransition == nil)
    #expect(connection.state.pixelFormat?.depth == 24)
  }

  @Test
  func synchronizesPixelFormatTransitionWithFenceResponse() async throws {
    let connection = VNCConnection(
      settings: makeSettings(),
      framebufferAllocator: VNCFramebufferMallocAllocator()
    )
    let framebuffer = try makeFramebuffer(width: 2, height: 2, depth: 24)
    connection.framebuffer = framebuffer
    connection.state.pixelFormat = framebuffer.sourcePixelFormat
    connection.connectionState = .connected
    connection._framebufferUpdatePolicy = .paused
    connection.framebufferUpdateRequestOutstanding = true

    try connection.handleServerFence(
      VNCProtocol.ServerFence(
        messageType: VNCProtocol.ServerFence.messageType,
        flags: [.request, .blockBefore, .syncNext],
        payload: Data("support".utf8)
      )
    )
    let supportResponse = try #require(connection.clientToServerMessageQueue.dequeue())
    let supportWriter = AuditWritingConnection()
    try await supportResponse.message.send(connection: supportWriter)
    #expect(supportWriter.data[0] == VNCProtocol.ClientFence.messageType)
    #expect(supportWriter.data[4..<8] == Data([0, 0, 0, 1]))
    #expect(supportWriter.data[8] == 7)

    let capabilityProbe = try #require(connection.clientToServerMessageQueue.dequeue())
    let capabilityWriter = AuditWritingConnection()
    try await capabilityProbe.message.send(connection: capabilityWriter)
    let capabilityLength = Int(capabilityWriter.data[8])
    let capabilityPayload = Data(capabilityWriter.data[9..<(9 + capabilityLength)])
    #expect(capabilityWriter.data[0] == VNCProtocol.ClientFence.messageType)
    #expect(capabilityWriter.data[(9 + capabilityLength)] == 0)
    try connection.handleServerFence(
      VNCProtocol.ServerFence(
        messageType: VNCProtocol.ServerFence.messageType,
        flags: [.blockBefore, .syncNext],
        payload: capabilityPayload
      )
    )

    connection.updateColorDepth(.depth8Bit)
    let queued = try #require(connection.clientToServerMessageQueue.dequeue())
    let writer = AuditWritingConnection {
      #expect(connection.state.pixelFormat?.depth == 24)
    }
    try await queued.message.send(connection: writer)

    #expect(connection.pixelFormatTransitionDeadlineTask == nil)
    #expect(writer.data[0] == VNCProtocol.ClientFence.messageType)
    #expect(writer.data[4..<8] == Data([0x80, 0, 0, 5]))
    #expect(writer.data[8] == 8)
    #expect(writer.data[17] == VNCProtocol.SetPixelFormat(pixelFormat: framebuffer.sourcePixelFormat).messageType)
    #expect(writer.data[37] == VNCProtocol.SetEncodings(encodingTypes: []).messageType)
    let encodingValues = setEncodingValues(in: writer.data, at: 37)
    #expect(encodingValues.contains(Int32(VNCFrameEncodingType.raw.rawValue.rawValue)))
    let completionFenceOffset = setEncodingsEndOffset(in: writer.data, at: 37)
    #expect(writer.data[completionFenceOffset] == VNCProtocol.ClientFence.messageType)
    #expect(
      writer.data[(completionFenceOffset + 4)..<(completionFenceOffset + 8)]
        == Data([0x80, 0, 0, 1])
    )
    #expect(connection.state.pixelFormat?.depth == 24)

    let synchronizationPayload = Data(writer.data[9..<17])
    let completionPayload = Data(
      writer.data[(completionFenceOffset + 9)..<(completionFenceOffset + 17)]
    )
    connection.completeFramebufferUpdateRequest()
    #expect(connection.pixelFormatTransitionDeadlineTask != nil)
    try connection.handleServerFence(
      VNCProtocol.ServerFence(
        messageType: VNCProtocol.ServerFence.messageType,
        flags: [.blockBefore, .syncNext],
        payload: synchronizationPayload
      )
    )
    #expect(connection.state.pixelFormat?.depth == 24)
    #expect(connection.pixelFormatTransitionDeadlineTask != nil)

    try connection.handleServerFence(
      VNCProtocol.ServerFence(
        messageType: VNCProtocol.ServerFence.messageType,
        flags: [.blockBefore],
        payload: completionPayload
      )
    )
    #expect(connection.state.pixelFormat?.depth == 8)
    #expect(connection.state.pixelFormat?.depth == connection.framebuffer?.sourcePixelFormat.depth)
    #expect(connection.pixelFormatTransitionDeadlineTask == nil)
    #expect(connection.connectionState.status == .connected)
  }

  @Test
  func renegotiatesEncodingsForSynchronizedPixelFormatTransition() async throws {
    let connection = try await makeFenceCapableConnection(
      settings: makeSettings(frameEncodings: [.tight, .zrle, .openH264, .raw])
    )

    let depth24Encodings = try connection.orderedEncodingTypes(
      pixelFormat: VNCProtocol.PixelFormat(depth: 24)
    )
    #expect(depth24Encodings.contains(VNCFrameEncodingType.tight.rawValue))
    #expect(depth24Encodings.contains(VNCFrameEncodingType.zrle.rawValue))
#if canImport(VideoToolbox)
    #expect(depth24Encodings.contains(VNCFrameEncodingType.openH264.rawValue))
#endif

    connection.updateColorDepth(.depth8Bit)
    let queued = try #require(connection.clientToServerMessageQueue.dequeue())
    let writer = AuditWritingConnection {
      #expect(connection.state.pixelFormat?.depth == 24)
    }
    try await queued.message.send(connection: writer)

    #expect(writer.data[0] == VNCProtocol.ClientFence.messageType)
    #expect(writer.data[17] == VNCProtocol.SetPixelFormat(pixelFormat: VNCProtocol.PixelFormat(depth: 8)).messageType)
    #expect(writer.data[37] == VNCProtocol.SetEncodings(encodingTypes: []).messageType)
    let values = setEncodingValues(in: writer.data, at: 37)
    #expect(!values.contains(Int32(VNCFrameEncodingType.tight.rawValue.rawValue)))
    #expect(!values.contains(Int32(VNCFrameEncodingType.zrle.rawValue.rawValue)))
    #expect(!values.contains(Int32(VNCFrameEncodingType.openH264.rawValue.rawValue)))
    #expect(values.contains(Int32(VNCFrameEncodingType.copyRect.rawValue.rawValue)))
    #expect(values.contains(Int32(VNCFrameEncodingType.raw.rawValue.rawValue)))
    let completionFenceOffset = setEncodingsEndOffset(in: writer.data, at: 37)
    #expect(writer.data[completionFenceOffset] == VNCProtocol.ClientFence.messageType)

    connection.cancelFramebufferUpdateScheduling()
  }

  @Test
  func resetsZRLECompressionAtSynchronizedPixelFormatBoundaries() async throws {
    let connection = VNCConnection(
      settings: makeSettings(frameEncodings: [.zrle, .raw]),
      framebufferAllocator: VNCFramebufferMallocAllocator()
    )
    let framebuffer = try makeFramebuffer(width: 2, height: 2, depth: 24)
    connection.framebuffer = framebuffer
    connection.state.pixelFormat = framebuffer.sourcePixelFormat
    connection.connectionState = .connected
    connection._framebufferUpdatePolicy = .paused
    let zrle = try #require(
      connection.encodings[VNCFrameEncodingType.zrle.rawValue] as? VNCProtocol.ZRLEEncoding
    )

    try connection.handleServerFence(
      VNCProtocol.ServerFence(
        messageType: VNCProtocol.ServerFence.messageType,
        flags: [.request, .blockBefore, .syncNext],
        payload: Data("support".utf8)
      )
    )
    _ = try #require(connection.clientToServerMessageQueue.dequeue())
    let capabilityProbe = try #require(connection.clientToServerMessageQueue.dequeue())

    let compressedChunks = continuousZlibChunks()
    let first = try zrle.zStream.decompressedData(
      compressedData: compressedChunks[0],
      uncompressedSize: 1_000
    )
    #expect(first == Data(repeating: 0x41, count: 1_000))
    try await capabilityProbe.message.send(connection: AuditWritingConnection())
    let second = try zrle.zStream.decompressedData(
      compressedData: compressedChunks[1],
      uncompressedSize: 1_000
    )
    #expect(second == Data(repeating: 0x42, count: 1_000))

    let capabilityPayload = try #require(connection.pixelFormatFenceCapabilityProbePayload)
    try connection.handleServerFence(
      VNCProtocol.ServerFence(
        messageType: VNCProtocol.ServerFence.messageType,
        flags: [.blockBefore, .syncNext],
        payload: capabilityPayload
      )
    )
    let restartedAfterProbe = try zrle.zStream.decompressedData(
      compressedData: compressedChunks[0],
      uncompressedSize: 1_000
    )
    #expect(restartedAfterProbe == Data(repeating: 0x41, count: 1_000))

    connection.framebufferUpdateRequestOutstanding = true
    connection.updateColorDepth(.depth8Bit)
    let transition = try #require(connection.clientToServerMessageQueue.dequeue())
    let transitionWriter = AuditWritingConnection()
    try await transition.message.send(connection: transitionWriter)
    let continuedBeforeBoundary = try zrle.zStream.decompressedData(
      compressedData: compressedChunks[1],
      uncompressedSize: 1_000
    )
    #expect(continuedBeforeBoundary == Data(repeating: 0x42, count: 1_000))

    let completionFenceOffset = setEncodingsEndOffset(in: transitionWriter.data, at: 37)
    let synchronizationPayload = Data(transitionWriter.data[9..<17])
    let completionPayload = Data(
      transitionWriter.data[(completionFenceOffset + 9)..<(completionFenceOffset + 17)]
    )
    try connection.handleServerFence(
      VNCProtocol.ServerFence(
        messageType: VNCProtocol.ServerFence.messageType,
        flags: [.blockBefore, .syncNext],
        payload: synchronizationPayload
      )
    )
    let continuedAfterSynchronizationFence = try zrle.zStream.decompressedData(
      compressedData: compressedChunks[2],
      uncompressedSize: 1_000
    )
    #expect(continuedAfterSynchronizationFence == Data(repeating: 0x43, count: 1_000))

    try connection.handleServerFence(
      VNCProtocol.ServerFence(
        messageType: VNCProtocol.ServerFence.messageType,
        flags: [.blockBefore],
        payload: completionPayload
      )
    )
    try verifyFreshZRLEStream(zrle.zStream, byte: 0x44)

    connection.cancelFramebufferUpdateScheduling()
  }

  @Test
  func defersZRLEResetUntilTrailingFenceWhenSyncNextIsUnsupported() async throws {
    let connection = VNCConnection(
      settings: makeSettings(frameEncodings: [.zrle, .raw]),
      framebufferAllocator: VNCFramebufferMallocAllocator()
    )
    let framebuffer = try makeFramebuffer(width: 2, height: 2, depth: 24)
    connection.framebuffer = framebuffer
    connection.state.pixelFormat = framebuffer.sourcePixelFormat
    connection.connectionState = .connected
    connection._framebufferUpdatePolicy = .paused
    let zrle = try #require(
      connection.encodings[VNCFrameEncodingType.zrle.rawValue] as? VNCProtocol.ZRLEEncoding
    )

    try connection.handleServerFence(
      VNCProtocol.ServerFence(
        messageType: VNCProtocol.ServerFence.messageType,
        flags: [.request, .blockBefore, .blockAfter],
        payload: Data("support".utf8)
      )
    )
    _ = try #require(connection.clientToServerMessageQueue.dequeue())
    let capabilityProbe = try #require(connection.clientToServerMessageQueue.dequeue())
    let capabilityWriter = AuditWritingConnection()
    try await capabilityProbe.message.send(connection: capabilityWriter)

    let compressedChunks = continuousZlibChunks()
    let first = try zrle.zStream.decompressedData(
      compressedData: compressedChunks[0],
      uncompressedSize: 1_000
    )
    #expect(first == Data(repeating: 0x41, count: 1_000))
    let second = try zrle.zStream.decompressedData(
      compressedData: compressedChunks[1],
      uncompressedSize: 1_000
    )
    #expect(second == Data(repeating: 0x42, count: 1_000))

    let capabilityLength = Int(capabilityWriter.data[8])
    let capabilityPayload = Data(capabilityWriter.data[9..<(9 + capabilityLength)])
    try connection.handleServerFence(
      VNCProtocol.ServerFence(
        messageType: VNCProtocol.ServerFence.messageType,
        flags: [.blockBefore, .blockAfter],
        payload: capabilityPayload
      )
    )

    let continuedAfterPartialResponse = try zrle.zStream.decompressedData(
      compressedData: compressedChunks[2],
      uncompressedSize: 1_000
    )
    #expect(continuedAfterPartialResponse == Data(repeating: 0x43, count: 1_000))

    let trailingFenceOffset = 9 + capabilityLength + 20
    #expect(capabilityWriter.data[trailingFenceOffset] == VNCProtocol.ClientFence.messageType)
    #expect(
      capabilityWriter.data[(trailingFenceOffset + 4)..<(trailingFenceOffset + 8)]
        == Data([0x80, 0, 0, 1])
    )
    let trailingPayloadLength = Int(capabilityWriter.data[trailingFenceOffset + 8])
    let trailingPayload = Data(
      capabilityWriter.data[
        (trailingFenceOffset + 9)..<(trailingFenceOffset + 9 + trailingPayloadLength)
      ]
    )
    try connection.handleServerFence(
      VNCProtocol.ServerFence(
        messageType: VNCProtocol.ServerFence.messageType,
        flags: [.blockBefore],
        payload: trailingPayload
      )
    )

    try verifyFreshZRLEStream(zrle.zStream, byte: 0x44)
    connection.cancelFramebufferUpdateScheduling()
  }

  @Test
  func ignoresStaleZRLEResetFromLateCapabilityProbeResponse() async throws {
    let connection = VNCConnection(
      settings: makeSettings(frameEncodings: [.zrle, .raw]),
      framebufferAllocator: VNCFramebufferMallocAllocator()
    )
    let framebuffer = try makeFramebuffer(width: 2, height: 2, depth: 24)
    connection.framebuffer = framebuffer
    connection.state.pixelFormat = framebuffer.sourcePixelFormat
    connection.connectionState = .connected
    connection._framebufferUpdatePolicy = .paused
    let zrle = try #require(
      connection.encodings[VNCFrameEncodingType.zrle.rawValue] as? VNCProtocol.ZRLEEncoding
    )

    try connection.handleServerFence(
      VNCProtocol.ServerFence(
        messageType: VNCProtocol.ServerFence.messageType,
        flags: [.request, .blockBefore, .syncNext],
        payload: Data("support".utf8)
      )
    )
    _ = try #require(connection.clientToServerMessageQueue.dequeue())
    let capabilityProbe = try #require(connection.clientToServerMessageQueue.dequeue())
    try await capabilityProbe.message.send(connection: AuditWritingConnection())
    let capabilityPayload = try #require(connection.pixelFormatFenceCapabilityProbePayload)

    let compressedChunks = continuousZlibChunks()
    _ = try zrle.zStream.decompressedData(
      compressedData: compressedChunks[0],
      uncompressedSize: 1_000
    )
    connection.updateColorDepth(.depth8Bit)
    connection.expirePixelFormatFenceNegotiation()
    #expect(connection.connectionState.status == .disconnected)

    try connection.handleServerFence(
      VNCProtocol.ServerFence(
        messageType: VNCProtocol.ServerFence.messageType,
        flags: [.blockBefore, .syncNext],
        payload: capabilityPayload
      )
    )
    let continuedAfterLateProbe = try zrle.zStream.decompressedData(
      compressedData: compressedChunks[1],
      uncompressedSize: 1_000
    )
    #expect(continuedAfterLateProbe == Data(repeating: 0x42, count: 1_000))

    connection.cancelFramebufferUpdateScheduling()
  }

  @Test
  func rejectsPixelFormatFenceResponseBeforeRequestIsSent() async throws {
    let connection = try await makeFenceCapableConnection()

    connection.updateColorDepth(.depth8Bit)
    let queued = try #require(connection.clientToServerMessageQueue.dequeue())
    let payload = try #require(connection.pixelFormatTransitionFencePayload)

    #expect(throws: (any Error).self) {
      try connection.handleServerFence(
        VNCProtocol.ServerFence(
          messageType: VNCProtocol.ServerFence.messageType,
          flags: [.blockBefore, .syncNext],
          payload: payload
        )
      )
    }
    #expect(connection.state.pixelFormat?.depth == 24)

    try await queued.message.send(connection: AuditWritingConnection())
    connection.cancelFramebufferUpdateScheduling()
  }

  @Test
  func acceptsPixelFormatFenceResponseWhileWriteCompletes() async throws {
    let connection = try await makeFenceCapableConnection()

    connection.updateColorDepth(.depth8Bit)
    let queued = try #require(connection.clientToServerMessageQueue.dequeue())
    let payload = try #require(connection.pixelFormatTransitionFencePayload)
    connection.completeFramebufferUpdateRequest()
    var responseError: Error?
    let writer = AuditWritingConnection {
      do {
        try connection.handleServerFence(
          VNCProtocol.ServerFence(
            messageType: VNCProtocol.ServerFence.messageType,
            flags: [.blockBefore, .syncNext],
            payload: payload
          )
        )
      } catch {
        responseError = error
      }
    }

    try await queued.message.send(connection: writer)

    #expect(responseError == nil)
    #expect(connection.state.pixelFormat?.depth == 8)
    #expect(!connection.pixelFormatTransitionFenceWasSent)
  }

  @Test
  func rollsBackPixelFormatFenceWhenWriteFails() async throws {
    let connection = try await makeFenceCapableConnection()

    connection.updateColorDepth(.depth8Bit)
    let queued = try #require(connection.clientToServerMessageQueue.dequeue())

    await #expect(throws: AuditWriteError.self) {
      try await queued.message.send(connection: AuditFailingWritingConnection())
    }

    #expect(connection.isPixelFormatTransitionInFlight)
    #expect(!connection.pixelFormatTransitionFenceWasSent)
    #expect(connection.pixelFormatTransitionDeadlineTask == nil)
    connection.cancelFramebufferUpdateScheduling()
  }

  @Test
  func waitsForSlowFramebufferBoundaryBeforeArmingTransitionDeadline() async throws {
    let connection = try await makeFenceCapableConnection()

    connection.updateColorDepth(.depth8Bit)
    let queued = try #require(connection.clientToServerMessageQueue.dequeue())
    try await queued.message.send(connection: AuditWritingConnection())

    try await Task.sleep(nanoseconds: 100_000_000)
    #expect(connection.pixelFormatTransitionDeadlineTask == nil)
    #expect(connection.connectionState.status == .connected)

    connection.completeFramebufferUpdateRequest()
    #expect(connection.pixelFormatTransitionDeadlineTask != nil)

    connection.cancelFramebufferUpdateScheduling()
  }

  @Test
  func disconnectsWhenPixelFormatTransitionFenceIsMissing() async throws {
    let connection = try await makeFenceCapableConnection()

    connection.updateColorDepth(.depth8Bit)
    let queued = try #require(connection.clientToServerMessageQueue.dequeue())
    try await queued.message.send(connection: AuditWritingConnection())
    let payload = try #require(connection.pixelFormatTransitionFencePayload)

    #expect(connection.pixelFormatTransitionDeadlineTask == nil)
    #expect(connection.isPixelFormatTransitionInFlight)

    connection.expirePixelFormatTransitionDeadline(payload: payload)
    #expect(connection.connectionState.status == .connected)

    connection.completeFramebufferUpdateRequest()
    #expect(connection.pixelFormatTransitionDeadlineTask != nil)
    connection.expirePixelFormatTransitionDeadline(payload: payload)

    #expect(connection.connectionState.status == .disconnected)
    #expect(connection.pixelFormatTransitionDeadlineTask == nil)
    #expect(!connection.isPixelFormatTransitionInFlight)
  }

  @Test
  func cancellingFramebufferSchedulingInvalidatesPixelFormatTransitionDeadline() async throws {
    let connection = try await makeFenceCapableConnection()

    connection.updateColorDepth(.depth8Bit)
    let queued = try #require(connection.clientToServerMessageQueue.dequeue())
    try await queued.message.send(connection: AuditWritingConnection())
    let payload = try #require(connection.pixelFormatTransitionFencePayload)

    #expect(connection.pixelFormatTransitionDeadlineTask == nil)
    connection.completeFramebufferUpdateRequest()
    #expect(connection.pixelFormatTransitionDeadlineTask != nil)

    connection.cancelFramebufferUpdateScheduling()
    connection.expirePixelFormatTransitionDeadline(payload: payload)

    #expect(connection.pixelFormatTransitionDeadlineTask == nil)
    #expect(connection.connectionState.status == .connected)
  }

  @Test
  func waitsForOutstandingUpdateWhenSyncNextIsUnsupported() async throws {
    let connection = VNCConnection(
      settings: makeSettings(),
      framebufferAllocator: VNCFramebufferMallocAllocator()
    )
    let framebuffer = try makeFramebuffer(width: 2, height: 2, depth: 24)
    connection.framebuffer = framebuffer
    connection.state.pixelFormat = framebuffer.sourcePixelFormat
    connection.connectionState = .connected
    connection._framebufferUpdatePolicy = .paused
    connection.framebufferUpdateRequestOutstanding = true

    try connection.handleServerFence(
      VNCProtocol.ServerFence(
        messageType: VNCProtocol.ServerFence.messageType,
        flags: [.request],
        payload: Data()
      )
    )
    _ = try #require(connection.clientToServerMessageQueue.dequeue())
    let capabilityProbe = try #require(connection.clientToServerMessageQueue.dequeue())
    let capabilityWriter = AuditWritingConnection()
    try await capabilityProbe.message.send(connection: capabilityWriter)
    let capabilityLength = Int(capabilityWriter.data[8])
    let capabilityPayload = Data(capabilityWriter.data[9..<(9 + capabilityLength)])

    connection.updateColorDepth(.depth8Bit)
    #expect(connection.clientToServerMessageQueue.dequeue() == nil)

    try connection.handleServerFence(
      VNCProtocol.ServerFence(
        messageType: VNCProtocol.ServerFence.messageType,
        flags: [.blockBefore, .blockAfter],
        payload: capabilityPayload
      )
    )

    connection.completeFramebufferUpdateRequest()
    #expect(connection.clientToServerMessageQueue.dequeue() == nil)
    let trailingPayload = try #require(connection.pixelFormatFenceCapabilityProbePayload)
    try connection.handleServerFence(
      VNCProtocol.ServerFence(
        messageType: VNCProtocol.ServerFence.messageType,
        flags: [.blockBefore],
        payload: trailingPayload
      )
    )

    let transition = try #require(connection.clientToServerMessageQueue.dequeue())
    let transitionWriter = AuditWritingConnection {
      #expect(connection.state.pixelFormat?.depth == 8)
    }
    try await transition.message.send(connection: transitionWriter)
    #expect(connection.pixelFormatTransitionDeadlineTask == nil)
    #expect(
      transitionWriter.data[0]
        == VNCProtocol.SetPixelFormat(pixelFormat: framebuffer.sourcePixelFormat).messageType
    )
    #expect(transitionWriter.data[20] == VNCProtocol.SetEncodings(encodingTypes: []).messageType)
    #expect(connection.state.pixelFormat?.depth == 8)
    #expect(connection.state.pixelFormat?.depth == connection.framebuffer?.sourcePixelFormat.depth)
  }

  @Test
  func advertisesAndDecodesFenceExtension() async throws {
    let connection = VNCConnection(settings: makeSettings())
    #expect(try connection.orderedEncodingTypes().contains(VNCPseudoEncodingType.fence.rawValue))

    var body = Data([0, 0, 0])
    body.append(UInt32(0x8000_0004), bigEndian: true)
    body.append(UInt8(3))
    body.append(Data([1, 2, 3]))

    let fence = try await VNCProtocol.ServerFence.receive(
      connection: AuditBufferConnection(body)
    )

    #expect(fence.flags == [.request, .syncNext])
    #expect(fence.payload == Data([1, 2, 3]))
  }

  @Test
  func copyRectPreservesInternalFramebufferPixels() throws {
    let framebuffer = try makeFramebuffer(width: 2, height: 1, depth: 16)
    var redPixel = Data([0x00, 0x7C])
    framebuffer.update(
      region: VNCRegion(x: 0, y: 0, width: 1, height: 1),
      data: &redPixel
    )

    framebuffer.copy(
      region: VNCRegion(x: 0, y: 0, width: 1, height: 1),
      to: VNCRegion(x: 1, y: 0, width: 1, height: 1)
    )

    let pixels = Data(bytes: framebuffer.surfaceAddress, count: framebuffer.surfaceByteCount)
    #expect(pixels[0..<4] == pixels[4..<8])
  }

#if canImport(Network)
  @Test
  func returnsFinalNetworkContentBeforeReportingEOF() throws {
    let finalContent = Data([1, 2, 3])

    let received = try NWConnection.validateReadContent(
      finalContent,
      isComplete: true,
      error: nil,
      minimumLength: 1,
      maximumLength: 3
    )

    #expect(received == finalContent)
  }
#endif

  @Test
  func rejectsRepeatConnectAttempts() {
    let connection = VNCConnection(settings: makeSettings())
    connection.connectionState = .connecting

    #expect(connection.beginConnecting() == false)
  }

  @Test @MainActor
  func disconnectCancelsPendingCredentialContinuation() async {
    let connection = VNCConnection(settings: makeSettings())
    let delegate = PendingCredentialDelegate()
    connection.delegate = delegate

    let credentialTask = Task {
      try await connection.askDelegateForPasswordCredential(authenticationType: .vnc)
    }

    while delegate.completion == nil {
      await Task.yield()
    }

    connection.disconnect()

    do {
      _ = try await credentialTask.value
      Issue.record("Expected disconnect to cancel the pending credential request")
    } catch {
      #expect(connection.connectionState.status == .disconnected)
    }

    delegate.completion?(VNCPasswordCredential(password: "late"))
  }

  @Test @MainActor
  func unresolvedCredentialDelegateRequestDoesNotRetainConnection() async {
    var connection: VNCConnection? = VNCConnection(settings: makeSettings())
    weak var weakConnection = connection
    let delegate = PendingCredentialDelegate()
    connection?.delegate = delegate

    let request = connection!.beginCredentialRequest(authenticationType: .vnc)
    let credentialTask = Task {
      await request.value()
    }

    while delegate.completion == nil {
      await Task.yield()
    }

    connection = nil
    for _ in 0..<100 where weakConnection != nil {
      await Task.yield()
    }

    #expect(weakConnection == nil)
    #expect(await credentialTask.value == nil)

    delegate.completion?(VNCPasswordCredential(password: "late"))
  }

  @Test @MainActor
  func taskCancellationResolvesPendingCredentialRequest() async {
    let connection = VNCConnection(settings: makeSettings())
    let delegate = PendingCredentialDelegate()
    connection.delegate = delegate

    let credentialTask = Task {
      try await connection.askDelegateForPasswordCredential(authenticationType: .vnc)
    }

    while delegate.completion == nil {
      await Task.yield()
    }

    credentialTask.cancel()

    do {
      _ = try await credentialTask.value
      Issue.record("Expected task cancellation to resolve the pending credential request")
    } catch {
      #expect(credentialTask.isCancelled)
    }

    delegate.completion?(VNCPasswordCredential(password: "late"))
  }

  @Test
  func releasesResolvedCredentialAfterValueIsConsumed() async {
    let request = PendingCredentialRequest(onResolution: {})
    var credential: VNCPasswordCredential? = VNCPasswordCredential(password: "secret")
    weak var weakCredential = credential

    request.resolve(with: credential)
    credential = nil
    var received = await request.value() as? VNCPasswordCredential

    #expect(received === weakCredential)
    received = nil
    #expect(weakCredential == nil)
  }

  @Test
  func preservesAlreadyRGBAFormattedCursorChannels() {
    let cursor = VNCCursor(
      imageData: Data([0x11, 0x22, 0x33, 0x44]),
      size: VNCSize(width: 1, height: 1),
      hotspot: .zero,
      bitsPerComponent: 8,
      bitsPerPixel: 32,
      bytesPerPixel: 4
    )
    let destination = UnsafeMutableRawPointer.allocate(byteCount: 4, alignment: 1)
    defer { destination.deallocate() }

    cursor.copyPixelDataToRGBA32(destinationPixelBuffer: destination)

    #expect(Data(bytes: destination, count: 4) == Data([0x11, 0x22, 0x33, 0x44]))
  }

  private func makeFramebuffer(width: UInt16, height: UInt16, depth: UInt8) throws
    -> VNCFramebuffer
  {
    try VNCFramebuffer(
      logger: VNCPrintLogger(),
      size: VNCSize(width: width, height: height),
      screens: [],
      pixelFormat: VNCProtocol.PixelFormat(depth: depth),
      allocator: VNCFramebufferMallocAllocator()
    )
  }

  private func makeSettings(
    frameEncodings: [VNCFrameEncodingType] = [.raw]
  ) -> VNCConnection.Settings {
    VNCConnection.Settings(
      isDebugLoggingEnabled: false,
      hostname: "127.0.0.1",
      port: 5900,
      isShared: true,
      isScalingEnabled: true,
      useDisplayLink: false,
      inputMode: .none,
      isClipboardRedirectionEnabled: false,
      colorDepth: .depth24Bit,
      frameEncodings: frameEncodings
    )
  }

  private func makeFenceCapableConnection(
    settings: VNCConnection.Settings? = nil
  ) async throws -> VNCConnection {
    let connection = VNCConnection(
      settings: settings ?? makeSettings(),
      framebufferAllocator: VNCFramebufferMallocAllocator()
    )
    let framebuffer = try makeFramebuffer(width: 2, height: 2, depth: 24)
    connection.framebuffer = framebuffer
    connection.state.pixelFormat = framebuffer.sourcePixelFormat
    connection.connectionState = .connected
    connection._framebufferUpdatePolicy = .paused
    connection.framebufferUpdateRequestOutstanding = true

    try connection.handleServerFence(
      VNCProtocol.ServerFence(
        messageType: VNCProtocol.ServerFence.messageType,
        flags: [.request, .blockBefore, .syncNext],
        payload: Data("support".utf8)
      )
    )
    _ = try #require(connection.clientToServerMessageQueue.dequeue())
    let capabilityProbe = try #require(connection.clientToServerMessageQueue.dequeue())
    let capabilityWriter = AuditWritingConnection()
    try await capabilityProbe.message.send(connection: capabilityWriter)
    let capabilityLength = Int(capabilityWriter.data[8])
    let capabilityPayload = Data(capabilityWriter.data[9..<(9 + capabilityLength)])
    try connection.handleServerFence(
      VNCProtocol.ServerFence(
        messageType: VNCProtocol.ServerFence.messageType,
        flags: [.blockBefore, .syncNext],
        payload: capabilityPayload
      )
    )
    return connection
  }

  private func setEncodingValues(in data: Data, at offset: Int) -> [Int32] {
    let count = Int(data[offset + 2]) << 8 | Int(data[offset + 3])
    return (0..<count).map { index in
      let start = offset + 4 + index * 4
      let value =
        UInt32(data[start]) << 24
        | UInt32(data[start + 1]) << 16
        | UInt32(data[start + 2]) << 8
        | UInt32(data[start + 3])
      return Int32(bitPattern: value)
    }
  }

  private func setEncodingsEndOffset(in data: Data, at offset: Int) -> Int {
    offset + 4 + setEncodingValues(in: data, at: offset).count * 4
  }

  private func verifyFreshZRLEStream(_ stream: ZlibStream, byte: UInt8) throws {
    let expected = Data(repeating: byte, count: 64)
    let actual = try stream.decompressedData(
      compressedData: ZlibOneShot.deflate(expected),
      maximumOutputSize: expected.count
    )
    #expect(actual == expected)
  }

  private func continuousZlibChunks() -> [Data] {
    [
      Data([
        0x78, 0x9C, 0x72, 0x74, 0x1C, 0x05, 0xA3, 0x60, 0x14,
        0x0C, 0x77, 0, 0, 0, 0, 0xFF, 0xFF,
      ]),
      Data([
        0x72, 0x1A, 0x05, 0xA3, 0x60, 0x14, 0x0C,
        0x7B, 0, 0, 0, 0, 0xFF, 0xFF,
      ]),
      Data([
        0x72, 0x1E, 0x05, 0xA3, 0x60, 0x14, 0x0C,
        0x7B, 0, 0, 0, 0, 0xFF, 0xFF,
      ]),
    ]
  }
}

private final class AuditBufferConnection: NetworkConnectionReading {
  private let data: Data
  private var offset = 0

  init(_ data: Data) {
    self.data = data
  }

  func read(minimumLength: Int, maximumLength: Int) async throws -> Data {
    let remaining = data.count - offset
    guard minimumLength > 0,
          maximumLength >= minimumLength,
          remaining >= minimumLength else {
      throw VNCError.protocol(.noData)
    }

    let count = min(maximumLength, remaining)
    defer { offset += count }
    return data.subdata(in: offset..<(offset + count))
  }
}

private final class AuditWritingConnection: NetworkConnectionWriting {
  var data = Data()
  private let delayNanoseconds: UInt64
  private let onWrite: () -> Void

  init(delayNanoseconds: UInt64 = 0, onWrite: @escaping () -> Void = {}) {
    self.delayNanoseconds = delayNanoseconds
    self.onWrite = onWrite
  }

  func write(data: Data) async throws {
    if delayNanoseconds > 0 {
      try await Task.sleep(nanoseconds: delayNanoseconds)
    }
    onWrite()
    self.data.append(data)
  }
}

private final class AuditCallbackLogger: VNCLogger {
  var isDebugLoggingEnabled = false
  var onDebug: ((String) -> Void)?

  func logDebug(_ message: @autoclosure () -> String) {
    onDebug?(message())
  }

  func logInfo(_ message: String) {}
  func logWarning(_ message: String) {}
  func logError(_ message: String) {}
}

private struct AuditWriteError: Error {}

private final class AuditFailingWritingConnection: NetworkConnectionWriting {
  func write(data: Data) async throws {
    throw AuditWriteError()
  }
}

@MainActor
private final class PendingCredentialDelegate: VNCConnectionDelegate {
  var completion: ((VNCCredential?) -> Void)?

  func connection(
    _ connection: VNCConnection,
    stateDidChange connectionState: VNCConnection.ConnectionState
  ) {}

  func connection(
    _ connection: VNCConnection,
    credentialFor authenticationType: VNCAuthenticationType,
    completion: @escaping (VNCCredential?) -> Void
  ) {
    self.completion = completion
  }

  func connection(_ connection: VNCConnection, didCreateFramebuffer framebuffer: VNCFramebuffer) {}
  func connection(_ connection: VNCConnection, didResizeFramebuffer framebuffer: VNCFramebuffer) {}

  func connection(
    _ connection: VNCConnection,
    didUpdateFramebuffer framebuffer: VNCFramebuffer,
    x: UInt16,
    y: UInt16,
    width: UInt16,
    height: UInt16
  ) {}

  func connection(_ connection: VNCConnection, didUpdateCursor cursor: VNCCursor) {}
}
