#if canImport(FoundationEssentials)
import FoundationEssentials
#else
import Foundation
#endif

/// VNC Encodings can either be specified as Int32 or UInt32 which have the same byte size. You MUST NOT actually use a Int64 value!
public struct VNCEncodingType: RawRepresentable, ExpressibleByIntegerLiteral, Equatable, Hashable {
	public static let size = MemoryLayout<Int32>.size

	public typealias RawValue = Int64
	public typealias IntegerLiteralType = RawValue

	public let rawValue: RawValue

	public let int32Value: Int32?
	public let uint32Value: UInt32?

    public init?(rawValue: RawValue) {
		if let int32Val = Int32(exactly: rawValue) {
			self.rawValue = rawValue

			self.int32Value = int32Val
			self.uint32Value = nil
		} else if let uint32Val = UInt32(exactly: rawValue) {
			self.rawValue = rawValue

			self.int32Value = nil
			self.uint32Value = uint32Val
		} else {
			return nil
		}
    }

	public init(integerLiteral value: RawValue) {
		if let int32Val = Int32(exactly: value) {
			self.rawValue = value

			self.int32Value = int32Val
			self.uint32Value = nil
		} else if let uint32Val = UInt32(exactly: value) {
			self.rawValue = value

			self.int32Value = nil
			self.uint32Value = uint32Val
		} else {
			let actualSize = MemoryLayout.size(ofValue: value)
			let errorMessage = "An encoding Type (\(value)) with invalid size was specified. Expected Size: \(Self.size), Actual Size: \(actualSize)"

			fatalError(errorMessage)
		}
	}

	public init(_ int32Value: Int32) {
		self.rawValue = .init(int32Value)

		self.int32Value = int32Value
		self.uint32Value = nil
	}

	public init(_ uint32Value: UInt32) {
		self.rawValue = .init(uint32Value)

		self.int32Value = nil
		self.uint32Value = uint32Value
	}
}

extension VNCEncodingType {
	func validate() throws {
		guard int32Value != nil ||
			  uint32Value != nil else {
			let actualEncodingTypeSize = MemoryLayout.size(ofValue: self)

			throw VNCError.protocol(.invalidEncodingTypeSize(encodingType: self, actualSize: actualEncodingTypeSize))
		}
	}
}

extension [VNCEncodingType] {
	func validate() throws {
		for encodingType in self {
			try encodingType.validate()
		}
	}
}
