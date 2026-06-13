#if canImport(FoundationEssentials)
import FoundationEssentials
#else
import Foundation
#endif

/// A protocol for allocating and managing memory for a VNC framebuffer.
/// Provides methods for allocation, deallocation, and synchronization using read-only and read-write locks.
public protocol VNCFramebufferAllocator {
    /// Allocates a buffer of the specified size in bytes.
    /// - Parameter size: The size of the buffer to allocate, in bytes.
    /// - Returns: A pointer to the allocated memory.
    /// - Throws: An error if the allocation fails.
    func allocate(size: Int) throws -> UnsafeMutableRawPointer

    /// Deallocates the previously allocated buffer.
    /// - Parameter buffer: The pointer to the buffer to deallocate.
    func deallocate(buffer: UnsafeMutableRawPointer)

    /// Acquires a read-only lock to safely read from the framebuffer.
    func lockReadOnly()

    /// Releases the read-only lock.
    func unlockReadOnly()

    /// Acquires a read-write lock to safely read and write to the framebuffer.
    func lockReadWrite()

    /// Releases the read-write lock.
    func unlockReadWrite()
}
