#if canImport(FoundationEssentials)
import FoundationEssentials
#else
import Foundation
#endif

@_implementationOnly import RoyalVNCKitC

extension RVNC_MOUSEBUTTON {
    var swiftVNCMouseButton: VNCMouseButton {
        switch self {
            case RVNC_MOUSEBUTTON_LEFT:
                .left
            case RVNC_MOUSEBUTTON_MIDDLE:
                .middle
            case RVNC_MOUSEBUTTON_RIGHT:
                .right
            default:
                fatalError("Unknown mouse button: \(self)")
        }
    }
}
