import Foundation
import Testing

@testable import RoyalVNCKit

struct QualityControlTests {
  @Test
  func qualityControlCapabilityAndMessagesMatchCrabfleetWireValues() {
    #expect(VNCFrameEncodingType.crabfleetQualityControl.rawValue.int32Value == 0x5143_544c)
    #expect(VNCProtocol.QualityControl(mode: .auto).data == Data([201, 0, 0, 0]))
    #expect(VNCProtocol.QualityControl(mode: .sharp).data == Data([201, 1, 0, 0]))
    #expect(VNCProtocol.QualityControl(mode: .smooth).data == Data([201, 2, 0, 0]))
  }

  @Test
  func qualityControlCapabilityRequiresVersionOneAndZeroPadding() async throws {
    _ = try await VNCProtocol.QualityControlCapability.receive(
      connection: QualityCapabilityBuffer(Data([1, 0, 0])))
    await #expect(throws: (any Error).self) {
      try await VNCProtocol.QualityControlCapability.receive(
        connection: QualityCapabilityBuffer(Data([2, 0, 0])))
    }
    await #expect(throws: (any Error).self) {
      try await VNCProtocol.QualityControlCapability.receive(
        connection: QualityCapabilityBuffer(Data([1, 0, 1])))
    }
  }
}

private final class QualityCapabilityBuffer: NetworkConnectionReading {
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
