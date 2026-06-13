#if canImport(FoundationEssentials)
import FoundationEssentials
#else
import Foundation
#endif

@_implementationOnly import RoyalVNCKitC

extension RVNC_MOUSEWHEEL {
    var swiftVNCMouseWheel: VNCMouseWheel {
        switch self {
            case RVNC_MOUSEWHEEL_LEFT:
                .left
            case RVNC_MOUSEWHEEL_RIGHT:
                .right
            case RVNC_MOUSEWHEEL_UP:
                .up
            case RVNC_MOUSEWHEEL_DOWN:
                .down
            default:
                fatalError("Unknown mouse wheel: \(self)")
        }
    }
}
