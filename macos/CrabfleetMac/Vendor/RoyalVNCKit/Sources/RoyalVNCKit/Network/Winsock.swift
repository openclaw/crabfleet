#if os(Windows)
#if canImport(FoundationEssentials)
import FoundationEssentials
#else
import Foundation
#endif

import WinSDK

struct Winsock {
    static func intializeWinsock() throws {
        try intializeWinsock(2, 2)
    }

    static func intializeWinsock(_ versionA: UInt8, _ versionB: UInt8) throws(Errors) {
        func makeWord(_ a: UInt8, _ b: UInt8) -> UInt16 {
            return UInt16(a) | (UInt16(b) << 8)
        }

        let wVersionRequested = makeWord(versionA, versionB)

        var lpWSAData = WSADATA()
        let status = WSAStartup(wVersionRequested, &lpWSAData)

        guard status == 0 else {
            throw Errors.winsockInitError(underlyingErrorCode: status)
        }
    }
}

// MARK: - Errors
extension Winsock {
    enum Errors: LocalizedError {
        case winsockInitError(underlyingErrorCode: Int32)

        var errorDescription: String? {
            switch self {
                case .winsockInitError(let underlyingErrorCode):
                    "WSAStartup failed (\(underlyingErrorCode))"
            }
        }
    }
}
#endif
