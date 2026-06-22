#if canImport(FoundationEssentials)
import FoundationEssentials
#else
import Foundation
#endif

import d3des

enum D3DESLock {
	static let shared = NSLock()
}

struct VNCDESEncryption {
	static func encrypt(data: Data,
						key: String) -> Data? {
		var data = data
		guard var paddedKey = paddedKey(key) else { return nil }

		D3DESLock.shared.lock()
		defer { D3DESLock.shared.unlock() }
		let success = encrypt(data: &data,
							  paddedKey: &paddedKey)

		guard success else {
			return nil
		}

		return data
	}
}

private extension VNCDESEncryption {
	static func encrypt(data: inout Data,
						paddedKey: inout Data) -> Bool {
		let success = data.withUnsafeMutableBytes { encryptedDataPtr in
			guard let encryptedDataBytes = encryptedDataPtr.baseAddress?.assumingMemoryBound(to: UInt8.self) else {
				return false
			}

			return paddedKey.withUnsafeMutableBytes { paddedKeyPtr in
				guard let paddedKeyBytes = paddedKeyPtr.baseAddress?.assumingMemoryBound(to: UInt8.self) else {
					return false
				}

				encrypt(dataBytes: encryptedDataBytes,
						paddedKeyBytes: paddedKeyBytes)

				return true
			}
		}

		return success
	}

	static func paddedKey(_ key: String) -> Data? {
		let maxKeyLength = 8
		guard let encodedKey = key.data(using: .isoLatin1, allowLossyConversion: false) else {
			return nil
		}
		var paddedKey = Data(count: maxKeyLength)
		for (index, byte) in encodedKey.prefix(maxKeyLength).enumerated() {
			paddedKey[index] = byte
		}
		return paddedKey
	}

	static func encrypt(dataBytes: UnsafeMutablePointer<UInt8>,
						paddedKeyBytes: UnsafeMutablePointer<UInt8>) {
		let challengeSize = 16

		deskey(paddedKeyBytes, EN0)

		for challengeIdx in stride(from: 0, to: challengeSize, by: 8) {
			let bytesAtOffset = dataBytes.advanced(by: challengeIdx)

			des(bytesAtOffset, bytesAtOffset)
		}
	}
}
