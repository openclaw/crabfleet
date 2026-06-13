#if canImport(FoundationEssentials)
import FoundationEssentials
#else
import Foundation
#endif

#if canImport(WinSDK)
import WinSDK
#endif

#if canImport(Glibc)
import Glibc
#endif

#if canImport(Android)
import Android
#endif

extension String {
    func duplicateCString() -> UnsafeMutablePointer<CChar>? {
#if canImport(WinSDK)
        // avoid: warning: 'strdup' is deprecated: The POSIX name for this item is deprecated. Instead, use the ISO C and C++ conformant name: _strdup
        return _strdup(self)
#else
        return strdup(self)
#endif
    }
}
