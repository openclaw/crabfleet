#if canImport(CoreGraphics)
#if canImport(FoundationEssentials)
import FoundationEssentials
#else
import Foundation
#endif

import CoreGraphics

public extension VNCSize {
    /// Initializes a `VNCSize` from a `CGSize`.
    /// - Parameter cgSize: The CoreGraphics size to convert.
    init(cgSize: CGSize) {
        self.width = .init(cgSize.width)
        self.height = .init(cgSize.height)
    }

    /// Converts this `VNCSize` to a `CGSize`.
    var cgSize: CGSize {
        .init(width: CGFloat(width),
              height: CGFloat(height))
    }
}

public extension CGSize {
    /// Converts a `CGSize` to a `VNCSize`.
    var vncSize: VNCSize {
        .init(cgSize: self)
    }
}
#endif
