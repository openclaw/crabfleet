#if canImport(FoundationEssentials)
import FoundationEssentials
#else
import Foundation
#endif

#if canImport(Glibc)
import Glibc
#elseif canImport(WinSDK)
import WinSDK
#elseif canImport(Darwin)
import Darwin
#elseif canImport(Android)
import Android
#endif

final class AddressInfo: @unchecked Sendable {
    private let addrInfo: UnsafeMutablePointer<addrinfo>

    init(host: String,
         port: UInt16) throws(Errors) {
        let sockstream = SOCK_STREAM

#if canImport(Glibc)
        let socktype = Int32(sockstream.rawValue)
#elseif canImport(Android)
        let socktype = Int32(sockstream)
#elseif canImport(WinSDK)
        let socktype = sockstream
#elseif canImport(Darwin)
        let socktype = sockstream
#endif

        var hints = addrinfo()
        hints.ai_flags = AI_PASSIVE
        hints.ai_family = AF_INET
        hints.ai_socktype = socktype

        var addrInfo: UnsafeMutablePointer<addrinfo>?

        // Resolve the address
        let getaddrinfoStatus = getaddrinfo(
            host,
            "\(port)",
            &hints,
            &addrInfo
        )

        guard getaddrinfoStatus == 0 else {
            throw .dnsResolutionFailed
        }

        guard let addrInfo else {
            throw .addressInfoEmpty
        }

        self.addrInfo = addrInfo
    }

    deinit {
        freeaddrinfo(addrInfo)
    }
}

// MARK: - Property Accessors
extension AddressInfo {
#if canImport(Glibc) || canImport(Darwin) || canImport(Android)
    typealias Socklen = socklen_t
#elseif canImport(WinSDK)
    typealias Socklen = Int
#endif

    var flags: Int32 { addrInfo.pointee.ai_flags }
    var family: Int32 { addrInfo.pointee.ai_family }
    var socktype: Int32 { addrInfo.pointee.ai_socktype }
    var `protocol`: Int32 { addrInfo.pointee.ai_protocol }
    var addrlen: Socklen { addrInfo.pointee.ai_addrlen }
    var canonname: UnsafeMutablePointer<CChar>? { addrInfo.pointee.ai_canonname }
    var addr: UnsafeMutablePointer<sockaddr>? { addrInfo.pointee.ai_addr }
    var next: UnsafeMutablePointer<addrinfo>? { addrInfo.pointee.ai_next }
}

// MARK: - Errors
extension AddressInfo {
    enum Errors: LocalizedError {
        case dnsResolutionFailed
        case addressInfoEmpty

        var errorDescription: String? {
            switch self {
                case .dnsResolutionFailed:
                    "DNS resolution failed"
                case .addressInfoEmpty:
                    "Address info is empty"
            }
        }
    }
}
