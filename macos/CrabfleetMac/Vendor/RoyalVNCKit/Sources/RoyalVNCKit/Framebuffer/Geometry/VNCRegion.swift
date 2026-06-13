#if canImport(FoundationEssentials)
import FoundationEssentials
#else
import Foundation
#endif

/// Represents a rectangular region defined by an origin point and a size.
/// Commonly used to describe areas within a VNC framebuffer.
public struct VNCRegion: Equatable {
    /// The origin point of the region.
    public let location: VNCPoint

    /// The size of the region.
    public let size: VNCSize

    /// Creates a new `VNCRegion` with the specified location and size.
    /// - Parameters:
    ///   - location: The origin point of the region.
    ///   - size: The size of the region.
    public init(location: VNCPoint,
                size: VNCSize) {
        self.location = location
        self.size = size
    }

    /// Creates a new `VNCRegion` with individual coordinate and size components.
    /// - Parameters:
    ///   - x: The x-coordinate of the origin.
    ///   - y: The y-coordinate of the origin.
    ///   - width: The width of the region.
    ///   - height: The height of the region.
    public init(x: UInt16, y: UInt16,
                width: UInt16, height: UInt16) {
        self.location = .init(x: x, y: y)
        self.size = .init(width: width, height: height)
    }
}

extension VNCRegion: Hashable {
    public func hash(into hasher: inout Hasher) {
        hasher.combine(location)
        hasher.combine(size)
    }
}

public extension VNCRegion {
    /// A region with zero origin and zero size.
    static let zero: Self = .init(location: .zero,
                                  size: .zero)

    /// The x-coordinate of the region's origin.
    var x: UInt16 { location.x }

    /// The y-coordinate of the region's origin.
    var y: UInt16 { location.y }

    /// The width of the region.
    var width: UInt16 { size.width }

    /// The height of the region.
    var height: UInt16 { size.height }
}

extension VNCRegion: CustomStringConvertible {
    /// A textual representation of the region, useful for debugging.
    public var description: String {
        "\(location); \(size)"
    }
}
