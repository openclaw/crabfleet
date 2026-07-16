import Foundation
import RoyalVNCKit

enum RFBVersion: Comparable, Sendable {
  case v3Point3
  case v3Point7
  case v3Point8

  static let serverBanner = Data("RFB 003.008\n".utf8)

  init?(banner: Data) {
    guard banner.count == 12 else { return nil }
    switch String(decoding: banner, as: UTF8.self) {
    case "RFB 003.003\n": self = .v3Point3
    case "RFB 003.007\n": self = .v3Point7
    case "RFB 003.008\n": self = .v3Point8
    default: return nil
    }
  }
}

struct RFBPixelFormat: Equatable, Sendable {
  let bitsPerPixel: UInt8
  let depth: UInt8
  let bigEndian: Bool
  let trueColor: Bool
  let redMax: UInt16
  let greenMax: UInt16
  let blueMax: UInt16
  let redShift: UInt8
  let greenShift: UInt8
  let blueShift: UInt8

  init(
    bitsPerPixel: UInt8,
    depth: UInt8,
    bigEndian: Bool,
    trueColor: Bool,
    redMax: UInt16,
    greenMax: UInt16,
    blueMax: UInt16,
    redShift: UInt8,
    greenShift: UInt8,
    blueShift: UInt8
  ) {
    self.bitsPerPixel = bitsPerPixel
    self.depth = depth
    self.bigEndian = bigEndian
    self.trueColor = trueColor
    self.redMax = redMax
    self.greenMax = greenMax
    self.blueMax = blueMax
    self.redShift = redShift
    self.greenShift = greenShift
    self.blueShift = blueShift
  }

  static let bgra8888 = RFBPixelFormat(
    bitsPerPixel: 32,
    depth: 24,
    bigEndian: false,
    trueColor: true,
    redMax: 255,
    greenMax: 255,
    blueMax: 255,
    redShift: 16,
    greenShift: 8,
    blueShift: 0
  )

  init?(data: Data) {
    guard data.count == 16 else { return nil }
    bitsPerPixel = data[0]
    depth = data[1]
    bigEndian = data[2] != 0
    trueColor = data[3] != 0
    redMax = data.readUInt16(at: 4)
    greenMax = data.readUInt16(at: 6)
    blueMax = data.readUInt16(at: 8)
    redShift = data[10]
    greenShift = data[11]
    blueShift = data[12]
  }

  var data: Data {
    var value = Data()
    value.append(bitsPerPixel)
    value.append(depth)
    value.append(bigEndian ? 1 : 0)
    value.append(trueColor ? 1 : 0)
    value.appendBigEndian(redMax)
    value.appendBigEndian(greenMax)
    value.appendBigEndian(blueMax)
    value.append(redShift)
    value.append(greenShift)
    value.append(blueShift)
    value.append(contentsOf: [0, 0, 0])
    return value
  }
}

enum RFBWire {
  static let tightEncoding: Int32 = 7
  static let openH264Encoding: Int32 = 50
  static let crabfleetAudioEncoding: Int32 = 0x4341_4631
  static let extendedDesktopSizeEncoding: Int32 = -308
  static let extendedClipboardEncoding = Int32(bitPattern: 0xc0a1_e5ce)
  static let maximumClipboardBytes = 1 * 1_024 * 1_024
  static let maximumAudioPayloadBytes = 64 * 1_024

  enum FrameEncodingSelection: Equatable, Sendable {
    case openH264
    case tight
  }

  /// Flags word plus the codec's bounded compressed payload.
  static let maximumExtendedClipboardBodyBytes = 4 + VNCExtendedClipboard.maximumBodyBytes

