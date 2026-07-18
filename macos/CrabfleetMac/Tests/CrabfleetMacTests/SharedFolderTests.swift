import Foundation
import Testing

@testable import CrabfleetMac

@Suite("Shared folder")
struct SharedFolderTests {
  @Test("paths reject traversal, absolute paths, and symlink escapes")
  func pathContainment() async throws {
    let fixture = try FolderFixture()
    let session = SharedFolderSession(configuration: fixture.configuration)
    let outside = fixture.container.appendingPathComponent("outside.txt")
    try Data("secret".utf8).write(to: outside)
    try FileManager.default.createSymbolicLink(
      at: fixture.root.appendingPathComponent("escape"), withDestinationURL: outside)

    for path in ["../outside.txt", "/etc/passwd", "nested/../../outside.txt", "./file.txt"] {
      await #expect(throws: (any Error).self) { _ = try await session.resolveExistingPath(path) }
    }
    await #expect(throws: (any Error).self) {
      _ = try await session.resolveExistingPath("escape")
    }
    let valid = try await session.resolveExistingPath("file.txt")
    #expect(valid.path == fixture.root.appendingPathComponent("file.txt").path)

    let filesystemRoot = SharedFolderSession(configuration: .init(
      rootURL: URL(fileURLWithPath: "/"), displayName: "/", allowWrites: false))
    #expect(try await filesystemRoot.resolveExistingPath("tmp").path.hasPrefix("/"))
  }

  @Test("LIST GET and PUT frames are byte exact and bounded")
  func wireFrames() async throws {
    let list = try RFBFileSharingWire.listRequest(id: 0x0102_0304, path: "nested")
    #expect(Array(list.prefix(10)) == [202, 1, 0, 0, 1, 2, 3, 4, 0, 6])
    #expect(String(data: list.suffix(6), encoding: .utf8) == "nested")
    #expect(try await decode(list) == .list(id: 0x0102_0304, path: "nested"))

    let get = try RFBFileSharingWire.getRequest(
      id: 7, path: "file.txt", offset: 0x0102_0304, length: 65_536)
    #expect(try await decode(get) == .get(
      id: 7, path: "file.txt", offset: 0x0102_0304, length: 65_536))

    let begin = try RFBFileSharingWire.putBeginRequest(id: 8, path: "upload.bin", size: 9)
    #expect(try await decode(begin) == .putBegin(id: 8, path: "upload.bin", size: 9))
    let chunk = try RFBFileSharingWire.putChunkRequest(id: 8, bytes: Data([1, 2, 3]))
    #expect(try await decode(chunk) == .putChunk(id: 8, bytes: Data([1, 2, 3])))
    #expect(try await decode(RFBFileSharingWire.putEndRequest(id: 8)) == .putEnd(id: 8))
    #expect(try await decode(RFBFileSharingWire.putAbortRequest(id: 8)) == .putAbort(id: 8))

    #expect(throws: SharedFolderError.self) {
      try RFBFileSharingWire.getRequest(
        id: 1, path: "file", offset: 0,
        length: UInt32(RFBFileSharingWire.maximumChunkBytes + 1))
    }
    #expect(throws: SharedFolderError.self) {
      try RFBFileSharingWire.putBeginRequest(
        id: 1, path: "file", size: RFBFileSharingWire.maximumFileBytes + 1)
    }
  }

  @Test("malformed request framing fails")
  func malformedFrames() async throws {
    var invalidPadding = try RFBFileSharingWire.listRequest(id: 1, path: "")
    invalidPadding[2] = 1
    await #expect(throws: SharedFolderError.self) { _ = try await decode(invalidPadding) }

    var oversizedChunk = Data([202, 4, 0, 0])
    oversizedChunk.appendBigEndian(UInt32(1))
    oversizedChunk.appendBigEndian(UInt32(RFBFileSharingWire.maximumChunkBytes + 1))
    await #expect(throws: SharedFolderError.self) { _ = try await decode(oversizedChunk) }
  }

  @Test("PUT is atomic and abort removes partial data")
  func atomicPutAndAbort() async throws {
    let fixture = try FolderFixture()
    let destination = fixture.root.appendingPathComponent("upload.txt")
    try Data("old".utf8).write(to: destination)
    let session = SharedFolderSession(configuration: fixture.configuration)

    _ = await session.handle(.putBegin(id: 1, path: "upload.txt", size: 6))
    _ = await session.handle(.putChunk(id: 1, bytes: Data("new".utf8)))
    #expect(try String(contentsOf: destination, encoding: .utf8) == "old")
    await session.abort()
    #expect(try String(contentsOf: destination, encoding: .utf8) == "old")
    #expect(try FileManager.default.contentsOfDirectory(atPath: fixture.root.path).allSatisfy {
      !$0.hasPrefix(".crabfleet-upload-")
    })

    _ = await session.handle(.putBegin(id: 2, path: "aborted.txt", size: 3))
    _ = await session.handle(.putChunk(id: 2, bytes: Data("new".utf8)))
    #expect((await session.handle(.putAbort(id: 2)))[1] == 4)
    #expect(!FileManager.default.fileExists(atPath: fixture.root.appendingPathComponent("aborted.txt").path))

    _ = await session.handle(.putBegin(id: 3, path: "upload.txt", size: 6))
    _ = await session.handle(.putChunk(id: 3, bytes: Data("newest".utf8)))
    _ = await session.handle(.putEnd(id: 3))
    #expect(try String(contentsOf: destination, encoding: .utf8) == "newest")

    let directory = fixture.root.appendingPathComponent("keep")
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
    try Data("safe".utf8).write(to: directory.appendingPathComponent("child.txt"))
    let rejected = await session.handle(.putBegin(id: 4, path: "keep", size: 3))
    #expect(rejected[1] == 255)
    #expect(try String(contentsOf: directory.appendingPathComponent("child.txt"), encoding: .utf8) == "safe")

    let nested = fixture.root.appendingPathComponent("nested")
    let movedNested = fixture.root.appendingPathComponent("nested-original")
    let outsideDirectory = fixture.container.appendingPathComponent("outside")
    try FileManager.default.createDirectory(at: nested, withIntermediateDirectories: false)
    try FileManager.default.createDirectory(at: outsideDirectory, withIntermediateDirectories: false)
    _ = await session.handle(.putBegin(id: 5, path: "nested/race.txt", size: 3))
    try FileManager.default.moveItem(at: nested, to: movedNested)
    try FileManager.default.createSymbolicLink(at: nested, withDestinationURL: outsideDirectory)
    _ = await session.handle(.putChunk(id: 5, bytes: Data("new".utf8)))
    #expect((await session.handle(.putEnd(id: 5)))[1] == 255)
    #expect(!FileManager.default.fileExists(atPath: outsideDirectory.appendingPathComponent("race.txt").path))
    #expect((await session.handle(.mkdir(id: 6, path: "nested/new-directory")))[1] == 255)
    #expect(!FileManager.default.fileExists(
      atPath: outsideDirectory.appendingPathComponent("new-directory").path))
  }

  @Test("loopback LIST GET and PUT operate on fixture root")
  func loopbackOperations() async throws {
    let fixture = try FolderFixture()
    let session = SharedFolderSession(configuration: fixture.configuration)
    let oversized = fixture.root.appendingPathComponent("too-large.bin")
    FileManager.default.createFile(atPath: oversized.path, contents: nil)
    let oversizedHandle = try FileHandle(forWritingTo: oversized)
    try oversizedHandle.truncate(atOffset: RFBFileSharingWire.maximumFileBytes + 1)
    try oversizedHandle.close()
    let outside = fixture.container.appendingPathComponent("outside.txt")
    try Data("secret".utf8).write(to: outside)
    try FileManager.default.createSymbolicLink(
      at: fixture.root.appendingPathComponent("escape"), withDestinationURL: outside)

    let list = await session.handle(.list(id: 1, path: ""))
    #expect(list[0] == 202)
    #expect(list[1] == 2)
    #expect(list.readUInt16(at: 8) == 1)

    let escapedGet = await session.handle(.get(id: 9, path: "escape", offset: 0, length: 256))
    #expect(escapedGet[1] == 255)

    let get = await session.handle(.get(id: 2, path: "file.txt", offset: 0, length: 256))
    #expect(get[1] == 3)
    #expect(get[3] == 1)
    #expect(String(data: get.suffix(7), encoding: .utf8) == "fixture")

    _ = await session.handle(.putBegin(id: 3, path: "received.txt", size: 8))
    _ = await session.handle(.putChunk(id: 3, bytes: Data("uploaded".utf8)))
    _ = await session.handle(.putEnd(id: 3))
    #expect(
      try String(
        contentsOf: fixture.root.appendingPathComponent("received.txt"), encoding: .utf8)
        == "uploaded")
  }

  private func decode(_ frame: Data) async throws -> RFBFileSharingWire.Request {
    #expect(frame.first == RFBFileSharingWire.messageType)
    let stream = MemoryRFBStream(input: Data(frame.dropFirst()))
    return try await RFBFileSharingWire.readRequest(from: stream)
  }
}

private final class FolderFixture {
  let container: URL
  let root: URL
  let configuration: SharedFolderConfiguration

  init() throws {
    container = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    root = container.appendingPathComponent("Shared")
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    try Data("fixture".utf8).write(to: root.appendingPathComponent("file.txt"))
    configuration = SharedFolderConfiguration(
      rootURL: root.resolvingSymlinksInPath(), displayName: "Shared", allowWrites: true)
  }

  deinit { try? FileManager.default.removeItem(at: container) }
}

private actor MemoryRFBStream: RFBByteStream {
  private var input: Data

  init(input: Data) { self.input = input }

  func readExactly(_ count: Int) throws -> Data {
    guard count >= 0, input.count >= count else { throw SharedFolderError.invalidRequest }
    let result = Data(input.prefix(count))
    input.removeFirst(count)
    return result
  }

  func send(_ data: Data) {}
  func send(_ data: Data, deadline: ContinuousClock.Instant?) {}
}
