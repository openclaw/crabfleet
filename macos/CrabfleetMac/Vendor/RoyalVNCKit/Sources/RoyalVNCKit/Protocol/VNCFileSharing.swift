#if canImport(FoundationEssentials)
import FoundationEssentials
#else
import Foundation
#endif

public struct VNCFileEntry: Equatable, Sendable, Identifiable {
	public var id: String { name }
	public let name: String
	public let isDirectory: Bool
	public let size: UInt64
	public let modificationTimeMilliseconds: UInt64
}

public enum VNCFileSharingMessage: Equatable, Sendable {
	case capability(displayName: String, allowWrites: Bool)
	case list(id: UInt32, entries: [VNCFileEntry])
	case chunk(id: UInt32, offset: UInt64, bytes: Data, endOfFile: Bool)
	case operation(id: UInt32, operation: UInt8)
	case error(id: UInt32, message: String)
}

@MainActor
public protocol VNCFileSharingDelegate: AnyObject {
	func connection(_ connection: VNCConnection, didReceiveFileSharing message: VNCFileSharingMessage)
}

extension VNCProtocol {
	struct FileSharing: VNCReceivableMessage {
		static let messageType: UInt8 = 202
		let messageType: UInt8 = 202
		let message: VNCFileSharingMessage

		static let maximumPathBytes = 4 * 1_024
		static let maximumChunkBytes = 256 * 1_024
		static let maximumFileBytes: UInt64 = 512 * 1_024 * 1_024
		static let maximumEntries = 1_024

		static func receive(connection: NetworkConnectionReading) async throws -> Self {
			let kind = try await connection.readUInt8()
			let status = try await connection.readUInt8()
			let flags = try await connection.readUInt8()
			if kind == 1 {
				guard status <= 1, flags == 0 else { throw VNCError.protocol(.invalidData) }
				let length = Int(try await connection.readUInt16())
				guard (1...maximumPathBytes).contains(length),
					let name = String(
						data: try await connection.readBuffered(length: length), encoding: .utf8)
				else { throw VNCError.protocol(.invalidData) }
				return .init(message: .capability(displayName: name, allowWrites: status == 1))
			}

			let id = try await connection.readUInt32()
			switch kind {
				case 2:
					guard status == 0, flags == 0 else { throw VNCError.protocol(.invalidData) }
					let count = Int(try await connection.readUInt16())
					guard count <= maximumEntries else { throw VNCError.protocol(.invalidData) }
					var entries: [VNCFileEntry] = []
					entries.reserveCapacity(count)
					for _ in 0..<count {
						let length = Int(try await connection.readUInt16())
						guard (1...maximumPathBytes).contains(length),
							let name = String(
								data: try await connection.readBuffered(length: length), encoding: .utf8)
						else { throw VNCError.protocol(.invalidData) }
						let directory = try await connection.readUInt8()
						guard directory <= 1,
							try await connection.readBuffered(length: 3) == Data([0, 0, 0])
						else { throw VNCError.protocol(.invalidData) }
						let size = try await readUInt64(connection)
						let modification = try await readUInt64(connection)
						guard size <= maximumFileBytes else { throw VNCError.protocol(.invalidData) }
						entries.append(.init(
							name: name, isDirectory: directory == 1, size: size,
							modificationTimeMilliseconds: modification))
					}
					return .init(message: .list(id: id, entries: entries))
				case 3:
					guard status == 0, flags <= 1 else { throw VNCError.protocol(.invalidData) }
					let offset = try await readUInt64(connection)
					let length = Int(try await connection.readUInt32())
					guard length <= maximumChunkBytes else { throw VNCError.protocol(.invalidData) }
					return .init(message: .chunk(
						id: id, offset: offset,
						bytes: try await connection.readBuffered(length: length), endOfFile: flags == 1))
				case 4:
					guard status == 0, [3, 4, 5, 6, 7].contains(flags) else {
						throw VNCError.protocol(.invalidData)
					}
					let length = Int(try await connection.readUInt16())
					guard length <= maximumPathBytes else { throw VNCError.protocol(.invalidData) }
					_ = try await connection.readBuffered(length: length)
					return .init(message: .operation(id: id, operation: flags))
				case 255:
					guard status == 1, flags == 0 else { throw VNCError.protocol(.invalidData) }
					let length = Int(try await connection.readUInt16())
					guard length <= maximumPathBytes,
						let message = String(
							data: try await connection.readBuffered(length: length), encoding: .utf8)
					else { throw VNCError.protocol(.invalidData) }
					return .init(message: .error(id: id, message: message))
				default:
					throw VNCError.protocol(.invalidData)
			}
		}

