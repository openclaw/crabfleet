import Darwin
import Foundation

struct SharedFolderConfiguration: Sendable {
  let rootURL: URL
  let displayName: String
  let allowWrites: Bool
}

final class SecurityScopedSharedFolder: @unchecked Sendable {
  let configuration: SharedFolderConfiguration
  private let accessURL: URL?
  private let didStartAccessing: Bool

  init(bookmark: Data, allowWrites: Bool) throws {
    var stale = false
    let url = try URL(
      resolvingBookmarkData: bookmark,
      options: [.withSecurityScope, .withoutUI],
      relativeTo: nil,
      bookmarkDataIsStale: &stale)
    guard !stale else { throw SharedFolderError.staleBookmark }
    let started = url.startAccessingSecurityScopedResource()
    do {
      let resolved = url.resolvingSymlinksInPath().standardizedFileURL
      var isDirectory: ObjCBool = false
      guard FileManager.default.fileExists(atPath: resolved.path, isDirectory: &isDirectory),
        isDirectory.boolValue
      else { throw SharedFolderError.rootUnavailable }
      accessURL = url
      didStartAccessing = started
      configuration = SharedFolderConfiguration(
        rootURL: resolved,
        displayName: resolved.lastPathComponent,
        allowWrites: allowWrites)
    } catch {
      if started { url.stopAccessingSecurityScopedResource() }
      throw error
    }
  }

  init(rootURL: URL, allowWrites: Bool) throws {
    let resolved = rootURL.resolvingSymlinksInPath().standardizedFileURL
    var isDirectory: ObjCBool = false
    guard FileManager.default.fileExists(atPath: resolved.path, isDirectory: &isDirectory),
      isDirectory.boolValue
    else { throw SharedFolderError.rootUnavailable }
    accessURL = nil
    didStartAccessing = false
    configuration = SharedFolderConfiguration(
      rootURL: resolved,
      displayName: resolved.lastPathComponent,
      allowWrites: allowWrites)
  }

  deinit {
    if didStartAccessing { accessURL?.stopAccessingSecurityScopedResource() }
  }
}

enum SharedFolderError: Error, LocalizedError, Equatable {
  case staleBookmark
  case rootUnavailable
  case invalidPath
  case pathEscapesRoot
  case fileTooLarge
  case writesDisabled
  case uploadAlreadyActive
  case noActiveUpload
  case uploadMismatch
  case invalidRequest

  var errorDescription: String? {
    switch self {
    case .staleBookmark: "The shared folder selection is stale; choose it again."
    case .rootUnavailable: "The shared folder is unavailable."
    case .invalidPath: "The shared-folder path is invalid."
    case .pathEscapesRoot: "The requested path is outside the shared folder."
    case .fileTooLarge: "The file exceeds the 512 MiB transfer limit."
    case .writesDisabled: "Remote writes are disabled."
    case .uploadAlreadyActive: "Another upload is already in progress."
    case .noActiveUpload: "No upload is in progress."
    case .uploadMismatch: "The upload did not match its declared size."
    case .invalidRequest: "The file-sharing request is malformed."
    }
  }
}

enum RFBFileSharingWire {
  static let encoding: Int32 = 0x4653_4831
  static let messageType: UInt8 = 202
  static let maximumPathBytes = 4 * 1_024
  static let maximumChunkBytes = 256 * 1_024
  static let maximumFileBytes: UInt64 = 512 * 1_024 * 1_024
  static let maximumListingEntries = 1_024

  enum Request: Equatable {
    case list(id: UInt32, path: String)
    case get(id: UInt32, path: String, offset: UInt64, length: UInt32)
    case putBegin(id: UInt32, path: String, size: UInt64)
    case putChunk(id: UInt32, bytes: Data)
    case putEnd(id: UInt32)
    case mkdir(id: UInt32, path: String)
    case putAbort(id: UInt32)
  }

