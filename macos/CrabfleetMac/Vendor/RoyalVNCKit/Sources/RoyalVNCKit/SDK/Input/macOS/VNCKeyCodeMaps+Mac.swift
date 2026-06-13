#if os(macOS)
#if canImport(FoundationEssentials)
import FoundationEssentials
#else
import Foundation
#endif

import CoreGraphics

public extension VNCKeyCode {
    static func from(cgKeyCode: CGKeyCode) -> VNCKeyCode? {
        let keyCode = VNCKeyCodeMaps.cgKeyCodeToVNCKeyCodeMapping[cgKeyCode]

        return keyCode
    }
}

private struct VNCKeyCodeMaps {
    static let cgKeyCodeToVNCKeyCodeMapping: [CGKeyCode: VNCKeyCode] = [
        CGKeyCodes.shift: .shift,
        CGKeyCodes.rightShift: .rightShift,

        CGKeyCodes.control: .control,
        CGKeyCodes.rightControl: .rightControl,

        CGKeyCodes.option: .option,
        CGKeyCodes.rightOption: .rightOption,

        CGKeyCodes.command: .command,
        CGKeyCodes.rightCommand: .rightCommand,

        CGKeyCodes.return: .return,
        CGKeyCodes.forwardDelete: .forwardDelete,
        CGKeyCodes.space: .space,
        CGKeyCodes.delete: .delete,
        CGKeyCodes.tab: .tab,
        CGKeyCodes.escape: .escape,

        CGKeyCodes.leftArrow: .leftArrow,
        CGKeyCodes.upArrow: .upArrow,
        CGKeyCodes.rightArrow: .rightArrow,
        CGKeyCodes.downArrow: .downArrow,

        CGKeyCodes.pageUp: .pageUp,
        CGKeyCodes.pageDown: .pageDown,
        CGKeyCodes.end: .end,
        CGKeyCodes.home: .home,
		CGKeyCodes.help: .insert,

        CGKeyCodes.ansiKeypadClear: .ansiKeypadClear,
        CGKeyCodes.ansiKeypadEquals: .ansiKeypadEquals,
        CGKeyCodes.ansiKeypadDivide: .ansiKeypadDivide,
        CGKeyCodes.ansiKeypadMultiply: .ansiKeypadMultiply,
        CGKeyCodes.ansiKeypadMinus: .ansiKeypadMinus,
        CGKeyCodes.ansiKeypadPlus: .ansiKeypadPlus,
        CGKeyCodes.ansiKeypadEnter: .ansiKeypadEnter,
        CGKeyCodes.ansiKeypadDecimal: .ansiKeypadDecimal,

        CGKeyCodes.f1: .f1,
        CGKeyCodes.f2: .f2,
        CGKeyCodes.f3: .f3,
        CGKeyCodes.f4: .f4,
        CGKeyCodes.f5: .f5,
        CGKeyCodes.f6: .f6,
        CGKeyCodes.f7: .f7,
        CGKeyCodes.f8: .f8,
        CGKeyCodes.f9: .f9,
        CGKeyCodes.f10: .f10,
        CGKeyCodes.f11: .f11,
        CGKeyCodes.f12: .f12,
        CGKeyCodes.f13: .f13,
        CGKeyCodes.f14: .f14,
        CGKeyCodes.f15: .f15,
        CGKeyCodes.f16: .f16,
        CGKeyCodes.f17: .f17,
        CGKeyCodes.f18: .f18,
        CGKeyCodes.f19: .f19
    ]
}
#endif