  static func serverInit(width: Int, height: Int, name: String) throws -> Data {
    guard
      (1...Int(UInt16.max)).contains(width),
      (1...Int(UInt16.max)).contains(height)
    else {
      throw PrivateMacShareError.protocolError("invalid framebuffer dimensions")
    }
    let nameData = Data(name.utf8)
    guard nameData.count <= 4_096 else {
      throw PrivateMacShareError.protocolError("desktop name is too long")
    }

    var data = Data()
    data.appendBigEndian(UInt16(width))
    data.appendBigEndian(UInt16(height))
    data.append(RFBPixelFormat.bgra8888.data)
    data.appendBigEndian(UInt32(nameData.count))
    data.append(nameData)
    return data
  }

  static func preferredFrameEncoding(
    from encodings: [Int32],
    videoPathBroken: Bool = false
  ) -> FrameEncodingSelection? {
    if !videoPathBroken, encodings.contains(openH264Encoding) { return .openH264 }
    if encodings.contains(tightEncoding) { return .tight }
    return nil
  }

  static func shouldStreamAudio(hostEnabled: Bool, encodings: [Int32]) -> Bool {
    hostEnabled && encodings.contains(crabfleetAudioEncoding)
  }

  static func audioConfig(channels: UInt8, sampleRate: UInt32, magicCookie: Data) throws -> Data {
    guard (1...2).contains(channels), (8_000...192_000).contains(sampleRate),
      magicCookie.count <= maximumAudioPayloadBytes
    else {
      throw PrivateMacShareError.protocolError("invalid audio configuration")
    }

    var data = Data(capacity: 12 + magicCookie.count)
    data.append(200)
    data.append(1)
    data.append(1)  // AAC-LC
    data.append(channels)
    data.appendBigEndian(sampleRate)
    data.appendBigEndian(UInt32(magicCookie.count))
    data.append(magicCookie)
    return data
  }

  static func audioPacket(timestampMs: UInt32, payload: Data) throws -> Data {
    guard !payload.isEmpty, payload.count <= maximumAudioPayloadBytes else {
      throw PrivateMacShareError.protocolError("invalid audio packet")
    }

    var data = Data(capacity: 12 + payload.count)
    data.append(200)
    data.append(2)
    data.append(contentsOf: [0, 0])
    data.appendBigEndian(timestampMs)
    data.appendBigEndian(UInt32(payload.count))
    data.append(payload)
    return data
  }

  static func audioStop() -> Data {
    Data([200, 3, 0, 0])
  }

  static func tightJPEGUpdate(frame: CapturedDesktopFrame) throws -> Data {
    guard
      (1...Int(UInt16.max)).contains(frame.width),
      (1...Int(UInt16.max)).contains(frame.height),
      !frame.jpegData.isEmpty,
      frame.jpegData.count < 1 << 22
    else {
      throw PrivateMacShareError.protocolError("invalid Tight JPEG frame")
    }

    var data = Data(capacity: frame.jpegData.count + 24)
    data.append(0)  // FramebufferUpdate
    data.append(0)  // padding
    data.appendBigEndian(UInt16(1))
    data.appendBigEndian(UInt16(0))
    data.appendBigEndian(UInt16(0))
    data.appendBigEndian(UInt16(frame.width))
    data.appendBigEndian(UInt16(frame.height))
    data.appendBigEndian(tightEncoding)
    data.append(0x90)  // Tight JPEG subencoding
    data.append(tightCompactLength(frame.jpegData.count))
    data.append(frame.jpegData)
    return data
  }

  /// FramebufferUpdate with zero rectangles: a legal no-op that answers an
  /// outstanding update request when the screen has not changed, so idle
  /// sessions stay responsive without resending pixels.
  static func emptyUpdate() -> Data {
    Data([0, 0, 0, 0])
  }

