#if canImport(FoundationEssentials)
import FoundationEssentials
#else
import Foundation
#endif

extension Array where Element: Hashable {
	func uniqued() -> Array {
		var unique = Set<Element>()

		return filter { element in
			return unique.insert(element).inserted
		}
	}
}