		private static func readUInt64(_ connection: NetworkConnectionReading) async throws -> UInt64 {
			(UInt64(try await connection.readUInt32()) << 32)
				| UInt64(try await connection.readUInt32())
		}
	}

	struct FileSharingRequest: VNCSendableMessage {
		let messageType: UInt8 = 202
		let data: Data

		func send(connection: NetworkConnectionWriting) async throws {
			try await connection.write(data: data)
		}

		static func list(id: UInt32, path: String) throws -> Self {
			try pathRequest(kind: 1, id: id, path: path)
		}

		static func get(id: UInt32, path: String, offset: UInt64, length: UInt32) throws -> Self {
			guard length > 0, length <= FileSharing.maximumChunkBytes,
				offset <= FileSharing.maximumFileBytes,
				UInt64(length) <= FileSharing.maximumFileBytes - offset
			else { throw VNCError.protocol(.invalidData) }
			var data = try pathRequest(kind: 2, id: id, path: path).data
			append(&data, offset)
			append(&data, length)
			return .init(data: data)
		}

		static func putBegin(id: UInt32, path: String, size: UInt64) throws -> Self {
			guard size <= FileSharing.maximumFileBytes else { throw VNCError.protocol(.invalidData) }
			var data = try pathRequest(kind: 3, id: id, path: path).data
			append(&data, size)
			return .init(data: data)
		}

		static func putChunk(id: UInt32, bytes: Data) throws -> Self {
			guard !bytes.isEmpty, bytes.count <= FileSharing.maximumChunkBytes else {
				throw VNCError.protocol(.invalidData)
			}
			var data = Data([202, 4, 0, 0])
			append(&data, id)
			append(&data, UInt32(bytes.count))
			data.append(bytes)
			return .init(data: data)
		}

		static func putEnd(id: UInt32) -> Self {
			var data = Data([202, 5, 0, 0])
			append(&data, id)
			return .init(data: data)
		}

		static func mkdir(id: UInt32, path: String) throws -> Self {
			try pathRequest(kind: 6, id: id, path: path)
		}

		static func putAbort(id: UInt32) -> Self {
			var data = Data([202, 7, 0, 0])
			append(&data, id)
			return .init(data: data)
		}

		private static func pathRequest(kind: UInt8, id: UInt32, path: String) throws -> Self {
			let encoded = Data(path.utf8)
			guard encoded.count <= FileSharing.maximumPathBytes else {
				throw VNCError.protocol(.invalidData)
			}
			var data = Data([202, kind, 0, 0])
			append(&data, id)
			append(&data, UInt16(encoded.count))
			data.append(encoded)
			return .init(data: data)
		}

		private static func append<T: FixedWidthInteger>(_ data: inout Data, _ value: T) {
			var bigEndian = value.bigEndian
			Swift.withUnsafeBytes(of: &bigEndian) { data.append(contentsOf: $0) }
		}
	}
}

extension VNCConnection {
	func notifyFileSharingDelegateAboutMessage(_ message: VNCFileSharingMessage) async {
		await MainActor.run { [weak self] in
			guard let self, let delegate = self.fileSharingDelegate else { return }
			delegate.connection(self, didReceiveFileSharing: message)
		}
	}
}
