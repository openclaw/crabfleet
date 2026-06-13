#if canImport(FoundationEssentials)
import FoundationEssentials
#else
import Foundation
#endif

@_implementationOnly import RoyalVNCKitC

extension VNCFramebuffer {
    func retainedPointer() -> rvnc_framebuffer_t {
        .retainedPointerFrom(self)
    }

    func unretainedPointer() -> rvnc_framebuffer_t {
        .unretainedPointerFrom(self)
    }

    static func autoreleasePointer(_ pointer: rvnc_framebuffer_t) {
        pointer.autorelease(VNCFramebuffer.self)
    }

    static func fromPointer(_ pointer: rvnc_framebuffer_t) -> Self {
        pointer.unretainedInstance()
    }
}

@_cdecl("rvnc_framebuffer_size_width_get")
@_spi(RoyalVNCKitC)
@available(*, unavailable)
public func rvnc_framebuffer_size_width_get(_ framebuffer: rvnc_connection_state_t) -> UInt16 {
    VNCFramebuffer.fromPointer(framebuffer)
        .size.width
}

@_cdecl("rvnc_framebuffer_size_height_get")
@_spi(RoyalVNCKitC)
@available(*, unavailable)
public func rvnc_framebuffer_size_height_get(_ framebuffer: rvnc_connection_state_t) -> UInt16 {
    VNCFramebuffer.fromPointer(framebuffer)
        .size.height
}

@_cdecl("rvnc_framebuffer_pixel_data_get")
@_spi(RoyalVNCKitC)
@available(*, unavailable)
public func rvnc_framebuffer_pixel_data_get(_ framebuffer: rvnc_connection_state_t) -> UnsafeMutableRawPointer {
    VNCFramebuffer.fromPointer(framebuffer)
        .surfaceAddress
}

@_cdecl("rvnc_framebuffer_pixel_data_size_get")
@_spi(RoyalVNCKitC)
@available(*, unavailable)
public func rvnc_framebuffer_pixel_data_size_get(_ framebuffer: rvnc_connection_state_t) -> UInt64 {
    let framebufferSwift = VNCFramebuffer.fromPointer(framebuffer)
    let surfaceByteCount = framebufferSwift.surfaceByteCount

    return .init(surfaceByteCount)
}

@_cdecl("rvnc_framebuffer_pixel_data_rgba32_get_copy")
@_spi(RoyalVNCKitC)
@available(*, unavailable)
public func rvnc_framebuffer_pixel_data_rgba32_get_copy(_ framebuffer: rvnc_connection_state_t,
                                                        _ pixelDataSize: UnsafeMutablePointer<UInt64>?) -> UnsafeMutableRawPointer {
    var byteCount: Int = 0

    let framebuffer = VNCFramebuffer.fromPointer(framebuffer)
    let pixelBuffer = framebuffer.copyPixelDataToRGBA32(pixelDataSize: &byteCount)

    pixelDataSize?.pointee = .init(byteCount)

    return pixelBuffer
}

@_cdecl("rvnc_framebuffer_pixel_data_rgba32_destroy")
@_spi(RoyalVNCKitC)
@available(*, unavailable)
public func rvnc_framebuffer_pixel_data_rgba32_destroy(_ framebuffer: rvnc_connection_state_t,
                                                       _ buffer: UnsafeMutableRawPointer) {
    VNCFramebuffer.fromPointer(framebuffer)
        .destroyRGBA32PixelData(buffer)
}

@_cdecl("rvnc_framebuffer_copy_pixel_data_to_rgba32_buffer")
@_spi(RoyalVNCKitC)
@available(*, unavailable)
public func rvnc_framebuffer_copy_pixel_data_to_rgba32_buffer(_ framebuffer: rvnc_connection_state_t,
                                                              _ destinationPixelBuffer: UnsafeMutableRawPointer) {
    VNCFramebuffer.fromPointer(framebuffer)
        .copyPixelDataToRGBA32(destinationPixelBuffer: destinationPixelBuffer)
}
