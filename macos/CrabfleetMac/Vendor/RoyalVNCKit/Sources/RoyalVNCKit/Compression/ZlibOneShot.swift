#if canImport(FoundationEssentials)
import FoundationEssentials
#else
import Foundation
#endif

import Z

/// Bounded one-shot zlib (RFC 1950) helpers for small payloads such as
/// Extended Clipboard bodies. Framebuffer decoding keeps using the streaming
/// wrappers; these helpers trade streaming for strict output caps.
enum ZlibOneShot {
	static func deflate(_ data: Data) throws -> Data {
		let sourceLength = UInt(data.count)
		var destinationLength = compressBound(sourceLength)
		var destination = Data(count: Int(destinationLength))

		let status = destination.withUnsafeMutableBytes { destinationBuffer -> Int32 in
			guard let destinationPointer = destinationBuffer.bindMemory(to: UInt8.self).baseAddress else {
				return Z_MEM_ERROR
			}

			return data.withUnsafeBytes { sourceBuffer -> Int32 in
				guard let sourcePointer = sourceBuffer.bindMemory(to: UInt8.self).baseAddress else {
					// zlib treats a zero-length source with a null pointer as valid input.
					return data.isEmpty
						? compress2(destinationPointer, &destinationLength, nil, 0, Z_DEFAULT_COMPRESSION)
						: Z_MEM_ERROR
				}

				return compress2(destinationPointer,
								 &destinationLength,
								 sourcePointer,
								 sourceLength,
								 Z_DEFAULT_COMPRESSION)
			}
		}

		guard status == Z_OK else {
			throw Self.error(status: status)
		}

		destination.removeSubrange(Int(destinationLength)..<destination.count)

		return destination
	}

	static func inflate(_ data: Data,
						maximumDecompressedBytes: Int) throws -> Data {
		guard !data.isEmpty else {
			throw ZlibError.dataError(message: "empty zlib payload")
		}

		var stream = z_stream()

		var version = ZLIB_VERSION
		var status = Z_VERSION_ERROR

		withUnsafeMutablePointer(to: &version) { versionPtr in
			status = inflateInit_(&stream, versionPtr, .init(MemoryLayout<z_stream>.size))
		}

		guard status == Z_OK else {
			throw Self.error(status: status)
		}

		defer {
			_ = Z.inflateEnd(&stream)
		}

		var input = data
		var output = Data()
		let chunkSize = 64 * 1_024
		var chunk = [UInt8](repeating: 0, count: chunkSize)
		var isDone = false

		try input.withUnsafeMutableBytes { (inputBuffer: UnsafeMutableRawBufferPointer) in
			guard let inputPointer = inputBuffer.bindMemory(to: UInt8.self).baseAddress else {
				throw ZlibError.dataError(message: "invalid zlib payload")
			}

			stream.next_in = inputPointer
			stream.avail_in = UInt32(inputBuffer.count)

			while !isDone {
				let inflateStatus = chunk.withUnsafeMutableBufferPointer { chunkBuffer -> Int32 in
					stream.next_out = chunkBuffer.baseAddress
					stream.avail_out = UInt32(chunkSize)

					return Z.inflate(&stream, Z_NO_FLUSH)
				}

				let producedBytes = chunkSize - Int(stream.avail_out)

				if producedBytes > 0 {
					guard output.count + producedBytes <= maximumDecompressedBytes else {
						throw ZlibError.bufferError(message: "decompressed payload exceeds limit")
					}

					output.append(contentsOf: chunk[0..<producedBytes])
				}

				switch inflateStatus {
					case Z_STREAM_END:
						isDone = true
					case Z_OK:
						// No forward progress means the payload is truncated or corrupt.
						guard stream.avail_in > 0 || producedBytes > 0 else {
							throw ZlibError.dataError(message: "truncated zlib payload")
						}
					default:
						throw Self.error(status: inflateStatus)
				}
			}
		}

		return output
	}
}

private extension ZlibOneShot {
	static func error(status: Int32) -> ZlibError {
		switch status {
			case Z_STREAM_END:
				.streamEnd(message: nil)
			case Z_NEED_DICT:
				.needDict(message: nil)
			case Z_ERRNO:
				.errNo(message: nil)
			case Z_STREAM_ERROR:
				.streamError(message: nil)
			case Z_DATA_ERROR:
				.dataError(message: nil)
			case Z_MEM_ERROR:
				.memoryError(message: nil)
			case Z_BUF_ERROR:
				.bufferError(message: nil)
			case Z_VERSION_ERROR:
				.versionError(message: nil)
			default:
				.unknown(status: status, message: nil)
		}
	}
}
