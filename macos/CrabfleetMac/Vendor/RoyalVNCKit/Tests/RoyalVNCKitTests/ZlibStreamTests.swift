import Foundation
import Testing

@testable import RoyalVNCKit

struct ZlibStreamTests {
  @Test
  func resetsCompletedStreamsWithoutAffectingAnotherDecoder() throws {
    let firstStream = ZlibStream()
    let secondStream = ZlibStream()
    let firstPayload = Data(repeating: 0x41, count: 2_048)
    let secondPayload = Data(repeating: 0x42, count: 4_096)
    let firstCompressed = try ZlibOneShot.deflate(firstPayload)
    let secondCompressed = try ZlibOneShot.deflate(secondPayload)

    #expect(try firstStream.decompressedData(
      compressedData: firstCompressed,
      uncompressedSize: UInt(firstPayload.count)
    ) == firstPayload)
    let split = secondCompressed.count / 2
    let prefix = try secondStream.decompressedData(
      compressedData: Data(secondCompressed.prefix(split)),
      maximumOutputSize: secondPayload.count
    )
    try firstStream.reset()
    let suffix = try secondStream.decompressedData(
      compressedData: Data(secondCompressed.dropFirst(split)),
      maximumOutputSize: secondPayload.count
    )
    #expect(prefix + suffix == secondPayload)
    #expect(try firstStream.decompressedData(
      compressedData: secondCompressed,
      uncompressedSize: UInt(secondPayload.count)
    ) == secondPayload)
  }
}