  static func openH264Update(
    width: Int,
    height: Int,
    payload: Data,
    flags: UInt32
  ) throws -> Data {
    guard
      (1...Int(UInt16.max)).contains(width),
      (1...Int(UInt16.max)).contains(height),
      !payload.isEmpty,
      payload.count < 16 * 1_024 * 1_024
    else {
      throw PrivateMacShareError.protocolError("invalid Open H.264 frame")
    }

    var data = Data(capacity: payload.count + 24)
    data.append(0)
    data.append(0)
    data.appendBigEndian(UInt16(1))
    data.appendBigEndian(UInt16(0))
    data.appendBigEndian(UInt16(0))
    data.appendBigEndian(UInt16(width))
    data.appendBigEndian(UInt16(height))
    data.appendBigEndian(openH264Encoding)
    data.appendBigEndian(UInt32(payload.count))
    data.appendBigEndian(flags)
    data.append(payload)
    return data
  }

  /// FramebufferUpdate carrying a single ExtendedDesktopSize pseudo-rectangle.
  /// `reason` and `status` use the RFB screen-layout codes; the single screen
  /// uses a stable non-zero id so clients register a screen-layout change.
  static func extendedDesktopSizeUpdate(
    reason: UInt16,
    status: UInt16,
    width: Int,
    height: Int
  ) throws -> Data {
    guard
      (1...Int(UInt16.max)).contains(width),
      (1...Int(UInt16.max)).contains(height)
    else {
      throw PrivateMacShareError.protocolError("invalid desktop size")
    }

    var data = Data(capacity: 36)
    data.append(0)  // FramebufferUpdate
    data.append(0)  // padding
    data.appendBigEndian(UInt16(1))
    data.appendBigEndian(reason)
    data.appendBigEndian(status)
    data.appendBigEndian(UInt16(width))
    data.appendBigEndian(UInt16(height))
    data.appendBigEndian(extendedDesktopSizeEncoding)
    data.append(1)  // number of screens
    data.append(contentsOf: [0, 0, 0])
    data.appendBigEndian(UInt32(1))  // screen id
    data.appendBigEndian(UInt16(0))
    data.appendBigEndian(UInt16(0))
    data.appendBigEndian(UInt16(width))
    data.appendBigEndian(UInt16(height))
    data.appendBigEndian(UInt32(0))  // flags
    return data
  }

  /// Legacy Latin-1 ServerCutText. Returns nil when the text cannot be
  /// represented losslessly or exceeds the clipboard limit.
  static func legacyServerCutText(text: String) -> Data? {
    guard let encoded = text.data(using: .isoLatin1),
      encoded.count <= maximumClipboardBytes
    else {
      return nil
    }

    var data = Data(capacity: 8 + encoded.count)
    data.append(3)  // ServerCutText
    data.append(contentsOf: [0, 0, 0])
    data.appendBigEndian(UInt32(encoded.count))
    data.append(encoded)
    return data
  }

  static func tightCompactLength(_ length: Int) -> Data {
    precondition((0..<(1 << 22)).contains(length))
    var remaining = length
    var data = Data()
    var byte = UInt8(remaining & 0x7F)
    remaining >>= 7
    if remaining > 0 { byte |= 0x80 }
    data.append(byte)
    guard remaining > 0 else { return data }

    byte = UInt8(remaining & 0x7F)
    remaining >>= 7
    if remaining > 0 { byte |= 0x80 }
    data.append(byte)
    if remaining > 0 { data.append(UInt8(remaining & 0xFF)) }
    return data
  }
}

extension Data {
  mutating func appendBigEndian<T: FixedWidthInteger>(_ value: T) {
    var bigEndian = value.bigEndian
    Swift.withUnsafeBytes(of: &bigEndian) { append(contentsOf: $0) }
  }

  func readUInt16(at offset: Int) -> UInt16 {
    (UInt16(self[offset]) << 8) | UInt16(self[offset + 1])
  }

  func readUInt32(at offset: Int) -> UInt32 {
    (UInt32(self[offset]) << 24)
      | (UInt32(self[offset + 1]) << 16)
      | (UInt32(self[offset + 2]) << 8)
      | UInt32(self[offset + 3])
  }

  func readInt32(at offset: Int) -> Int32 {
    Int32(bitPattern: readUInt32(at: offset))
  }
}
