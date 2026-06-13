#if canImport(CoreGraphics)
#if canImport(FoundationEssentials)
import FoundationEssentials
#else
import Foundation
#endif

import CoreGraphics

public extension CGRect {
	func flipped(bounds: CGRect) -> CGRect {
        .init(x: self.minX,
              y: bounds.maxY - self.maxY,
              width: self.width,
              height: self.height)
    }
}
#endif
