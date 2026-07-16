#if canImport(FoundationEssentials)
import FoundationEssentials
#else
import Foundation
#endif

import CommonCrypto

struct VNCDESEncryption {
	static func encrypt(data: Data,
						key: String) -> Data? {
		guard let paddedKey = paddedKey(key) else { return nil }
		return encryptBlocks(data, keyBytes: paddedKey)
	}

	static func encryptBlocks(_ data: Data,
							  keyBytes: [UInt8]) -> Data? {
		guard keyBytes.count == kCCKeySizeDES,
			  data.count.isMultiple(of: kCCBlockSizeDES) else {
			return nil
		}
		guard !data.isEmpty else { return Data() }

		// VNC reverses each key byte before standard DES.
		let key = keyBytes.map(reverseBits)
		var output = Data(count: data.count)
		var moved = 0
		let outputCapacity = output.count
		let status = key.withUnsafeBytes { keyBuffer in
			data.withUnsafeBytes { inputBuffer in
				output.withUnsafeMutableBytes { outputBuffer in
					CCCrypt(
						CCOperation(kCCEncrypt),
						CCAlgorithm(kCCAlgorithmDES),
						CCOptions(kCCOptionECBMode),
						keyBuffer.baseAddress,
						kCCKeySizeDES,
						nil,
						inputBuffer.baseAddress,
						data.count,
						outputBuffer.baseAddress,
						outputCapacity,
						&moved
					)
				}
			}
		}

		guard status == kCCSuccess, moved == data.count else { return nil }
		return output
	}
}

private extension VNCDESEncryption {
	static func paddedKey(_ key: String) -> [UInt8]? {
		let maxKeyLength = kCCKeySizeDES
		guard let encodedKey = key.data(using: .isoLatin1, allowLossyConversion: false) else {
			return nil
		}

		var paddedKey = [UInt8](repeating: 0, count: maxKeyLength)
		for (index, byte) in encodedKey.prefix(maxKeyLength).enumerated() {
			paddedKey[index] = byte
		}
		return paddedKey
	}

	static func reverseBits(_ byte: UInt8) -> UInt8 {
		var source = byte
		var reversed: UInt8 = 0
		for _ in 0..<8 {
			reversed = (reversed << 1) | (source & 1)
			source >>= 1
		}
		return reversed
	}
}
