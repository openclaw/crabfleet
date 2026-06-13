#if canImport(FoundationEssentials)
import FoundationEssentials
#else
import Foundation
#endif

/// Represents a size with width and height in unsigned 16-bit integers.
/// Commonly used to describe the dimensions of a VNC framebuffer or region.
public struct VNCSize: Equatable {
    /// The width component of the size.
    public let width: UInt16

    /// The height component of the size.
    public let height: UInt16

    /// Creates a new `VNCSize` with the specified width and height.
    /// - Parameters:
    ///   - width: The width value.
    ///   - height: The height value.
    public init(width: UInt16,
                height: UInt16) {
        self.width = width
        self.height = height
    }
}

extension VNCSize: Hashable {
    public func hash(into hasher: inout Hasher) {
        hasher.combine(width)
        hasher.combine(height)
    }
}

public extension VNCSize {
    /// A `VNCSize` value with both width and height set to zero.
    static let zero: Self = .init(width: 0,
                                  height: 0)
}

extension VNCSize: CustomStringConvertible {
    /// A textual representation of the size, useful for debugging.
    public var description: String {
        "width: \(width), height: \(height)"
    }
}
