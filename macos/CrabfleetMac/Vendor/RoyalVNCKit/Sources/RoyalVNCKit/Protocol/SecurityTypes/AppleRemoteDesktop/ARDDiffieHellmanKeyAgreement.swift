#if canImport(FoundationEssentials)
import FoundationEssentials
#else
import Foundation
#endif
import CryptoSwift

extension VNCProtocol.ARDAuthentication {
	struct DiffieHellmanKeyAgreement {
		let publicKey: Data
		let privateKey: Data
		let secretKey: Data

		static func leftPadded(_ value: Data, to length: Int) -> Data? {
			guard length > 0, value.count <= length else { return nil }
			return Data(repeating: 0, count: length - value.count) + value
		}

		init?(prime: Data,
			  generator: Data,
			  peerKey: Data,
			  keyLength: Int) {
			guard Self.validParameters(prime: prime,
									   generator: generator,
									   peerKey: peerKey,
									   keyLength: keyLength) else {
				return nil
			}

			guard let keyPair = Self.generateKeyPair(generator: generator,
													 prime: prime,
													 keyLength: keyLength),
				  !keyPair.privateKey.isEmpty,
				  !keyPair.publicKey.isEmpty else {
				return nil
			}

			guard let secretKey = Self.computeSharedKey(prime: prime,
												peerKey: peerKey,
												privateKey: keyPair.privateKey,
												keyLength: keyLength),
				  !secretKey.isEmpty else {
				return nil
			}

			self.publicKey = keyPair.publicKey
			self.privateKey = keyPair.privateKey
			self.secretKey = secretKey
		}
	}
}

private extension VNCProtocol.ARDAuthentication.DiffieHellmanKeyAgreement {
	static let safePrimeCondition = NSCondition()
	static var validatedSafePrimes = Set<Data>()
	static var rejectedSafePrimes = Set<Data>()
	static var safePrimeValidations = Set<Data>()

	struct KeyPair {
		let publicKey: Data
		let privateKey: Data
	}

	static func validParameters(prime: Data,
								generator: Data,
								peerKey: Data,
								keyLength: Int) -> Bool {
		guard keyLength >= 128,
			  keyLength <= 512,
			  prime.count == keyLength,
			  peerKey.count == keyLength,
			  let bigPrime = BigNum(data: prime),
			  bigPrime.bitsCount == keyLength * 8,
			  let bigGenerator = BigNum(data: generator),
			  bigGenerator.isValidDiffieHellmanElement(modulus: bigPrime),
			  let bigPeerKey = BigNum(data: peerKey),
			  bigPeerKey.isValidDiffieHellmanElement(modulus: bigPrime),
			  Self.isSafePrime(prime) else {
			return false
		}

		return true
	}

	static func isSafePrime(_ data: Data) -> Bool {
		safePrimeCondition.lock()
		while safePrimeValidations.contains(data) {
			safePrimeCondition.wait()
		}
		if validatedSafePrimes.contains(data) {
			safePrimeCondition.unlock()
			return true
		}
		if rejectedSafePrimes.contains(data) {
			safePrimeCondition.unlock()
			return false
		}
		safePrimeValidations.insert(data)
		safePrimeCondition.unlock()

		let prime = CS.BigUInt(data)
		let valid = prime.isPrime(rounds: 16) && ((prime - 1) >> 1).isPrime(rounds: 16)

		safePrimeCondition.lock()
		safePrimeValidations.remove(data)
		if valid {
			validatedSafePrimes.insert(data)
		} else {
			if rejectedSafePrimes.count >= 32, let evicted = rejectedSafePrimes.first {
				rejectedSafePrimes.remove(evicted)
			}
			rejectedSafePrimes.insert(data)
		}
		safePrimeCondition.broadcast()
		safePrimeCondition.unlock()
		return valid
	}

	static func generateKeyPair(generator: Data,
								prime: Data,
								keyLength: Int) -> KeyPair? {
		let bigPrivKey = BigNum()
		let bigPubKey = BigNum()

		guard let bigPrime = BigNum(data: prime),
			  bigPrime.isGreaterThanOne,
			  let bigGenerator = BigNum(data: generator) else {
			return nil
		}

		// Generate DH private key
		repeat {
			let randSuccess = bigPrivKey.rand(range: bigPrime)

			guard randSuccess else {
				return nil
			}
		} while bigPrivKey.isZero

		let modSuccess = BigNum.modExp(y: bigPubKey,
									   g: bigGenerator,
									   x: bigPrivKey,
									   p: bigPrime)

		guard modSuccess, !bigPubKey.isZero else {
			return nil
		}

		guard bigPrivKey.bytesCount <= keyLength,
			  bigPubKey.bytesCount <= keyLength else {
			return nil
		}

		guard let privKey = bigPrivKey.bigEndianData(),
			  let minimalPubKey = bigPubKey.bigEndianData(),
			  let pubKey = leftPadded(minimalPubKey, to: keyLength) else {
			return nil
		}

		let keyPair = KeyPair(publicKey: pubKey,
							  privateKey: privKey)

		return keyPair
	}

	static func computeSharedKey(prime: Data,
								 peerKey: Data,
								 privateKey: Data,
								 keyLength: Int) -> Data? {
		guard let bigPrime = BigNum(data: prime),
			  let bigPrivKey = BigNum(data: privateKey),
			  let bigPeerKey = BigNum(data: peerKey) else {
			return nil
		}

		let bigSharedKey = BigNum()

		let modSuccess = BigNum.modExp(y: bigSharedKey,
									   g: bigPeerKey,
									   x: bigPrivKey,
									   p: bigPrime)

		guard modSuccess, !bigSharedKey.isZero else {
			return nil
		}

		guard let minimalSharedKey = bigSharedKey.bigEndianData(),
			  let sharedKey = leftPadded(minimalSharedKey, to: keyLength) else {
			return nil
		}

		return sharedKey
	}
}
