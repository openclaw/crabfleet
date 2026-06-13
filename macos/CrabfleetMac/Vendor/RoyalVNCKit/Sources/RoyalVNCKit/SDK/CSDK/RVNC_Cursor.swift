#if canImport(FoundationEssentials)
import FoundationEssentials
#else
import Foundation
#endif

@_implementationOnly import RoyalVNCKitC

extension VNCCursor {
    func retainedPointer() -> rvnc_cursor_t {
        .retainedPointerFrom(self)
    }

    func unretainedPointer() -> rvnc_cursor_t {
        .unretainedPointerFrom(self)
    }

    static func autoreleasePointer(_ pointer: rvnc_cursor_t) {
        pointer.autorelease(VNCCursor.self)
    }

    static func fromPointer(_ pointer: rvnc_cursor_t) -> Self {
        pointer.unretainedInstance()
    }
}

@_cdecl("rvnc_cursor_is_empty_get")
@_spi(RoyalVNCKitC)
@available(*, unavailable)
public func rvnc_cursor_is_empty_get(_ cursor: rvnc_cursor_t) -> Bool {
    VNCCursor.fromPointer(cursor)
        .isEmpty
}

@_cdecl("rvnc_cursor_size_width_get")
@_spi(RoyalVNCKitC)
@available(*, unavailable)
public func rvnc_cursor_size_width_get(_ cursor: rvnc_cursor_t) -> UInt16 {
    VNCCursor.fromPointer(cursor)
        .size.width
}

@_cdecl("rvnc_cursor_size_height_get")
@_spi(RoyalVNCKitC)
@available(*, unavailable)
public func rvnc_cursor_size_height_get(_ cursor: rvnc_cursor_t) -> UInt16 {
    VNCCursor.fromPointer(cursor)
        .size.height
}

@_cdecl("rvnc_cursor_hotspot_x_get")
@_spi(RoyalVNCKitC)
@available(*, unavailable)
public func rvnc_cursor_hotspot_x_get(_ cursor: rvnc_cursor_t) -> UInt16 {
    VNCCursor.fromPointer(cursor)
        .hotspot.x
}

@_cdecl("rvnc_cursor_hotspot_y_get")
@_spi(RoyalVNCKitC)
@available(*, unavailable)
public func rvnc_cursor_hotspot_y_get(_ cursor: rvnc_cursor_t) -> UInt16 {
    VNCCursor.fromPointer(cursor)
        .hotspot.y
}

@_cdecl("rvnc_cursor_bits_per_component_get")
@_spi(RoyalVNCKitC)
@available(*, unavailable)
public func rvnc_cursor_bits_per_component_get(_ cursor: rvnc_cursor_t) -> Int64 {
    .init(VNCCursor.fromPointer(cursor).bitsPerComponent)
}

@_cdecl("rvnc_cursor_bits_per_pixel_get")
@_spi(RoyalVNCKitC)
@available(*, unavailable)
public func rvnc_cursor_bits_per_pixel_get(_ cursor: rvnc_cursor_t) -> Int64 {
    .init(VNCCursor.fromPointer(cursor).bitsPerPixel)
}

@_cdecl("rvnc_cursor_bytes_per_pixel_get")
@_spi(RoyalVNCKitC)
@available(*, unavailable)
public func rvnc_cursor_bytes_per_pixel_get(_ cursor: rvnc_cursor_t) -> Int64 {
    .init(VNCCursor.fromPointer(cursor).bytesPerPixel)
}

@_cdecl("rvnc_cursor_bytes_per_row_get")
@_spi(RoyalVNCKitC)
@available(*, unavailable)
public func rvnc_cursor_bytes_per_row_get(_ cursor: rvnc_cursor_t) -> Int64 {
    .init(VNCCursor.fromPointer(cursor).bytesPerRow)
}

@_cdecl("rvnc_cursor_pixel_data_get_copy")
@_spi(RoyalVNCKitC)
@available(*, unavailable)
public func rvnc_cursor_pixel_data_get_copy(_ cursor: rvnc_cursor_t) -> UnsafeMutableRawPointer? {
    let cursorSwift = VNCCursor.fromPointer(cursor)
    let data = cursorSwift.imageData
    let size = data.count

    guard size > 0 else {
        return nil
    }

    let dataC = UnsafeMutableRawBufferPointer.allocate(byteCount: size,
                                                       alignment: MemoryLayout<UInt8>.alignment)

    data.copyBytes(to: dataC)

    return dataC.baseAddress
}

@_cdecl("rvnc_cursor_pixel_data_destroy")
@_spi(RoyalVNCKitC)
@available(*, unavailable)
public func rvnc_cursor_pixel_data_destroy(_ pixelData: UnsafeMutableRawPointer) {
    pixelData.deallocate()
}

@_cdecl("rvnc_cursor_pixel_data_size_get")
@_spi(RoyalVNCKitC)
@available(*, unavailable)
public func rvnc_cursor_pixel_data_size_get(_ cursor: rvnc_cursor_t) -> UInt64 {
    let cursorSwift = VNCCursor.fromPointer(cursor)
    let data = cursorSwift.imageData
    let size = data.count

    return .init(size)
}

@_cdecl("rvnc_cursor_copy_pixel_data_to_rgba32_buffer")
@_spi(RoyalVNCKitC)
@available(*, unavailable)
public func rvnc_cursor_copy_pixel_data_to_rgba32_buffer(_ cursor: rvnc_cursor_t,
                                                         _ destinationPixelBuffer: UnsafeMutableRawPointer) {
    VNCCursor.fromPointer(cursor)
        .copyPixelDataToRGBA32(destinationPixelBuffer: destinationPixelBuffer)
}
