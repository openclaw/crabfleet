#if canImport(FoundationEssentials)
import FoundationEssentials
#else
import Foundation
#endif

// MARK: - CryptoSwift Implementation
import CryptoSwift

struct AES128ECBEncryption {
    /// AES-128-ECB
    /// - If input is not block-aligned, pad with zeros to 16-byte boundary
    /// - If already aligned, do NOT add an extra block
    static func encrypt(data: Data,
                        key: Data) -> Data? {
        // Ensure the key is 16 bytes for AES-128
        guard key.count == 16 else {
            return nil
        }

        // Manual zero padding only if needed
        var input = data
        let rem = input.count % 16

        if rem != 0 {
            input.append(Data(repeating: 0, count: 16 - rem))
        }

        do {
            // No padding at the cipher level; we already padded
            let aes = try AES(key: key.byteArray,
                              blockMode: ECB(),
                              padding: .noPadding)

            let out = try aes.encrypt(input.byteArray)

            return Data(out)
        } catch {
            return nil
        }
    }
}

// MARK: - libtomcrypt Implementation
//@_implementationOnly import libtomcrypt

//struct AES128ECBEncryption {
//    static func encrypt(data: Data,
//                        key: Data) -> Data? {
//        // Ensure the key is 16 bytes for AES-128
//        guard key.count == 16 else {
//            return nil
//        }
//
//        var aesDesc = aes_desc
//
//        // Register the cipher if necessary
//        guard register_cipher(&aesDesc) == CRYPT_OK else {
//            return nil
//        }
//
//        var ecbKey: symmetric_ECB = symmetric_ECB()
//
//        defer {
//            // Clean up and free the ECB key structure
//            ecb_done(&ecbKey)
//        }
//
//        let blockSizeAES128 = 16
//
//        // Set up the ECB key with AES-128
//        let keySetupResult: Int32 = key.withUnsafeBytes { keyPtr in
//            guard let keyPtrAddr = keyPtr.baseAddress?.assumingMemoryBound(to: UInt8.self) else {
//                return -1
//            }
//
//            let aesCipher = find_cipher("aes")
//
//            // Initialize the ECB structure with the key
//            let result = ecb_start(
//                aesCipher,
//                keyPtrAddr,
//                .init(key.count),
//                0,
//                &ecbKey
//            )
//
//            return result
//        }
//
//        guard keySetupResult == CRYPT_OK else {
//            return nil
//        }
//
//        // Prepare output buffer for ciphertext (same size as input for ECB mode)
//        var cipherBuffer = Data(repeating: 0,
//                                count: ((data.count + blockSizeAES128 - 1) / blockSizeAES128) * blockSizeAES128)
//
//        // Encrypt the data block by block
//        let encryptionResult = cipherBuffer.withUnsafeMutableBytes { cipherBufferPtr in
//            guard let cipherBufferPtrAddr = cipherBufferPtr.baseAddress?.assumingMemoryBound(to: UInt8.self) else {
//                return -1
//            }
//
//            // Encrypt each block of data
//            for blockStart in stride(from: 0,
//                                     to: data.count,
//                                     by: blockSizeAES128) {
//                let blockLength = min(blockSizeAES128,
//                                      data.count - blockStart)
//
//                // Create a block from the data, padding with zeroes if necessary
//                let block = data[blockStart..<blockStart + blockLength]
//
//                let padding = Data(repeating: 0,
//                                   count: blockSizeAES128 - blockLength)
//
//                let paddedBlock = Data(block + padding)
//
//                let encryptBlockResult: Int32 = paddedBlock.withUnsafeBytes { paddedBlockPtr in
//                    guard let paddedBlockPtrAddr = paddedBlockPtr.baseAddress?.assumingMemoryBound(to: UInt8.self) else {
//                        return -1
//                    }
//
//                    // Encrypt the padded block
//                    let result = ecb_encrypt(
//                        paddedBlockPtrAddr,
//                        cipherBufferPtrAddr.advanced(by: blockStart),
//                        .init(blockSizeAES128),
//                        &ecbKey
//                    )
//
//                    return result
//                }
//
//                guard encryptBlockResult == CRYPT_OK else {
//                    return -1
//                }
//            }
//
//            return CRYPT_OK
//        }
//
//        guard encryptionResult == CRYPT_OK else {
//            return nil
//        }
//
//        return cipherBuffer
//    }
//}
