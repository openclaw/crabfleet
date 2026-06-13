#if canImport(FoundationEssentials)
import FoundationEssentials
#else
import Foundation
#endif

import Dispatch

enum NetworkConnectionStatus {
    /// The connection has been initialized but not started.
    case setup

    /// The connection is waiting for a network path change.
    case waiting(_ error: Error)

    /// The connection is waiting for a network path change.
    case preparing

    /// The connection is established, and ready to send and receive data.
    case ready

    /// The connection has disconnected or encountered an error.
    case failed(_ error: Error)

    /// The connection has been canceled.
    case cancelled

    case unknown(_ underlyingState: Any)
}

typealias NetworkConnectionStatusUpdateHandler = (_ status: NetworkConnectionStatus) -> Void

struct NetworkConnectionSettings {
    let connectionTimeout: Int

    let host: String
    let port: UInt16
}

protocol NetworkConnection: NetworkConnectionReading, NetworkConnectionWriting {
    init(settings: NetworkConnectionSettings)

    var status: NetworkConnectionStatus { get }
    var isReady: Bool { get }

    func setStatusUpdateHandler(_ statusUpdateHandler: NetworkConnectionStatusUpdateHandler?)

    func cancel()
    func start(queue: DispatchQueue)
}

protocol NetworkConnectionReading {
	func readPadding() async throws
	func readPadding(length: Int) async throws

	func read(length: Int) async throws -> Data

	func readUInt8() async throws -> UInt8
	func readBool() async throws -> Bool

	func readUInt16() async throws -> UInt16
	func readInt16() async throws -> Int16

	func readUInt32() async throws -> UInt32
	func readInt32() async throws -> Int32

	func readString(encoding: String.Encoding) async throws -> String

	func readString(encoding: String.Encoding,
					length: Int) async throws -> String

	func readBuffered(length: Int) async throws -> Data

	func readBuffered(length: Int,
					  minimumChunkSize: Int,
					  maximumChunkSize: Int) async throws -> Data

	func read(minimumLength: Int,
			  maximumLength: Int) async throws -> Data
}

protocol NetworkConnectionWriting {
	func write(value: UInt8) async throws

	func write(data: Data) async throws
}

// MARK: - Default implementations
extension NetworkConnectionReading {
    func readPadding() async throws {
        try await readPadding(length: 1)
    }

    func readPadding(length: Int) async throws {
        _ = try await readBuffered(length: length)
    }

    func readUInt8() async throws -> UInt8 {
        let data = try await read(minimumLength: 1, maximumLength: 1)
        let value = data[0]

        return value
    }

    func readBool() async throws -> Bool {
        let uint8Value = try await readUInt8()
        let boolValue = uint8Value != 0

        return boolValue
    }

    func readUInt16() async throws -> UInt16 {
        let length = MemoryLayout<UInt16>.size
        let data = try await read(length: length)

        guard data.count == length else {
            throw VNCError.protocol(.invalidData)
        }

        let bigEndianValue = data.withUnsafeBytes {
            $0.loadUnaligned(as: UInt16.self)
        }

        let value = Endianness.current == .little
            ? UInt16(bigEndian: bigEndianValue)
            : bigEndianValue

        return value
    }

    func readInt16() async throws -> Int16 {
        let length = MemoryLayout<Int16>.size
        let data = try await read(length: length)

        guard data.count == length else {
            throw VNCError.protocol(.invalidData)
        }

        let bigEndianValue = data.withUnsafeBytes {
            $0.loadUnaligned(as: Int16.self)
        }

        let value = Endianness.current == .little
            ? Int16(bigEndian: bigEndianValue)
            : bigEndianValue

        return value
    }

    func readUInt32() async throws -> UInt32 {
        let length = MemoryLayout<UInt32>.size
        let data = try await read(length: length)

        guard data.count == length else {
            throw VNCError.protocol(.invalidData)
        }

        let bigEndianValue = data.withUnsafeBytes {
            $0.loadUnaligned(as: UInt32.self)
        }

        let value = Endianness.current == .little
            ? UInt32(bigEndian: bigEndianValue)
            : bigEndianValue

        return value
    }

    func readInt32() async throws -> Int32 {
        let length = MemoryLayout<Int32>.size
        let data = try await read(length: length)

        guard data.count == length else {
            throw VNCError.protocol(.invalidData)
        }

        let bigEndianValue = data.withUnsafeBytes {
            $0.loadUnaligned(as: Int32.self)
        }

        let value = Endianness.current == .little
            ? Int32(bigEndian: bigEndianValue)
            : bigEndianValue

        return value
    }

    func readString(encoding: String.Encoding) async throws -> String {
        let length = try await readUInt32()

        let stringValue = try await readString(encoding: encoding,
                                               length: .init(length))

        return stringValue
    }

    func readString(encoding: String.Encoding,
                    length: Int) async throws -> String {
        guard length >= 0,
              length <= VNCProtocolLimits.maximumStringBytes else {
            throw VNCError.protocol(.invalidData)
        }

        guard length > 0 else {
            return ""
        }

        let data = try await readBuffered(length: .init(length))

        guard let stringValue = String(data: data,
                                       encoding: encoding) else {
            throw VNCError.protocol(.invalidData)
        }

        let trimmedStringValue: String

        if !stringValue.isEmpty,
           let firstNullCharacterIndex = stringValue.firstIndex(of: "\0") {
            trimmedStringValue = String(stringValue[stringValue.startIndex..<firstNullCharacterIndex])
        } else {
            trimmedStringValue = stringValue
        }

        return trimmedStringValue
    }

    func read(length: Int) async throws -> Data {
        try await readBuffered(length: length,
                               minimumChunkSize: 1,
                               maximumChunkSize: length)
    }

    func readBuffered(length: Int) async throws -> Data {
        try await readBuffered(length: length,
                               minimumChunkSize: 1,
                               maximumChunkSize: length)
    }

    func readBuffered(length: Int,
                      minimumChunkSize: Int,
                      maximumChunkSize: Int) async throws -> Data {
        guard length >= 0,
              length <= VNCProtocolLimits.maximumNetworkReadBytes else {
            throw VNCError.protocol(.invalidData)
        }

        guard length > 0 else {
            return .init()
        }

        guard minimumChunkSize > 0,
              maximumChunkSize > 0 else {
            throw VNCError.protocol(.invalidData)
        }

        var data = Data(capacity: length)
        var remainingBytesToRead = length

        while remainingBytesToRead > 0 {
            let bytesToRead = min(maximumChunkSize, remainingBytesToRead)

            let chunk = try await read(minimumLength: minimumChunkSize,
                                       maximumLength: bytesToRead)

            let receivedBytes = chunk.count

            // Safety check: prevent infinite loop
            guard receivedBytes > 0 else {
                throw VNCError.protocol(.invalidData)
            }

            data.append(chunk)
            remainingBytesToRead -= receivedBytes
        }

        guard data.count == length else {
            throw VNCError.protocol(.invalidData)
        }

        return data
    }
}

extension NetworkConnectionWriting {
    func write(value: UInt8) async throws {
        let data = Data([ value ])

        return try await write(data: data)
    }
}