  struct Entry: Equatable, Sendable {
    let name: String
    let isDirectory: Bool
    let size: UInt64
    let modificationTimeMilliseconds: UInt64
  }

  static func capability(displayName: String, allowWrites: Bool) throws -> Data {
    let name = Data(displayName.utf8)
    guard !name.isEmpty, name.count <= maximumPathBytes else { throw SharedFolderError.invalidPath }
    var data = Data([messageType, 1, allowWrites ? 1 : 0, 0])
    data.appendBigEndian(UInt16(name.count))
    data.append(name)
    return data
  }

  static func listRequest(id: UInt32, path: String) throws -> Data {
    try pathRequest(kind: 1, id: id, path: path)
  }

  static func getRequest(
    id: UInt32, path: String, offset: UInt64, length: UInt32
  ) throws -> Data {
    guard length > 0, length <= maximumChunkBytes else { throw SharedFolderError.invalidRequest }
    var data = try pathRequest(kind: 2, id: id, path: path)
    data.appendBigEndian(offset)
    data.appendBigEndian(length)
    return data
  }

  static func putBeginRequest(id: UInt32, path: String, size: UInt64) throws -> Data {
    guard size <= maximumFileBytes else { throw SharedFolderError.fileTooLarge }
    var data = try pathRequest(kind: 3, id: id, path: path)
    data.appendBigEndian(size)
    return data
  }

  static func putChunkRequest(id: UInt32, bytes: Data) throws -> Data {
    guard !bytes.isEmpty, bytes.count <= maximumChunkBytes else {
      throw SharedFolderError.invalidRequest
    }
    var data = Data([messageType, 4, 0, 0])
    data.appendBigEndian(id)
    data.appendBigEndian(UInt32(bytes.count))
    data.append(bytes)
    return data
  }

  static func putEndRequest(id: UInt32) -> Data {
    var data = Data([messageType, 5, 0, 0])
    data.appendBigEndian(id)
    return data
  }

  static func mkdirRequest(id: UInt32, path: String) throws -> Data {
    try pathRequest(kind: 6, id: id, path: path)
  }

  static func putAbortRequest(id: UInt32) -> Data {
    var data = Data([messageType, 7, 0, 0])
    data.appendBigEndian(id)
    return data
  }

  static func readRequest(from io: any RFBByteStream) async throws -> Request {
    let header = try await io.readExactly(7)
    let kind = header[0]
    guard header[1] == 0, header[2] == 0 else { throw SharedFolderError.invalidRequest }
    let id = header.readUInt32(at: 3)
    switch kind {
    case 1, 2, 3, 6:
      let path = try await readPath(from: io)
      switch kind {
      case 1: return .list(id: id, path: path)
      case 2:
        let range = try await io.readExactly(12)
        let offset = range.readUInt64(at: 0)
        let length = range.readUInt32(at: 8)
        guard length > 0, length <= maximumChunkBytes,
          offset <= maximumFileBytes,
          UInt64(length) <= maximumFileBytes - offset
        else { throw SharedFolderError.invalidRequest }
        return .get(id: id, path: path, offset: offset, length: length)
      case 3:
        let size = (try await io.readExactly(8)).readUInt64(at: 0)
        guard size <= maximumFileBytes else { throw SharedFolderError.fileTooLarge }
        return .putBegin(id: id, path: path, size: size)
      default: return .mkdir(id: id, path: path)
      }
    case 4:
      let length = (try await io.readExactly(4)).readUInt32(at: 0)
      guard length > 0, length <= maximumChunkBytes else {
        throw SharedFolderError.invalidRequest
      }
      return .putChunk(id: id, bytes: try await io.readExactly(Int(length)))
    case 5:
      return .putEnd(id: id)
    case 7:
      return .putAbort(id: id)
    default:
      throw SharedFolderError.invalidRequest
    }
  }

