#if canImport(FoundationEssentials)
import FoundationEssentials
#else
import Foundation
#endif

#if !os(Linux) && !os(Windows)
import CoreFoundation
#endif

enum Endianness {
    case little
    case big
}

extension Endianness {
    static var current: Endianness = {
        let endianess: Endianness

#if !os(Linux) && !os(Windows)
        endianess = CFByteOrderGetCurrent() == .init(CFByteOrderLittleEndian.rawValue)
            ? .little
            : .big
#else
        let number: UInt32 = 0x12345678
        let converted = number.bigEndian

        endianess = number == converted
            ? .big
            : .little
#endif

        return endianess
    }()
}
