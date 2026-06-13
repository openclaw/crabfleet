#if canImport(FoundationEssentials)
import FoundationEssentials
#else
import Foundation
#endif

public struct VNCKeyCode: Equatable {
    public let rawValue: UInt32

	// Must be kept in Sync with _ObjC_VNCKeyCode!

	public static let shift = VNCKeyCode(X11KeySymbols.XK_Shift_L)
	public static let rightShift = VNCKeyCode(X11KeySymbols.XK_Shift_R)

	public static let control = VNCKeyCode(X11KeySymbols.XK_Control_L)
    public static let rightControl = VNCKeyCode(X11KeySymbols.XK_Control_R)

	public static let option = VNCKeyCode(X11KeySymbols.XK_Alt_L)
	public static let optionForARD = VNCKeyCode(X11KeySymbols.XK_Meta_L)
    public static let rightOption = VNCKeyCode(X11KeySymbols.XK_Alt_R)
	public static let rightOptionForARD = VNCKeyCode(X11KeySymbols.XK_Meta_R)

	public static let command = VNCKeyCode(X11KeySymbols.XK_Super_L)
	public static let commandForARD = VNCKeyCode(X11KeySymbols.XK_Hyper_L)
	public static let rightCommand = VNCKeyCode(X11KeySymbols.XK_Super_R)
	public static let rightCommandForARD = VNCKeyCode(X11KeySymbols.XK_Hyper_R)

	public static let `return` = VNCKeyCode(X11KeySymbols.XK_Return)
	public static let forwardDelete = VNCKeyCode(X11KeySymbols.XK_Delete)
	public static let space = VNCKeyCode(X11KeySymbols.XK_space)
	public static let delete = VNCKeyCode(X11KeySymbols.XK_BackSpace)
	public static let tab = VNCKeyCode(X11KeySymbols.XK_Tab)
	public static let escape = VNCKeyCode(X11KeySymbols.XK_Escape)
	public static let leftArrow = VNCKeyCode(X11KeySymbols.XK_Left)
	public static let upArrow = VNCKeyCode(X11KeySymbols.XK_Up)
    public static let rightArrow = VNCKeyCode(X11KeySymbols.XK_Right)
    public static let downArrow = VNCKeyCode(X11KeySymbols.XK_Down)
	public static let pageUp = VNCKeyCode(X11KeySymbols.XK_Page_Up)
    public static let pageDown = VNCKeyCode(X11KeySymbols.XK_Page_Down)
	public static let end = VNCKeyCode(X11KeySymbols.XK_End)
	public static let home = VNCKeyCode(X11KeySymbols.XK_Home)
	public static let insert = VNCKeyCode(X11KeySymbols.XK_Insert)

	public static let ansiKeypadClear = VNCKeyCode(X11KeySymbols.XK_Clear)
	public static let ansiKeypadEquals = VNCKeyCode(X11KeySymbols.XK_KP_Equal)
	public static let ansiKeypadDivide = VNCKeyCode(X11KeySymbols.XK_KP_Divide)
	public static let ansiKeypadMultiply = VNCKeyCode(X11KeySymbols.XK_KP_Multiply)
	public static let ansiKeypadMinus = VNCKeyCode(X11KeySymbols.XK_KP_Subtract)
	public static let ansiKeypadPlus = VNCKeyCode(X11KeySymbols.XK_KP_Add)
	public static let ansiKeypadEnter = VNCKeyCode(X11KeySymbols.XK_KP_Enter)
	public static let ansiKeypadDecimal = VNCKeyCode(X11KeySymbols.XK_KP_Separator)

	public static let f1 = VNCKeyCode(X11KeySymbols.XK_F1)
    public static let f2 = VNCKeyCode(X11KeySymbols.XK_F2)
    public static let f3 = VNCKeyCode(X11KeySymbols.XK_F3)
    public static let f4 = VNCKeyCode(X11KeySymbols.XK_F4)
    public static let f5 = VNCKeyCode(X11KeySymbols.XK_F5)
    public static let f6 = VNCKeyCode(X11KeySymbols.XK_F6)
    public static let f7 = VNCKeyCode(X11KeySymbols.XK_F7)
    public static let f8 = VNCKeyCode(X11KeySymbols.XK_F8)
    public static let f9 = VNCKeyCode(X11KeySymbols.XK_F9)
    public static let f10 = VNCKeyCode(X11KeySymbols.XK_F10)
    public static let f11 = VNCKeyCode(X11KeySymbols.XK_F11)
    public static let f12 = VNCKeyCode(X11KeySymbols.XK_F12)
    public static let f13 = VNCKeyCode(X11KeySymbols.XK_F13)
    public static let f14 = VNCKeyCode(X11KeySymbols.XK_F14)
    public static let f15 = VNCKeyCode(X11KeySymbols.XK_F15)
    public static let f16 = VNCKeyCode(X11KeySymbols.XK_F16)
    public static let f17 = VNCKeyCode(X11KeySymbols.XK_F17)
    public static let f18 = VNCKeyCode(X11KeySymbols.XK_F18)
    public static let f19 = VNCKeyCode(X11KeySymbols.XK_F19)

