#if canImport(CoreGraphics)
#if canImport(FoundationEssentials)
import FoundationEssentials
#else
import Foundation
#endif

import CoreGraphics

public extension VNCPoint {
    /// Initializes a `VNCPoint` from a `CGPoint`.
    /// - Parameter cgPoint: The `CGPoint` to convert.
    init(cgPoint: CGPoint) {
        self.x = .init(cgPoint.x)
        self.y = .init(cgPoint.y)
    }

    /// Converts this `VNCPoint` to a `CGPoint`.
    var cgPoint: CGPoint {
        .init(x: CGFloat(x),
              y: CGFloat(y))
    }
}

public extension CGPoint {
    /// Converts this `CGPoint` to a `VNCPoint`.
    var vncPoint: VNCPoint {
        .init(cgPoint: self)
    }
}
#endif
