#if canImport(FoundationEssentials)
import FoundationEssentials
#else
import Foundation
#endif

extension Character {
	var isPrintable: Bool {
		isASCII ||
		isLetter ||
		isNumber ||
		isCurrencySymbol ||
		isMathSymbol ||
		isPunctuation ||
		isSymbol
	}
}
