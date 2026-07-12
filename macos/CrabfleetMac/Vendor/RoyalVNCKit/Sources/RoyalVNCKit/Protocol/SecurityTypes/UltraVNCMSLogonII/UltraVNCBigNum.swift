#if canImport(FoundationEssentials)
import FoundationEssentials
#else
import Foundation
#endif

extension VNCProtocol.UltraVNCMSLogonIIAuthentication.DiffieHellmanKeyAgreement {
	struct UltraVNCBigNum {
		static func dataToBigNum(_ data: Data) -> UInt64 {
			var result = UInt64(0)

			for idx in 0..<8 {
				result <<= 8
				result += .init(data[idx])
			}

			return result
		}

		static func bigNumToData(_ number: UInt64) -> Data {
			var data = Data(repeating: 0, count: 8)

			for idx in 0..<8 {
				let newValue = UInt8(0xff & (number >> (8 * (7 - idx))))

				data[idx] = newValue
			}

			return data
		}

		static func randomBigNum(max: UInt32) -> UInt64 {
			let num = UInt32.random(in: 0..<max)

			return .init(num)
		}

		/// Simple 64bit big integer arithmetic implementation
		/// (x + y) % m, works even if (x + y) > 64bit
		static func addM64(x: UInt64,
						   y: UInt64,
						   m: UInt64) -> UInt64 {
			guard m != 0 else { return 0 }

			let reducedX = x % m
			let reducedY = y % m
			let distanceToModulus = m - reducedY

			if reducedX >= distanceToModulus {
				return reducedX - distanceToModulus
			}

			return reducedX + reducedY
		}

		/// (x * y) % m
		static func mulM64(x: UInt64,
						   y: UInt64,
						   m: UInt64) -> UInt64 {
			guard m != 0 else { return 0 }

			var multiplicand = x % m
			var multiplier = y % m
			var result = UInt64(0)

			while multiplier > 0 {
				if multiplier & 1 != 0 {
					result = addM64(x: result, y: multiplicand, m: m)
				}

				multiplier >>= 1
				multiplicand = addM64(x: multiplicand, y: multiplicand, m: m)
			}

			return result
		}

		/// (x ^ y) % m
		static func powM64(b: UInt64,
						   e: UInt64,
						   m: UInt64) -> UInt64 {
			guard m != 0 else { return 0 }

			var base = b % m
			var exponent = e
			var result = UInt64(1) % m

			while exponent > 0 {
				if exponent & 1 != 0 {
					result = mulM64(x: result, y: base, m: m)
				}

				exponent >>= 1
				base = mulM64(x: base, y: base, m: m)
			}

			return result
		}
	}
}
