#if canImport(FoundationEssentials)
import FoundationEssentials
#else
import Foundation
#endif

public extension VNCKeyCode {
	static func keyCodesFrom(characters: String) -> [VNCKeyCode] {
		var keys = [VNCKeyCode]()

		for char in characters {
			let charKeys = VNCKeyCode.withCharacter(char)

			keys.append(contentsOf: charKeys)
		}

		return keys
	}
}
