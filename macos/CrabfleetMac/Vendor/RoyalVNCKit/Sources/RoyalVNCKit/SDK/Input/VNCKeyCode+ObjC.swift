// This is hacky, but I currently don't have a better idea on how to handle this for ObjC

#if canImport(ObjectiveC)
#if canImport(FoundationEssentials)
import FoundationEssentials
#else
import Foundation
#endif

@objc(VNCKeyCode)
// swiftlint:disable:next type_name
public final class _ObjC_VNCKeyCode: NSObject {
	// Must be kept in Sync with VNCKeyCode!

    @objc
    public static let shift = X11KeySymbols.XK_Shift_L
    @objc
    public static let rightShift = X11KeySymbols.XK_Shift_R

    @objc
    public static let control = X11KeySymbols.XK_Control_L
    @objc
    public static let rightControl = X11KeySymbols.XK_Control_R

    @objc
    public static let option = X11KeySymbols.XK_Alt_L
    @objc
    public static let optionForARD = X11KeySymbols.XK_Meta_L
    @objc
    public static let rightOption = X11KeySymbols.XK_Alt_R
    @objc
    public static let rightOptionForARD = X11KeySymbols.XK_Meta_R

    @objc
    public static let command = X11KeySymbols.XK_Super_L
    @objc
    public static let commandForARD = X11KeySymbols.XK_Hyper_L
    @objc
    public static let rightCommand = X11KeySymbols.XK_Super_R
    @objc
    public static let rightCommandForARD = X11KeySymbols.XK_Hyper_R

    @objc
    public static let `return` = X11KeySymbols.XK_Return
    @objc
    public static let forwardDelete = X11KeySymbols.XK_Delete
    @objc
    public static let space = X11KeySymbols.XK_space
    @objc
    public static let delete = X11KeySymbols.XK_BackSpace
    @objc
    public static let tab = X11KeySymbols.XK_Tab
    @objc
    public static let escape = X11KeySymbols.XK_Escape
    @objc
    public static let leftArrow = X11KeySymbols.XK_Left
    @objc
    public static let upArrow = X11KeySymbols.XK_Up
    @objc
    public static let rightArrow = X11KeySymbols.XK_Right
    @objc
    public static let downArrow = X11KeySymbols.XK_Down
    @objc
    public static let pageUp = X11KeySymbols.XK_Page_Up
    @objc
    public static let pageDown = X11KeySymbols.XK_Page_Down
    @objc
    public static let end = X11KeySymbols.XK_End
    @objc
    public static let home = X11KeySymbols.XK_Home
    @objc
    public static let insert = X11KeySymbols.XK_Insert

    @objc
    public static let ansiKeypadClear = X11KeySymbols.XK_Clear
    @objc
    public static let ansiKeypadEquals = X11KeySymbols.XK_KP_Equal
    @objc
    public static let ansiKeypadDivide = X11KeySymbols.XK_KP_Divide
    @objc
    public static let ansiKeypadMultiply = X11KeySymbols.XK_KP_Multiply
    @objc
    public static let ansiKeypadMinus = X11KeySymbols.XK_KP_Subtract
    @objc
    public static let ansiKeypadPlus = X11KeySymbols.XK_KP_Add
    @objc
    public static let ansiKeypadEnter = X11KeySymbols.XK_KP_Enter
    @objc
    public static let ansiKeypadDecimal = X11KeySymbols.XK_KP_Separator

    @objc
    public static let f1 = X11KeySymbols.XK_F1
    @objc
    public static let f2 = X11KeySymbols.XK_F2
    @objc
    public static let f3 = X11KeySymbols.XK_F3
    @objc
    public static let f4 = X11KeySymbols.XK_F4
    @objc
    public static let f5 = X11KeySymbols.XK_F5
    @objc
    public static let f6 = X11KeySymbols.XK_F6
    @objc
    public static let f7 = X11KeySymbols.XK_F7
    @objc
    public static let f8 = X11KeySymbols.XK_F8
    @objc
    public static let f9 = X11KeySymbols.XK_F9
    @objc
    public static let f10 = X11KeySymbols.XK_F10
    @objc
    public static let f11 = X11KeySymbols.XK_F11
    @objc
    public static let f12 = X11KeySymbols.XK_F12
    @objc
    public static let f13 = X11KeySymbols.XK_F13
    @objc
    public static let f14 = X11KeySymbols.XK_F14
    @objc
    public static let f15 = X11KeySymbols.XK_F15
    @objc
    public static let f16 = X11KeySymbols.XK_F16
    @objc
    public static let f17 = X11KeySymbols.XK_F17
    @objc
    public static let f18 = X11KeySymbols.XK_F18
    @objc
    public static let f19 = X11KeySymbols.XK_F19
}

public extension _ObjC_VNCKeyCode {
    @objc
	static func keyCodes(withAsciiCharacter asciiCharacter: UInt8) -> UInt32 {
		return .init(asciiCharacter)
	}

    @objc
	static func keyCodes(withString string: String) -> [UInt32] {
		var objcKeyCodes = [UInt32]()

		for character in string {
			let vncKeyCodes = VNCKeyCode.withCharacter(character)

			for vncKeyCode in vncKeyCodes {
				objcKeyCodes.append(.init(vncKeyCode.rawValue))
			}
		}

		return objcKeyCodes
	}

    @objc
	static func rawValue(ofKeyCode keyCode: UInt32,
						 forAppleRemoteDesktop isARD: Bool) -> UInt32 {
		return VNCKeyCode(keyCode).rawValue(forAppleRemoteDesktop: isARD)
	}

    @objc
	static func hexDescription(ofKeyCode keyCode: UInt32) -> String {
		return VNCKeyCode(keyCode).hexDescription
	}

    @objc
	static func name(ofKeyCode keyCode: UInt32) -> String? {
		return VNCKeyCode(keyCode).name
	}

    @objc
	static func description(ofKeyCode keyCode: UInt32) -> String {
		return VNCKeyCode(keyCode).description
	}
}
#endif