  static func listing(id: UInt32, entries: [Entry]) throws -> Data {
    guard entries.count <= maximumListingEntries else { throw SharedFolderError.invalidRequest }
    var data = Data([messageType, 2, 0, 0])
    data.appendBigEndian(id)
    data.appendBigEndian(UInt16(entries.count))
    for entry in entries {
      let name = Data(entry.name.utf8)
      guard !name.isEmpty, name.count <= maximumPathBytes else {
        throw SharedFolderError.invalidPath
      }
      data.appendBigEndian(UInt16(name.count))
      data.append(name)
      data.append(entry.isDirectory ? 1 : 0)
      data.append(contentsOf: [0, 0, 0])
      data.appendBigEndian(entry.size)
      data.appendBigEndian(entry.modificationTimeMilliseconds)
    }
    return data
  }

  static func fileChunk(
    id: UInt32, offset: UInt64, bytes: Data, endOfFile: Bool
  ) throws -> Data {
    guard bytes.count <= maximumChunkBytes else { throw SharedFolderError.invalidRequest }
    var data = Data([messageType, 3, 0, endOfFile ? 1 : 0])
    data.appendBigEndian(id)
    data.appendBigEndian(offset)
    data.appendBigEndian(UInt32(bytes.count))
    data.append(bytes)
    return data
  }

  static func operationResult(id: UInt32, operation: UInt8) -> Data {
    var data = Data([messageType, 4, 0, operation])
    data.appendBigEndian(id)
    data.appendBigEndian(UInt16(0))
    return data
  }

  static func error(id: UInt32, message: String) -> Data {
    var encoded = Data(message.utf8)
    if encoded.count > maximumPathBytes { encoded = encoded.prefix(maximumPathBytes) }
    var data = Data([messageType, 255, 1, 0])
    data.appendBigEndian(id)
    data.appendBigEndian(UInt16(encoded.count))
    data.append(encoded)
    return data
  }

  private static func pathRequest(kind: UInt8, id: UInt32, path: String) throws -> Data {
    let encoded = Data(path.utf8)
    guard encoded.count <= maximumPathBytes else { throw SharedFolderError.invalidPath }
    var data = Data([messageType, kind, 0, 0])
    data.appendBigEndian(id)
    data.appendBigEndian(UInt16(encoded.count))
    data.append(encoded)
    return data
  }

  private static func readPath(from io: any RFBByteStream) async throws -> String {
    let length = Int((try await io.readExactly(2)).readUInt16(at: 0))
    guard length <= maximumPathBytes else { throw SharedFolderError.invalidPath }
    let bytes = try await io.readExactly(length)
    guard let path = String(data: bytes, encoding: .utf8) else {
      throw SharedFolderError.invalidPath
    }
    return path
  }
}