	private static let names: [UInt32: String] = [
		Self.shift.rawValue: "L⇧",
		Self.rightShift.rawValue: "R⇧",

		Self.control.rawValue: "L⋀",
		Self.rightControl.rawValue: "R⋀",

		Self.option.rawValue: "L⌥",
		Self.optionForARD.rawValue: "L⌥ (ARD)",
		Self.rightOption.rawValue: "R⌥",
		Self.rightOptionForARD.rawValue: "R⌥ (ARD)",

		Self.command.rawValue: "L⌘",
		Self.commandForARD.rawValue: "L⌘ (ARD)",
		Self.rightCommand.rawValue: "R⌘",
		Self.rightCommandForARD.rawValue: "R⌘ (ARD)",

		Self.return.rawValue: "Return/Enter",
		Self.forwardDelete.rawValue: "Forward Delete",
		Self.space.rawValue: "Space",
		Self.delete.rawValue: "Delete",
		Self.tab.rawValue: "Tab",
		Self.escape.rawValue: "Escape",
		Self.leftArrow.rawValue: "←",
		Self.upArrow.rawValue: "↑",
		Self.rightArrow.rawValue: "→",
		Self.downArrow.rawValue: "↓",
		Self.pageUp.rawValue: "Page Up",
		Self.pageDown.rawValue: "Page Down",
		Self.end.rawValue: "End",
		Self.home.rawValue: "Home",
		Self.insert.rawValue: "Insert",

		Self.ansiKeypadClear.rawValue: "Keypad Clear",
		Self.ansiKeypadEquals.rawValue: "Keypad =",
		Self.ansiKeypadDivide.rawValue: "Keypad /",
		Self.ansiKeypadMultiply.rawValue: "Keypad *",
		Self.ansiKeypadMinus.rawValue: "Keypad -",
		Self.ansiKeypadPlus.rawValue: "Keypad +",
		Self.ansiKeypadEnter.rawValue: "Keypad Enter",
		Self.ansiKeypadDecimal.rawValue: "Keypad Decimal",

		Self.f1.rawValue: "F1",
		Self.f2.rawValue: "F2",
		Self.f3.rawValue: "F3",
		Self.f4.rawValue: "F4",
		Self.f5.rawValue: "F5",
		Self.f6.rawValue: "F6",
		Self.f7.rawValue: "F7",
		Self.f8.rawValue: "F8",
		Self.f9.rawValue: "F9",
		Self.f10.rawValue: "F10",
		Self.f11.rawValue: "F11",
		Self.f12.rawValue: "F12",
		Self.f13.rawValue: "F13",
		Self.f14.rawValue: "F14",
		Self.f15.rawValue: "F15",
		Self.f16.rawValue: "F16",
		Self.f17.rawValue: "F17",
		Self.f18.rawValue: "F18",
		Self.f19.rawValue: "F19"
	]

    public init(_ rawValue: UInt32) {
        self.rawValue = rawValue
    }

    public init(asciiCharacter: UInt8) {
        self.init(.init(asciiCharacter))
    }

	public static func == (lhs: VNCKeyCode, rhs: VNCKeyCode) -> Bool {
		return lhs.rawValue == rhs.rawValue
	}
}

public extension VNCKeyCode {
	static func withCharacter(_ character: Character) -> [VNCKeyCode] {
		guard character.isPrintable,
			  !character.isNewline else {
			return .init()
		}

		if let asciiValue = character.asciiValue {
			return [ self.init(asciiCharacter: asciiValue) ]
		}

		var codes = [VNCKeyCode]()

		for scalar in character.unicodeScalars {
			let unicodeValue = scalar.value

			codes.append(.init(unicodeValue))
		}

		return codes
	}

	func rawValue(forAppleRemoteDesktop isARD: Bool) -> UInt32 {
		var remappedRawValue: UInt32?

		if isARD {
			switch self {
				case .command:
					remappedRawValue = Self.commandForARD.rawValue
				case .rightCommand:
					remappedRawValue = Self.rightCommandForARD.rawValue
				case .option:
					remappedRawValue = Self.optionForARD.rawValue
				case .rightOption:
					remappedRawValue = Self.rightOptionForARD.rawValue
				default:
					break
			}
		}

		if let remappedRawValue = remappedRawValue {
			return remappedRawValue
		} else {
			return rawValue
		}
	}

	var hexDescription: String {
		let keyHex = rawValue.hexString()

		return keyHex
	}

	var name: String? {
		return Self.names[rawValue]
	}

	var description: String {
		let keyDesc = name ?? hexDescription

		return keyDesc
	}
}
