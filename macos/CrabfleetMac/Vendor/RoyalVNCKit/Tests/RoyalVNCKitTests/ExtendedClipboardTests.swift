import Foundation
import Testing

@testable import RoyalVNCKit

struct ExtendedClipboardTests {
  @Test
  func capsBodyAnnouncesTextFormatAndAllActions() {
    let body = VNCExtendedClipboard.encodeCaps(maximumUnsolicitedTextBytes: 1_048_576)

    #expect(
      body == Data([
        0x1F, 0x00, 0x00, 0x01,  // caps|request|peek|notify|provide + text
        0x00, 0x10, 0x00, 0x00,  // 1 MiB unsolicited text limit
      ])
    )
  }

  @Test
  func provideRoundtripPreservesUnicodeTextAndNewlines() throws {
    let text = "héllo 🦀\nsecond line\twith tab"
    let body = try VNCExtendedClipboard.encodeProvide(text: text)

    let message = try VNCExtendedClipboard.decode(body: body)

    #expect(message == .provide(text: text))
  }

  @Test
  func provideNormalizesCarriageReturnLineFeedPairs() throws {
    let body = try VNCExtendedClipboard.encodeProvide(text: "a\r\nb\nc")

    let message = try VNCExtendedClipboard.decode(body: body)

    #expect(message == .provide(text: "a\nb\nc"))
  }

  @Test
  func decodeParsesServerCapsAndPerFormatLimits() throws {
    var body = Data()
    let flags =
      VNCExtendedClipboard.capsAction
      | VNCExtendedClipboard.provideAction
      | VNCExtendedClipboard.requestAction
      | VNCExtendedClipboard.textFormat
    var bigEndianFlags = flags.bigEndian
    withUnsafeBytes(of: &bigEndianFlags) { body.append(contentsOf: $0) }
    var bigEndianSize = UInt32(4_096).bigEndian
    withUnsafeBytes(of: &bigEndianSize) { body.append(contentsOf: $0) }

    guard case .caps(let caps) = try VNCExtendedClipboard.decode(body: body) else {
      Issue.record("expected caps message")
      return
    }

    #expect(caps.supportsText)
    #expect(caps.maximumUnsolicitedTextBytes == 4_096)
    #expect(caps.supportsProvide)
    #expect(caps.supportsRequest)
    #expect(!caps.supportsNotify)
    #expect(caps.allowsUnsolicitedText(byteCount: 4_096))
    #expect(!caps.allowsUnsolicitedText(byteCount: 4_097))
  }

  @Test
  func decodeParsesFlagOnlyActions() throws {
    #expect(
      try VNCExtendedClipboard.decode(body: VNCExtendedClipboard.encodeRequestText())
        == .request(text: true)
    )
    #expect(
      try VNCExtendedClipboard.decode(body: VNCExtendedClipboard.encodePeek()) == .peek
    )
    #expect(
      try VNCExtendedClipboard.decode(body: VNCExtendedClipboard.encodeNotify(hasText: true))
        == .notify(text: true)
    )
    #expect(
      try VNCExtendedClipboard.decode(body: VNCExtendedClipboard.encodeNotify(hasText: false))
        == .notify(text: false)
    )
  }

  @Test
  func decodeRejectsTruncatedAndAmbiguousBodies() {
    #expect(throws: VNCExtendedClipboardError.bodyTooShort) {
      _ = try VNCExtendedClipboard.decode(body: Data([0x02, 0x00]))
    }

    let twoActions =
      VNCExtendedClipboard.requestAction | VNCExtendedClipboard.notifyAction
    var body = Data()
    var bigEndianFlags = twoActions.bigEndian
    withUnsafeBytes(of: &bigEndianFlags) { body.append(contentsOf: $0) }

    #expect(throws: VNCExtendedClipboardError.unknownAction(flags: twoActions)) {
      _ = try VNCExtendedClipboard.decode(body: body)
    }
  }

  @Test
  func provideWithoutTextFormatYieldsNilText() throws {
    var body = Data()
    let flags = VNCExtendedClipboard.provideAction | (1 << 2)  // HTML only
    var bigEndianFlags = UInt32(flags).bigEndian
    withUnsafeBytes(of: &bigEndianFlags) { body.append(contentsOf: $0) }
    body.append(try ZlibOneShot.deflate(Data([0, 0, 0, 0])))

    let message = try VNCExtendedClipboard.decode(body: body)

    #expect(message == .provide(text: nil))
  }

  @Test
  func encodeProvideRejectsOversizedText() {
    let oversized = String(repeating: "a", count: VNCExtendedClipboard.maximumTextBytes)

    #expect(throws: VNCExtendedClipboardError.textTooLarge) {
      _ = try VNCExtendedClipboard.encodeProvide(text: oversized)
    }
  }

  @Test
  func textRouteHonorsPeerReceivableActions() {
    func caps(actions: UInt32, unsolicited: UInt32 = 1_024) -> VNCExtendedClipboardCaps {
      .init(supportsText: true, maximumUnsolicitedTextBytes: unsolicited, actions: actions)
    }

    let allActions =
      VNCExtendedClipboard.provideAction
      | VNCExtendedClipboard.notifyAction
      | VNCExtendedClipboard.requestAction

    #expect(
      VNCExtendedClipboard.textRoute(wireByteCount: 100, caps: caps(actions: allActions))
        == .provide
    )
    // Payload beyond the unsolicited limit downgrades to notify.
    #expect(
      VNCExtendedClipboard.textRoute(wireByteCount: 2_048, caps: caps(actions: allActions))
        == .notify
    )
    // Peers that never advertised provide must not receive one.
    #expect(
      VNCExtendedClipboard.textRoute(
        wireByteCount: 100,
        caps: caps(actions: VNCExtendedClipboard.notifyAction)
      ) == .notify
    )
    // Neither provide nor notify receivable: fall back to legacy cut text.
    #expect(
      VNCExtendedClipboard.textRoute(
        wireByteCount: 100,
        caps: caps(actions: VNCExtendedClipboard.requestAction)
      ) == .legacy
    )
    // No text format at all: legacy.
    #expect(
      VNCExtendedClipboard.textRoute(
        wireByteCount: 100,
        caps: .init(supportsText: false, maximumUnsolicitedTextBytes: 0, actions: allActions)
      ) == .legacy
    )
  }

  @Test
  func wireTextByteCountCountsCRLFExpansionAndNul() {
    #expect(VNCExtendedClipboard.wireTextByteCount("") == 1)
    #expect(VNCExtendedClipboard.wireTextByteCount("ab") == 3)
    #expect(VNCExtendedClipboard.wireTextByteCount("a\nb") == 5)
  }

  @Test
  func frameUsesNegativeBigEndianLength() {
    let framed = VNCExtendedClipboard.frame(messageType: 6, body: Data([0xAA, 0xBB]))

    #expect(framed == Data([6, 0, 0, 0, 0xFF, 0xFF, 0xFF, 0xFE, 0xAA, 0xBB]))
  }

  @Test
  func inflateEnforcesDecompressionCap() throws {
    let compressed = try ZlibOneShot.deflate(Data(count: 100_000))

    #expect(throws: (any Error).self) {
      _ = try ZlibOneShot.inflate(compressed, maximumDecompressedBytes: 10_000)
    }

    let roundtrip = try ZlibOneShot.inflate(compressed, maximumDecompressedBytes: 100_000)
    #expect(roundtrip == Data(count: 100_000))
  }

  @Test
  func receivesExtendedProvideThroughServerCutText() async throws {
    let body = try VNCExtendedClipboard.encodeProvide(text: "π ≠ 3 🚀")
    var payload = Data([0, 0, 0])
    var bigEndianLength = Int32(-body.count).bigEndian
    withUnsafeBytes(of: &bigEndianLength) { payload.append(contentsOf: $0) }
    payload.append(body)

    let message = try await VNCProtocol.ServerCutText.receive(
      connection: ExtendedClipboardBufferConnection(payload),
      logger: VNCPrintLogger()
    )

    #expect(message.extended == .provide(text: "π ≠ 3 🚀"))
  }
}

private final class ExtendedClipboardBufferConnection: NetworkConnectionReading {
  private let data: Data
  private var offset = 0

  init(_ data: Data) {
    self.data = data
  }

  func read(minimumLength: Int, maximumLength: Int) async throws -> Data {
    let remaining = data.count - offset
    guard minimumLength > 0, maximumLength >= minimumLength, remaining >= minimumLength else {
      throw VNCError.protocol(.noData)
    }

    let count = min(maximumLength, remaining)
    defer { offset += count }
    return data.subdata(in: offset..<(offset + count))
  }
}