actor SharedFolderSession {
  private struct Upload {
    let id: UInt32
    let relativePath: String
    let temporaryName: String
    let handle: FileHandle
    let expectedSize: UInt64
    var receivedSize: UInt64
  }

  private let configuration: SharedFolderConfiguration
  private let fileManager: FileManager
  private let rootDirectoryFD: Int32
  private var upload: Upload?

  init(configuration: SharedFolderConfiguration, fileManager: FileManager = .default) {
    self.configuration = configuration
    self.fileManager = fileManager
    rootDirectoryFD = open(
      configuration.rootURL.path, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW)
  }

  deinit { if rootDirectoryFD >= 0 { close(rootDirectoryFD) } }

  func handle(_ request: RFBFileSharingWire.Request) -> Data {
    do {
      switch request {
      case .list(let id, let path):
        return try RFBFileSharingWire.listing(id: id, entries: list(path: path))
      case .get(let id, let path, let offset, let length):
        let result = try get(path: path, offset: offset, length: Int(length))
        return try RFBFileSharingWire.fileChunk(
          id: id, offset: offset, bytes: result.bytes, endOfFile: result.endOfFile)
      case .putBegin(let id, let path, let size):
        try beginUpload(id: id, path: path, size: size)
        return RFBFileSharingWire.operationResult(id: id, operation: 3)
      case .putChunk(let id, let bytes):
        try appendUpload(id: id, bytes: bytes)
        return RFBFileSharingWire.operationResult(id: id, operation: 4)
      case .putEnd(let id):
        try finishUpload(id: id)
        return RFBFileSharingWire.operationResult(id: id, operation: 5)
      case .mkdir(let id, let path):
        try createDirectory(path: path)
        return RFBFileSharingWire.operationResult(id: id, operation: 6)
      case .putAbort(let id):
        try abortUpload(id: id)
        return RFBFileSharingWire.operationResult(id: id, operation: 7)
      }
    } catch {
      switch request {
      case .putChunk(_, _), .putEnd(_):
        abort()
      default:
        break
      }
      let id: UInt32
      switch request {
      case .list(let value, _), .get(let value, _, _, _), .putBegin(let value, _, _),
        .putChunk(let value, _), .putEnd(let value), .mkdir(let value, _),
        .putAbort(let value): id = value
      }
      return RFBFileSharingWire.error(id: id, message: error.localizedDescription)
    }
  }

  func resolveExistingPath(_ path: String) throws -> URL {
    let candidate = try lexicalURL(path)
    guard fileManager.fileExists(atPath: candidate.path) else {
      throw CocoaError(.fileNoSuchFile)
    }
    return try requireContained(candidate.resolvingSymlinksInPath().standardizedFileURL)
  }

  func abort() {
    guard let upload else { return }
    try? upload.handle.close()
    if rootDirectoryFD >= 0 { _ = unlinkat(rootDirectoryFD, upload.temporaryName, 0) }
    self.upload = nil
  }

  private func abortUpload(id: UInt32) throws {
    guard upload?.id == id else { throw SharedFolderError.noActiveUpload }
    abort()
  }

  private func list(path: String) throws -> [RFBFileSharingWire.Entry] {
    let directoryFD = try openContained(path, finalFlags: O_RDONLY | O_DIRECTORY)
    defer { close(directoryFD) }
    guard let directory = fdopendir(dup(directoryFD)) else { throw posixError() }
    defer { closedir(directory) }
    var entries: [RFBFileSharingWire.Entry] = []
    while let rawEntry = readdir(directory) {
      let name = withUnsafePointer(to: &rawEntry.pointee.d_name) {
        $0.withMemoryRebound(to: CChar.self, capacity: Int(MAXNAMLEN) + 1) {
          String(validatingCString: $0)
        }
      }
      guard let name, name != ".", name != "..", !name.hasPrefix(".") else { continue }
      var metadata = stat()
      guard fstatat(directoryFD, name, &metadata, AT_SYMLINK_NOFOLLOW) == 0 else {
        throw posixError()
      }
      let kind = metadata.st_mode & S_IFMT
      guard kind == S_IFDIR || kind == S_IFREG else { continue }
      let size = UInt64(max(0, metadata.st_size))
      if kind == S_IFREG, size > RFBFileSharingWire.maximumFileBytes { continue }
      entries.append(.init(
        name: name,
        isDirectory: kind == S_IFDIR,
        size: kind == S_IFDIR ? 0 : size,
        modificationTimeMilliseconds: UInt64(max(
          0,
          metadata.st_mtimespec.tv_sec * 1_000
            + metadata.st_mtimespec.tv_nsec / 1_000_000))))
      guard entries.count <= RFBFileSharingWire.maximumListingEntries else {
        throw SharedFolderError.invalidRequest
      }
    }
    return entries.sorted {
      $0.name.localizedStandardCompare($1.name) == .orderedAscending
    }
  }

  private func get(path: String, offset: UInt64, length: Int) throws -> (bytes: Data, endOfFile: Bool) {
    let descriptor = try openContained(path, finalFlags: O_RDONLY)
    var metadata = stat()
    guard fstat(descriptor, &metadata) == 0 else {
      close(descriptor)
      throw posixError()
    }
    guard metadata.st_mode & S_IFMT == S_IFREG else {
      close(descriptor)
      throw SharedFolderError.invalidPath
    }
    let size = UInt64(max(0, metadata.st_size))
    guard size <= RFBFileSharingWire.maximumFileBytes, offset <= size else {
      close(descriptor)
      throw SharedFolderError.fileTooLarge
    }
    let handle = FileHandle(fileDescriptor: descriptor, closeOnDealloc: false)
    defer { try? handle.close() }
    try handle.seek(toOffset: offset)
    let bytes = try handle.read(upToCount: min(length, Int(size - offset))) ?? Data()
    return (bytes, offset + UInt64(bytes.count) >= size)
  }

  private func beginUpload(id: UInt32, path: String, size: UInt64) throws {
    guard configuration.allowWrites else { throw SharedFolderError.writesDisabled }
    guard upload == nil else { throw SharedFolderError.uploadAlreadyActive }
    guard rootDirectoryFD >= 0 else { throw SharedFolderError.rootUnavailable }
    guard size <= RFBFileSharingWire.maximumFileBytes else { throw SharedFolderError.fileTooLarge }
    _ = try destinationURL(path)
    let temporaryName = ".crabfleet-upload-\(UUID().uuidString).tmp"
    let descriptor = openat(
      rootDirectoryFD, temporaryName,
      O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC | O_NOFOLLOW,
      S_IRUSR | S_IWUSR)
    guard descriptor >= 0 else { throw posixError() }
    upload = Upload(
      id: id, relativePath: path, temporaryName: temporaryName,
      handle: FileHandle(fileDescriptor: descriptor, closeOnDealloc: false),
      expectedSize: size, receivedSize: 0)
  }

  private func appendUpload(id: UInt32, bytes: Data) throws {
    guard var upload, upload.id == id else { throw SharedFolderError.noActiveUpload }
    guard !bytes.isEmpty, bytes.count <= RFBFileSharingWire.maximumChunkBytes,
      UInt64(bytes.count) <= upload.expectedSize - upload.receivedSize
    else { throw SharedFolderError.uploadMismatch }
    try upload.handle.write(contentsOf: bytes)
    upload.receivedSize += UInt64(bytes.count)
    self.upload = upload
  }

  private func finishUpload(id: UInt32) throws {
    guard let upload, upload.id == id else { throw SharedFolderError.noActiveUpload }
    self.upload = nil
    do {
      guard upload.receivedSize == upload.expectedSize else {
        throw SharedFolderError.uploadMismatch
      }
      try upload.handle.synchronize()
      try upload.handle.close()
      try commitUpload(upload)
    } catch {
      try? upload.handle.close()
      if rootDirectoryFD >= 0 { _ = unlinkat(rootDirectoryFD, upload.temporaryName, 0) }
      throw error
    }
  }

  private func commitUpload(_ upload: Upload) throws {
    guard rootDirectoryFD >= 0 else { throw SharedFolderError.rootUnavailable }
    let components = upload.relativePath.split(separator: "/", omittingEmptySubsequences: false)
    guard let destinationName = components.last, !destinationName.isEmpty else {
      throw SharedFolderError.invalidPath
    }
    var parentFD = dup(rootDirectoryFD)
    guard parentFD >= 0 else { throw posixError() }
    defer { close(parentFD) }
    for component in components.dropLast() {
      let nextFD = openat(
        parentFD, String(component), O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW)
      guard nextFD >= 0 else { throw posixError() }
      close(parentFD)
      parentFD = nextFD
    }

    var metadata = stat()
    if fstatat(parentFD, String(destinationName), &metadata, AT_SYMLINK_NOFOLLOW) == 0 {
      guard metadata.st_mode & S_IFMT == S_IFREG else { throw SharedFolderError.invalidPath }
    } else if errno != ENOENT {
      throw posixError()
    }
    guard renameat(
      rootDirectoryFD, upload.temporaryName, parentFD, String(destinationName)) == 0
    else { throw posixError() }
  }

  private func createDirectory(path: String) throws {
    guard configuration.allowWrites else { throw SharedFolderError.writesDisabled }
    _ = try lexicalURL(path)
    let components = path.split(separator: "/", omittingEmptySubsequences: false)
    guard let name = components.last, !name.isEmpty else { throw SharedFolderError.invalidPath }
    let parentPath = components.dropLast().joined(separator: "/")
    let parentFD = try openContained(parentPath, finalFlags: O_RDONLY | O_DIRECTORY)
    defer { close(parentFD) }
    guard mkdirat(parentFD, String(name), S_IRWXU) == 0 else { throw posixError() }
  }

  private func destinationURL(_ path: String) throws -> URL {
    let candidate = try lexicalURL(path)
    let parent = candidate.deletingLastPathComponent()
      .resolvingSymlinksInPath().standardizedFileURL
    _ = try requireContained(parent)
    var isDirectory: ObjCBool = false
    guard fileManager.fileExists(atPath: parent.path, isDirectory: &isDirectory),
      isDirectory.boolValue
    else { throw SharedFolderError.invalidPath }
    if fileManager.fileExists(atPath: candidate.path) {
      try validateReplaceableDestination(candidate)
    }
    return try requireContained(parent.appendingPathComponent(candidate.lastPathComponent))
  }

  private func validateReplaceableDestination(_ destination: URL) throws {
    let resolved = try requireContained(
      destination.resolvingSymlinksInPath().standardizedFileURL)
    let values = try resolved.resourceValues(forKeys: [.isRegularFileKey])
    guard values.isRegularFile == true else { throw SharedFolderError.invalidPath }
  }

  private func lexicalURL(_ path: String) throws -> URL {
    guard path.utf8.count <= RFBFileSharingWire.maximumPathBytes,
      !path.hasPrefix("/"), !path.contains("\0")
    else { throw SharedFolderError.invalidPath }
    let components = path.split(separator: "/", omittingEmptySubsequences: false)
    guard !components.contains(where: { $0 == ".." || $0 == "." || $0.isEmpty && !path.isEmpty }) else {
      throw SharedFolderError.invalidPath
    }
    return components.reduce(configuration.rootURL) {
      $0.appendingPathComponent(String($1), isDirectory: false)
    }.standardizedFileURL
  }

  private func requireContained(_ url: URL) throws -> URL {
    let root = configuration.rootURL.standardizedFileURL.pathComponents
    let candidate = url.standardizedFileURL.pathComponents
    guard candidate.count >= root.count,
      Array(candidate.prefix(root.count)) == root
    else {
      throw SharedFolderError.pathEscapesRoot
    }
    return url
  }

  private func openContained(_ path: String, finalFlags: Int32) throws -> Int32 {
    _ = try lexicalURL(path)
    guard rootDirectoryFD >= 0 else { throw SharedFolderError.rootUnavailable }
    var descriptor = dup(rootDirectoryFD)
    guard descriptor >= 0 else { throw posixError() }
    if path.isEmpty { return descriptor }
    let components = path.split(separator: "/", omittingEmptySubsequences: false)
    for (index, component) in components.enumerated() {
      let flags = index == components.count - 1 ? finalFlags : O_RDONLY | O_DIRECTORY
      let next = openat(
        descriptor, String(component), flags | O_CLOEXEC | O_NOFOLLOW)
      close(descriptor)
      guard next >= 0 else { throw posixError() }
      descriptor = next
    }
    return descriptor
  }

  private func posixError() -> NSError {
    NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
  }
}

extension Data {
  func readUInt64(at offset: Int) -> UInt64 {
    (UInt64(readUInt32(at: offset)) << 32) | UInt64(readUInt32(at: offset + 4))
  }
}
