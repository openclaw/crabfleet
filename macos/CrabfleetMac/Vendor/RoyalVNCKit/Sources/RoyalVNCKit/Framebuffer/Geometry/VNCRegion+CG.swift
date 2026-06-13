#if canImport(CoreGraphics)
#if canImport(FoundationEssentials)
import FoundationEssentials
#else
import Foundation
#endif

import CoreGraphics

public extension VNCRegion {
    /// Initializes a `VNCRegion` from a `CGRect`.
    /// - Parameter cgRect: The CoreGraphics rectangle to convert.
    init(cgRect: CGRect) {
        self.location = .init(cgPoint: cgRect.origin)
        self.size = .init(cgSize: cgRect.size)
    }

    /// Converts the `VNCRegion` to a `CGRect`.
    /// Useful for interoperability with CoreGraphics-based APIs.
    var cgRect: CGRect {
        .init(origin: location.cgPoint,
              size: size.cgSize)
    }

    /// Returns a vertically flipped version of this region within a given bounding region.
    /// - Parameter bounds: The bounding region used for flipping.
    /// - Returns: A new `VNCRegion` that is flipped vertically within the specified bounds.
    func flipped(bounds: VNCRegion) -> Self {
        let selfCG = self.cgRect

        return .init(x: .init(selfCG.minX),
                     y: .init(bounds.cgRect.maxY - selfCG.maxY),
                     width: .init(selfCG.width),
                     height: .init(selfCG.height))
    }
}

public extension CGRect {
    /// Converts a `CGRect` to a `VNCRegion`.
    var vncRegion: VNCRegion {
        .init(cgRect: self)
    }
}
#endif
