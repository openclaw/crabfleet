#if canImport(FoundationEssentials)
import FoundationEssentials
#else
import Foundation
#endif

extension BinaryInteger {
    func hexString() -> String {
        "0x\(String(self, radix: 16, uppercase: true))"
    }
}