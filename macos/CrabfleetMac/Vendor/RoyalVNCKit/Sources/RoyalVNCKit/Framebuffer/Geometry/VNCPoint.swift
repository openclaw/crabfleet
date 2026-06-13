#if canImport(FoundationEssentials)
import FoundationEssentials
#else
import Foundation
#endif

/// Represents a 2D point with unsigned 16-bit integer coordinates.
/// Commonly used for positions in a VNC framebuffer.
public struct VNCPoint: Equatable {
    /// The horizontal coordinate.
    public let x: UInt16

    /// The vertical coordinate.
    public let y: UInt16

    /// Creates a new point with the specified x and y coordinates.
    /// - Parameters:
    ///   - x: The horizontal coordinate.
    ///   - y: The vertical coordinate.
    public init(x: UInt16,
                y: UInt16) {
        self.x = x
        self.y = y
    }
}

extension VNCPoint: Hashable {
    public func hash(into hasher: inout Hasher) {
        hasher.combine(x)
        hasher.combine(y)
    }
}

public extension VNCPoint {
    /// A point with both coordinates set to zero.
    static let zero: Self = .init(x: 0,
                                  y: 0)
}

extension VNCPoint: CustomStringConvertible {
    /// A textual representation of the point, useful for debugging.
    public var description: String {
        "x: \(x), y: \(y)"
    }
}
