#if canImport(FoundationEssentials)
import FoundationEssentials
#else
import Foundation
#endif

@_implementationOnly import RoyalVNCKitC

final class VNCFrameEncodings_C {
    private(set) var frameEncodings = [VNCFrameEncodingType]()
}

extension VNCFrameEncodings_C {
    func retainedPointer() -> rvnc_frame_encodings_t {
        .retainedPointerFrom(self)
    }

    func unretainedPointer() -> rvnc_frame_encodings_t {
        .unretainedPointerFrom(self)
    }

    static func autoreleasePointer(_ pointer: rvnc_frame_encodings_t) {
        pointer.autorelease(VNCFrameEncodings_C.self)
    }

    static func fromPointer(_ pointer: rvnc_frame_encodings_t) -> Self {
        pointer.unretainedInstance()
    }
}

private extension VNCFrameEncodings_C {
    func append(_ frameEncoding: VNCFrameEncodingType) {
        frameEncodings.removeAll(where: { $0 == frameEncoding })

        frameEncodings.append(frameEncoding)
    }
}

@_cdecl("rvnc_frame_encodings_create")
@_spi(RoyalVNCKitC)
@available(*, unavailable)
public func rvnc_frame_encodings_create() -> rvnc_frame_encodings_t {
    let frameEncodings = VNCFrameEncodings_C()

    return frameEncodings.retainedPointer()
}

@_cdecl("rvnc_frame_encodings_append_tight")
@_spi(RoyalVNCKitC)
@available(*, unavailable)
public func rvnc_frame_encodings_append_tight(_ frameEncodings: rvnc_frame_encodings_t) {
    VNCFrameEncodings_C.fromPointer(frameEncodings)
        .append(.tight)
}

@_cdecl("rvnc_frame_encodings_append_zlib")
@_spi(RoyalVNCKitC)
@available(*, unavailable)
public func rvnc_frame_encodings_append_zlib(_ frameEncodings: rvnc_frame_encodings_t) {
    VNCFrameEncodings_C.fromPointer(frameEncodings)
        .append(.zlib)
}

@_cdecl("rvnc_frame_encodings_append_zrle")
@_spi(RoyalVNCKitC)
@available(*, unavailable)
public func rvnc_frame_encodings_append_zrle(_ frameEncodings: rvnc_frame_encodings_t) {
    VNCFrameEncodings_C.fromPointer(frameEncodings)
        .append(.zrle)
}

@_cdecl("rvnc_frame_encodings_append_hextile")
@_spi(RoyalVNCKitC)
@available(*, unavailable)
public func rvnc_frame_encodings_append_hextile(_ frameEncodings: rvnc_frame_encodings_t) {
    VNCFrameEncodings_C.fromPointer(frameEncodings)
        .append(.hextile)
}

@_cdecl("rvnc_frame_encodings_append_corre")
@_spi(RoyalVNCKitC)
@available(*, unavailable)
public func rvnc_frame_encodings_append_corre(_ frameEncodings: rvnc_frame_encodings_t) {
    VNCFrameEncodings_C.fromPointer(frameEncodings)
        .append(.coRRE)
}

@_cdecl("rvnc_frame_encodings_append_rre")
@_spi(RoyalVNCKitC)
@available(*, unavailable)
public func rvnc_frame_encodings_append_rre(_ frameEncodings: rvnc_frame_encodings_t) {
    VNCFrameEncodings_C.fromPointer(frameEncodings)
        .append(.rre)
}

@_cdecl("rvnc_frame_encodings_destroy")
@_spi(RoyalVNCKitC)
@available(*, unavailable)
public func rvnc_frame_encodings_destroy(_ frameEncodings: rvnc_frame_encodings_t) {
    VNCFrameEncodings_C.autoreleasePointer(frameEncodings)
}
