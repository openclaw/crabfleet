#if canImport(IOSurface) && canImport(CoreVideo)
import Foundation
import IOSurface
import CoreVideo

/// A framebuffer allocator implementation that uses `IOSurface` for memory allocation and synchronization.
/// Suitable for high-performance graphics sharing on platforms that support `IOSurface` like macOS and iOS.
public final class VNCFramebufferIOSurfaceAllocator: VNCFramebufferAllocator {
    /// The width of the framebuffer in pixels.
    public let width: Int

    /// The height of the framebuffer in pixels.
    public let height: Int

    /// The number of bytes per pixel.
    public let bytesPerPixel: Int

    /// The number of bytes per row.
    public let bytesPerRow: Int

    var surface: IOSurface?

    private static let surfaceLockOptionsReadOnly: IOSurfaceLockOptions = [ .readOnly ]
    private static let surfaceLockOptionsReadWrite: IOSurfaceLockOptions = [ ]

    /// Initializes a new IOSurface-based framebuffer allocator.
    /// - Parameters:
    ///   - width: The width of the framebuffer in pixels.
    ///   - height: The height of the framebuffer in pixels.
    ///   - bytesPerPixel: The number of bytes per pixel.
    ///   - bytesPerRow: The number of bytes per row.
    public required init(
        width: Int,
        height: Int,
        bytesPerPixel: Int,
        bytesPerRow: Int
    ) {
        self.width = width
        self.height = height
        self.bytesPerPixel = bytesPerPixel
        self.bytesPerRow = bytesPerRow
    }

    /// Allocates a new IOSurface-based framebuffer.
    /// - Parameter size: The desired allocation size in bytes.
    /// - Returns: A pointer to the allocated framebuffer memory.
    /// - Throws: An error if the IOSurface could not be created.
    public func allocate(size: Int) throws -> UnsafeMutableRawPointer {
        // TODO
        let cvPixelFormat = kCVPixelFormatType_32BGRA

        guard let surface = IOSurface(properties: [
            .width: width,
            .height: height,
            .pixelFormat: cvPixelFormat,
            .bytesPerElement: bytesPerPixel,
            .bytesPerRow: bytesPerRow,
            .allocSize: size
        ]) else {
            throw VNCError.protocol(.framebufferFailedToCreateIOSurface)
        }

        self.surface = surface

        return surface.baseAddress
    }

    /// Deallocates the previously allocated `IOSurface` framebuffer.
    /// - Parameter buffer: A pointer to the buffer to deallocate. (Not used)
    public func deallocate(buffer: UnsafeMutableRawPointer) {
        self.surface = nil
    }

    /// Locks the `IOSurface` for read-only access.
    public func lockReadOnly() {
        surface?.lock(options: Self.surfaceLockOptionsReadOnly,
                      seed: nil)
    }

    /// Unlocks the `IOSurface` from read-only access.
    public func unlockReadOnly() {
        surface?.unlock(options: Self.surfaceLockOptionsReadOnly,
                        seed: nil)
    }

    /// Locks the `IOSurface` for read-write access.
    public func lockReadWrite() {
        surface?.lock(options: Self.surfaceLockOptionsReadWrite,
                      seed: nil)
    }

    /// Unlocks the `IOSurface` from read-write access.
    public func unlockReadWrite() {
        surface?.unlock(options: Self.surfaceLockOptionsReadWrite,
                        seed: nil)
    }
}
#endif
