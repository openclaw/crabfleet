#if os(macOS)
#if canImport(FoundationEssentials)
import FoundationEssentials
#else
import Foundation
#endif

import CoreGraphics

public extension VNCKeyCode {
    static func keyCodesFrom(cgKeyCode: CGKeyCode,
                             characters: String?) -> [VNCKeyCode] {
		var keys: [VNCKeyCode]

        if let key = VNCKeyCode.from(cgKeyCode: cgKeyCode) {
            keys = [ key ]
        } else if let chars = characters {
			keys = VNCKeyCode.keyCodesFrom(characters: chars)
		} else {
			keys = .init()
		}

        return keys
    }
}
#endif
