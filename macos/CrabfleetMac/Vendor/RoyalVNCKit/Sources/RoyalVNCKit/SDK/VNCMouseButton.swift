#if canImport(FoundationEssentials)
import FoundationEssentials
#else
import Foundation
#endif

#if canImport(ObjectiveC)
@objc(VNCMouseButton)
#endif
public enum VNCMouseButton: Int {
    case left
    case middle
    case right
}

#if canImport(ObjectiveC)
@objc(VNCMouseWheel)
#endif
public enum VNCMouseWheel: Int {
    case left
    case right
    case up
    case down
}

extension VNCMouseButton {
    var mousePointerButton: VNCProtocol.MousePointerButton {
        switch self {
            case .left:
                .left
            case .middle:
                .middle
            case .right:
                .right
        }
    }
}

extension VNCMouseWheel {
    var mousePointerButton: VNCProtocol.MousePointerButton {
        switch self {
            case .left:
                .wheelLeft
            case .right:
                .wheelRight
            case .up:
                .wheelUp
            case .down:
                .wheelDown
        }
    }
}
