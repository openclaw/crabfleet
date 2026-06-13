#if canImport(FoundationEssentials)
import FoundationEssentials
#else
import Foundation
#endif

final class DataStream {
	let data: Data
	private(set) var offset = 0

	private let dataLength: Int

	init(data: Data) {
		self.data = data
		self.dataLength = data.count
	}
}

extension DataStream: AnyStream {
	func read(length: Int) throws -> Data {
		let currentOffset = self.offset
		guard length >= 0,
			  currentOffset <= dataLength - length else {
			throw VNCError.protocol(.noData)
		}

		let newOffset = currentOffset + length

		let subData = data.subdata(in: currentOffset..<newOffset)

		self.offset = newOffset

		return subData
	}
}
