#if canImport(FoundationEssentials)
import FoundationEssentials
#else
import Foundation
#endif

//@_implementationOnly import libtomcrypt
import CryptoSwift

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

    // CryptoSwift Implementation
    func md5Hash() -> Data {
        .init(Digest.md5(byteArray))
    }

    // libtomcrypt Implementation
//	func md5Hash() -> Data {
//        var hashState = hash_state()
//
//        // Initialize the MD5 context
//        let initResult = md5_init(&hashState)
//
//        guard initResult == CRYPT_OK else {
//            fatalError("MD5 init failed: \(initResult)")
//        }
//
//        // Process the input data
//        let processResult = self.withUnsafeBytes {
//            guard let ptrAddr = $0.baseAddress else {
//                return CRYPT_ERROR
//            }
//
//            let ret = md5_process(&hashState,
//                                  ptrAddr,
//                                  .init(self.count))
//
//            return .init(ret)
//        }
//
//        guard processResult == CRYPT_OK else {
//            fatalError("MD5 process failed: \(processResult)")
//        }
//
//        var hashData = Data(count: 16)
//
//        // Finalize the hash and retrieve the result
//        let doneResult = hashData.withUnsafeMutableBytes {
//            guard let ptrAddr = $0.baseAddress else {
//                return CRYPT_ERROR
//            }
//
//            let ret = md5_done(&hashState,
//                               ptrAddr)
//
//            return .init(ret)
//        }
//
//        guard doneResult == CRYPT_OK else {
//            fatalError("MD5 done failed: \(doneResult)")
//        }
//
//		return hashData
//	}

	func aes128ECBEncrypted(withKey key: Data) -> Data? {
		AES128ECBEncryption.encrypt(data: self,
                                    key: key)
	}
}
