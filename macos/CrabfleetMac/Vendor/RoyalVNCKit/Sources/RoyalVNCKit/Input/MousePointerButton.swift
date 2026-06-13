#if canImport(FoundationEssentials)
import FoundationEssentials
#else
import Foundation
#endif

extension VNCProtocol {
	struct MousePointerButton: OptionSet {
		init(rawValue: UInt8) {
			self.rawValue = rawValue
		}

		let rawValue: UInt8

		/// Left
		static let button1 = MousePointerButton(rawValue: 1 << 0)
        static let left = button1

		/// Middle
		static let button2 = MousePointerButton(rawValue: 1 << 1)
        static let middle = button2

		/// Right
		static let button3 = MousePointerButton(rawValue: 1 << 2)
        static let right = button3

		/// Wheel Up
		static let button4 = MousePointerButton(rawValue: 1 << 3)
        static let wheelUp = button4

		/// Wheel Down
		static let button5 = MousePointerButton(rawValue: 1 << 4)
        static let wheelDown = button5

		/// Wheel Left
		static let button6 = MousePointerButton(rawValue: 1 << 5)
        static let wheelLeft = button6

		/// Wheel Right
		static let button7 = MousePointerButton(rawValue: 1 << 6)
        static let wheelRight = button7
	}
}
