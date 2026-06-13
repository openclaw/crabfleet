#if canImport(FoundationEssentials)
import FoundationEssentials
#else
import Foundation
#endif

class GraphicsUtils {
    static func copyBGRAtoRGBA(srcBuffer: UnsafeRawPointer,
                               dstBuffer: UnsafeMutableRawPointer,
                               byteCount: Int) {
        let src = srcBuffer.assumingMemoryBound(to: UInt8.self)
        let dst = dstBuffer.assumingMemoryBound(to: UInt8.self)

        let pixelCount = byteCount / 4
        var i = 0

        while i < pixelCount {
            let b = src[i * 4]
            let g = src[i * 4 + 1]
            let r = src[i * 4 + 2]
            let a = src[i * 4 + 3]

            dst[i * 4] = r
            dst[i * 4 + 1] = g
            dst[i * 4 + 2] = b
            dst[i * 4 + 3] = a

            i += 1
        }
    }
}
