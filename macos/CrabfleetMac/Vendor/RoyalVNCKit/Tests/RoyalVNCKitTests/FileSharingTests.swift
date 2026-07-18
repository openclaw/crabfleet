import Foundation
import Testing

@testable import RoyalVNCKit

struct FileSharingTests {
  @Test
  func requestsMatchHostAndBrowserWireFrames() throws {
    #expect(VNCFrameEncodingType.crabfleetFileSharing.rawValue.int32Value == 0x4653_4831)
    #expect(
      try VNCProtocol.FileSharingRequest.list(id: 0x0102_0304, path: "nested").data
        == Data([202, 1, 0, 0, 1, 2, 3, 4, 0, 6]) + Data("nested".utf8))
    #expect(
      try VNCProtocol.FileSharingRequest.putChunk(id: 8, bytes: Data([1, 2, 3])).data
        == Data([202, 4, 0, 0, 0, 0, 0, 8, 0, 0, 0, 3, 1, 2, 3]))
    #expect(
      VNCProtocol.FileSharingRequest.putEnd(id: 8).data
        == Data([202, 5, 0, 0, 0, 0, 0, 8]))
    #expect(
      VNCProtocol.FileSharingRequest.putAbort(id: 8).data
        == Data([202, 7, 0, 0, 0, 0, 0, 8]))
    #expect(try VNCProtocol.FileSharingRequest.mkdir(id: 9, path: "New Folder").data[1] == 6)
  }

  @Test
  func responsesDecodeWithStrictBounds() async throws {
    let capability = try await VNCProtocol.FileSharing.receive(
      connection: FileSharingBuffer(Data([1, 1, 0, 0, 6]) + Data("Shared".utf8)))
    #expect(capability.message == .capability(displayName: "Shared", allowWrites: true))

    var listing = Data([2, 0, 0, 0, 0, 0, 9, 0, 1, 0, 8])
    listing.append(Data("file.txt".utf8))
    listing.append(contentsOf: [0, 0, 0, 0])
    listing.append(contentsOf: [0, 0, 0, 0, 0, 0, 0, 7])
    listing.append(contentsOf: [0, 0, 0, 0, 0, 0, 0, 10])
    let response = try await VNCProtocol.FileSharing.receive(
      connection: FileSharingBuffer(listing))
    #expect(response.message == .list(
      id: 9,
      entries: [.init(
        name: "file.txt", isDirectory: false, size: 7,
        modificationTimeMilliseconds: 10)]))

    await #expect(throws: (any Error).self) {
      try await VNCProtocol.FileSharing.receive(
        connection: FileSharingBuffer(Data([1, 1, 1, 0, 1, 65])))
    }
    await #expect(throws: (any Error).self) {
      try await VNCProtocol.FileSharing.receive(
        connection: FileSharingBuffer(Data([3, 0, 0, 0, 0, 0, 1])
          + Data(repeating: 0, count: 8)
          + Data([0, 4, 0, 1])))
    }
  }
}

private final class FileSharingBuffer: NetworkConnectionReading {
  private let data: Data
  private var offset = 0

  init(_ data: Data) { self.data = data }

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
