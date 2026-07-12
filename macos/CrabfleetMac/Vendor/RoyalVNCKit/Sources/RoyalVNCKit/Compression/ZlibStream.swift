#if canImport(FoundationEssentials)
import FoundationEssentials
#else
import Foundation
#endif

import Z

final class ZlibStream {
	private let stream: ZlibInflateStream

	enum ZlibStreamError: Error {
		case decompressedDataOverflow
		case decompressedDataLengthMismatch
	}

	init() {
		do {
			self.stream = try ZlibInflateStream()
		} catch {
			fatalError("ERROR (Zlib): Failed to initialize Zlib Stream (\(error))")
		}
	}

	deinit {
		do {
			try self.stream.inflateEnd()
		} catch {
			fatalError("ERROR (Zlib): Failed to end inflate (\(error))")
		}
	}
}

extension ZlibStream {
	func reset() throws {
		try stream.inflateReset()
	}

    func decompressedData(compressedData: Data,
                          maximumOutputSize: Int) throws -> Data {
		guard maximumOutputSize >= 0 else {
			throw VNCError.protocol(.zlibDecompress(
				underlyingError: ZlibStreamError.decompressedDataOverflow
			))
		}

		let stream = self.stream
		let flush = ZlibFlush.noFlush

		let compressedSize = compressedData.count
		var mutableCompressedData = compressedData

		var decompressedData = Data()

		// TODO: What's the "perfect" buffer size?
		let bufferSize: UInt = 1024 * 10 * 10
		let buffer = UnsafeMutablePointer<UInt8>.allocate(capacity: .init(bufferSize))

		defer {
			buffer.deallocate()
		}

		try mutableCompressedData.withUnsafeMutableBytes { compressedDataPtr in
			guard let compressedDataBytes = compressedDataPtr.baseAddress?.assumingMemoryBound(to: Bytef.self) else {
				throw VNCError.protocol(.zlibDecompress(underlyingError: nil))
			}

			stream.totalOut = 0
			stream.nextIn = compressedDataBytes
			stream.availIn = .init(compressedSize)

			while true {
				stream.nextOut = buffer
				stream.availOut = .init(bufferSize)

				let inputBefore = stream.availIn
				let outputBefore = stream.totalOut
				let isDone: Bool

				do {
					isDone = try stream.inflate(flush: flush)
				} catch let error as ZlibError {
					if case .bufferError = error, inputBefore == 0 {
						break
					}
					throw VNCError.protocol(.zlibDecompress(underlyingError: error))
				} catch {
					throw VNCError.protocol(.zlibDecompress(underlyingError: error))
				}

				let actualOut = bufferSize - UInt(stream.availOut)

				if actualOut > 0 {
					let actualOutCount = Int(actualOut)
					guard decompressedData.count <= maximumOutputSize,
						  actualOutCount <= maximumOutputSize - decompressedData.count else {
						throw VNCError.protocol(.zlibDecompress(
							underlyingError: ZlibStreamError.decompressedDataOverflow
						))
					}
					decompressedData.append(buffer, count: actualOutCount)
				}

				if isDone {
					guard stream.availIn == 0 else {
						throw VNCError.protocol(.zlibDecompress(
							underlyingError: ZlibStreamError.decompressedDataLengthMismatch
						))
					}
					break
				}

				if stream.availIn == 0, stream.availOut > 0 {
					break
				}

				guard stream.availIn < inputBefore || stream.totalOut > outputBefore else {
					throw VNCError.protocol(.zlibDecompress(
						underlyingError: ZlibStreamError.decompressedDataLengthMismatch
					))
				}
			}
		}

		return decompressedData
	}

	func decompressedData(compressedData: Data,
						  uncompressedSize: UInt) throws -> Data {
		let stream = self.stream
		let flush = ZlibFlush.noFlush

		let compressedSize = compressedData.count
		var mutableCompressedData = compressedData

		var decompressedData = Data(count: .init(uncompressedSize))

		try mutableCompressedData.withUnsafeMutableBytes { compressedDataPtr in
			guard let compressedDataBytes = compressedDataPtr.baseAddress?.assumingMemoryBound(to: Bytef.self) else {
				throw VNCError.protocol(.zlibDecompress(underlyingError: nil))
			}

			stream.totalOut = 0
			stream.nextIn = compressedDataBytes
			stream.availIn = .init(compressedSize)

			try decompressedData.withUnsafeMutableBytes { decompressedDataPtr in
				guard let decompressedDataBytes = decompressedDataPtr.baseAddress?.assumingMemoryBound(to: Bytef.self) else {
					throw VNCError.protocol(.zlibDecompress(underlyingError: nil))
				}

				var overflowByte: UInt8 = 0

				while true {
					let doneBytes = stream.totalOut
					let remainingBytes = uncompressedSize - doneBytes

					if doneBytes > uncompressedSize {
						throw VNCError.protocol(.zlibDecompress(underlyingError: ZlibStreamError.decompressedDataOverflow))
					}

					let inputBefore = stream.availIn
					let outputBefore = stream.totalOut
					let isDone: Bool

					do {
						if remainingBytes > 0 {
							stream.nextOut = decompressedDataBytes.advanced(by: .init(doneBytes))
							stream.availOut = .init(remainingBytes)
							isDone = try stream.inflate(flush: flush)
						} else {
							isDone = try withUnsafeMutablePointer(to: &overflowByte) { overflowPtr in
								stream.nextOut = overflowPtr
								stream.availOut = 1
								return try stream.inflate(flush: flush)
							}
						}
					} catch let error as ZlibError {
						if case .bufferError = error, inputBefore == 0 {
							break
						}
						throw VNCError.protocol(.zlibDecompress(underlyingError: error))
					} catch {
						throw VNCError.protocol(.zlibDecompress(underlyingError: error))
					}

					guard stream.totalOut <= uncompressedSize else {
						throw VNCError.protocol(.zlibDecompress(
							underlyingError: ZlibStreamError.decompressedDataOverflow
						))
					}

					if isDone {
						guard stream.availIn == 0 else {
							throw VNCError.protocol(.zlibDecompress(
								underlyingError: ZlibStreamError.decompressedDataLengthMismatch
							))
						}
						break
					}

					if stream.availIn == 0, stream.availOut > 0 {
						break
					}

					guard stream.availIn < inputBefore || stream.totalOut > outputBefore else {
						throw VNCError.protocol(.zlibDecompress(
							underlyingError: ZlibStreamError.decompressedDataLengthMismatch
						))
					}
				}

				guard stream.totalOut == uncompressedSize,
					  stream.availIn == 0 else {
					throw VNCError.protocol(.zlibDecompress(underlyingError: ZlibStreamError.decompressedDataLengthMismatch))
				}
			}
		}

		return decompressedData
	}
}
