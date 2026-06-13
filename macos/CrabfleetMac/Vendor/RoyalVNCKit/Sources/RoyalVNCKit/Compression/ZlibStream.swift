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
//				print("AVAILIN: \(stream.availIn)")

				if stream.availIn <= 0 {
					break
				}

				var isDone = false

				stream.nextOut = buffer
				stream.availOut = .init(bufferSize)

//					print("AVAIL OUT BEFORE INFLATE: \(stream.availOut)")

				// Inflate another chunk.
				do {
					isDone = try stream.inflate(flush: flush)

					if stream.availOut >= 0 {
						let availOut: UInt = .init(stream.availOut)

	//						print("AVAIL OUT AFTER INFLATE: \(availOut)")

						let actualOut = bufferSize - availOut

						if actualOut > 0 {
							guard decompressedData.count <= maximumOutputSize - Int(actualOut) else {
								throw VNCError.protocol(.zlibDecompress(
									underlyingError: ZlibStreamError.decompressedDataOverflow
								))
							}
							decompressedData.append(buffer,
													count: .init(actualOut))
						}
					}
				} catch {
					throw VNCError.protocol(.zlibDecompress(underlyingError: error))
				}

				if isDone {
					break
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

				while true {
					let doneBytes = stream.totalOut
					let remainingBytes = uncompressedSize - doneBytes

					if doneBytes > uncompressedSize {
						throw VNCError.protocol(.zlibDecompress(underlyingError: ZlibStreamError.decompressedDataOverflow))
					}

					stream.nextOut = decompressedDataBytes.advanced(by: .init(doneBytes))
					stream.availOut = .init(remainingBytes)

					if remainingBytes <= 0 {
						break
					}

					// Inflate another chunk.
					do {
						let isDone = try stream.inflate(flush: flush)

						if isDone {
							break
						}
					} catch {
						throw VNCError.protocol(.zlibDecompress(underlyingError: error))
					}
				}

				guard stream.totalOut == uncompressedSize else {
					throw VNCError.protocol(.zlibDecompress(underlyingError: ZlibStreamError.decompressedDataLengthMismatch))
				}
			}
		}

		return decompressedData
	}
}
