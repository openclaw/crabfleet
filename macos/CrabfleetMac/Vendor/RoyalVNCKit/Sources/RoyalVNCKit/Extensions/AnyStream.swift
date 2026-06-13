#if canImport(FoundationEssentials)
import FoundationEssentials
#else
import Foundation
#endif

protocol AnyStream {
	func read(length: Int) throws -> Data

	func readUInt8() throws -> UInt8
	func readUInt16() throws -> UInt16
	func readUInt32() throws -> UInt32
}

extension AnyStream {
	func readUInt8() throws -> UInt8 {
		let length = MemoryLayout<UInt8>.size
		let data = try read(length: length)

		#if DEBUG
		guard data.count == length else {
			throw VNCError.protocol(.invalidData)
		}
		#endif

		let value = data[0]

		return value
	}

	func readUInt16() throws -> UInt16 {
		let length = MemoryLayout<UInt16>.size
		let data = try read(length: length)

		#if DEBUG
		guard data.count == length else {
			throw VNCError.protocol(.invalidData)
		}
		#endif

		let bigEndianValue = data.withUnsafeBytes {
			$0.loadUnaligned(as: UInt16.self)
		}

        let value = Endianness.current == .little
			? UInt16(bigEndian: bigEndianValue)
			: bigEndianValue

		return value
	}

	func readUInt32() throws -> UInt32 {
		let length = MemoryLayout<UInt32>.size
		let data = try read(length: length)

		#if DEBUG
		guard data.count == length else {
			throw VNCError.protocol(.invalidData)
		}
		#endif

		let bigEndianValue = data.withUnsafeBytes {
			$0.loadUnaligned(as: UInt32.self)
		}

		let value = Endianness.current == .little
			? UInt32(bigEndian: bigEndianValue)
			: bigEndianValue

		return value
	}
}
