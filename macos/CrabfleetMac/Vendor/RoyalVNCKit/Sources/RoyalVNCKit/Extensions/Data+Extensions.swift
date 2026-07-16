#if canImport(FoundationEssentials)
import FoundationEssentials
#else
import Foundation
#endif
import CryptoKit

extension Data {
	mutating func append(_ uint32: UInt32,
						 bigEndian: Bool) {
		let uint8Value = uint32.uint8Value(bigEndian: bigEndian)

		self.append(contentsOf: uint8Value)
	}

	mutating func append(_ int32: Int32,
						 bigEndian: Bool) {
		let uint8Value = int32.uint8Value(bigEndian: bigEndian)

		self.append(contentsOf: uint8Value)
	}

	mutating func append(_ uint16: UInt16,
						 bigEndian: Bool) {
		let uint8Value = uint16.uint8Value(bigEndian: bigEndian)

		self.append(contentsOf: uint8Value)
	}

	mutating func append(_ int16: Int16,
						 bigEndian: Bool) {
		let uint8Value = int16.uint8Value(bigEndian: bigEndian)

		self.append(contentsOf: uint8Value)
	}

	mutating func append(_ bool: Bool) {
		let uint8Value: UInt8 = bool
			? 1
			: 0

		self.append(uint8Value)
	}

	mutating func appendPadding() {
		let paddingValue: UInt8 = 0

		self.append(paddingValue)
	}

	mutating func appendPadding(length: UInt) {
		let paddingValue: UInt8 = 0
		let uint8Values: [UInt8] = .init(repeating: paddingValue,
										 count: .init(length))

		self.append(contentsOf: uint8Values)
	}

    func md5Hash() -> Data {
        Data(Insecure.MD5.hash(data: self))
    }

	func aes128ECBEncrypted(withKey key: Data) -> Data? {
		AES128ECBEncryption.encrypt(data: self,
                                    key: key)
	}
}
