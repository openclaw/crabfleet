#if canImport(FoundationEssentials)
import FoundationEssentials
#else
import Foundation
#endif

/// A framebuffer allocator that uses standard memory allocation (malloc) for buffer management.
/// Provides cross-platform locking mechanisms for synchronization.
public final class VNCFramebufferMallocAllocator: VNCFramebufferAllocator {
#if canImport(Glibc) || canImport(Android) || canImport(WinSDK)
    private let bufferLock = Spinlock()
#else
    private let bufferLock = NSLock()
#endif

    /// Creates a new instance of the malloc-based framebuffer allocator.
    public init() { }

    /// Allocates a memory buffer of the specified size.
    /// - Parameter size: The number of bytes to allocate.
    /// - Returns: A pointer to the allocated memory.
    /// - Throws: Never throws.
    public func allocate(size: Int) throws -> UnsafeMutableRawPointer {
        let buffer = UnsafeMutableRawPointer.allocate(byteCount: size,
                                                      alignment: MemoryLayout<UInt8>.alignment)

        buffer.initializeMemory(as: UInt8.self,
                                repeating: 0,
                                count: size)

        return buffer
    }

    /// Deallocates a previously allocated memory buffer.
    /// - Parameter buffer: A pointer to the buffer to deallocate.
    public func deallocate(buffer: UnsafeMutableRawPointer) {
        buffer.deallocate()
    }

    /// Acquires a read-only lock to access the framebuffer.
    public func lockReadOnly() {
        bufferLock.lock()
    }

    /// Releases the read-only lock.
    public func unlockReadOnly() {
        bufferLock.unlock()
    }

    /// Acquires a read-write lock to access the framebuffer.
    public func lockReadWrite() {
        bufferLock.lock()
    }

    /// Releases the read-write lock.
    public func unlockReadWrite() {
        bufferLock.unlock()
    }
}
