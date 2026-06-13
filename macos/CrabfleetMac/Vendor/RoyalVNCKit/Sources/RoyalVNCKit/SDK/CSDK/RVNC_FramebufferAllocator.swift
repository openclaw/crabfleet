#if canImport(FoundationEssentials)
import FoundationEssentials
#else
import Foundation
#endif

@_implementationOnly import RoyalVNCKitC

class VNCFramebufferAllocator_C: VNCFramebufferAllocator {
#if canImport(Glibc) || canImport(Android) || canImport(WinSDK)
    private let bufferLock = Spinlock()
#else
    private let bufferLock = NSLock()
#endif

    let allocateFunc: rvnc_framebuffer_allocator_allocate
    let deallocateFunc: rvnc_framebuffer_allocator_deallocate

    init(allocateFunc: rvnc_framebuffer_allocator_allocate,
         deallocateFunc: rvnc_framebuffer_allocator_deallocate) {
        self.allocateFunc = allocateFunc
        self.deallocateFunc = deallocateFunc
    }

    func allocate(size: Int) throws -> UnsafeMutableRawPointer {
        let pixelData = allocateFunc(
            self.unretainedPointer(),
            size
        )

        return pixelData
    }

    func deallocate(buffer: UnsafeMutableRawPointer) {
        deallocateFunc(
            self.unretainedPointer(),
            buffer
        )
    }

    static func fromPointer(_ pointer: rvnc_framebuffer_allocator_t) -> VNCFramebufferAllocator_C {
        let allocatorC: VNCFramebufferAllocator_C = pointer.unretainedInstance()

        return allocatorC
    }

    func lockReadOnly() {
        bufferLock.lock()
    }

    func unlockReadOnly() {
        bufferLock.unlock()
    }

    func lockReadWrite() {
        bufferLock.lock()
    }

    func unlockReadWrite() {
        bufferLock.unlock()
    }
}

extension VNCFramebufferAllocator_C {
    func retainedPointer() -> rvnc_framebuffer_allocator_t {
        .retainedPointerFrom(self)
    }

    func unretainedPointer() -> rvnc_framebuffer_allocator_t {
        .unretainedPointerFrom(self)
    }

    static func autoreleasePointer(_ pointer: rvnc_framebuffer_allocator_t) {
        pointer.autorelease(VNCFramebufferAllocator_C.self)
    }
}

@_cdecl("rvnc_framebuffer_allocator_create")
@_spi(RoyalVNCKitC)
@available(*, unavailable)
public func rvnc_framebuffer_allocator_create(_ allocate: rvnc_framebuffer_allocator_allocate,
                                              _ deallocate: rvnc_framebuffer_allocator_deallocate) -> rvnc_framebuffer_allocator_t {
    let allocator = VNCFramebufferAllocator_C(
        allocateFunc: allocate,
        deallocateFunc: deallocate
    )

    return allocator.retainedPointer()
}

@_cdecl("rvnc_framebuffer_allocator_destroy")
@_spi(RoyalVNCKitC)
@available(*, unavailable)
public func rvnc_framebuffer_allocator_destroy(_ allocator: rvnc_framebuffer_allocator_t) {
    VNCFramebufferAllocator_C.autoreleasePointer(allocator)
}
