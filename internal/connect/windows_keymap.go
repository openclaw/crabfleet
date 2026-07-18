package connect

type windowsKeyBinding struct {
	virtualKey uint16
	shift      bool
	control    bool
	alt        bool
	extended   bool
}

const (
	windowsVKBack      = 0x08
	windowsVKTab       = 0x09
	windowsVKClear     = 0x0c
	windowsVKReturn    = 0x0d
	windowsVKShift     = 0x10
	windowsVKControl   = 0x11
	windowsVKMenu      = 0x12
	windowsVKPause     = 0x13
	windowsVKCapital   = 0x14
	windowsVKEscape    = 0x1b
	windowsVKSpace     = 0x20
	windowsVKPrior     = 0x21
	windowsVKNext      = 0x22
	windowsVKEnd       = 0x23
	windowsVKHome      = 0x24
	windowsVKLeft      = 0x25
	windowsVKUp        = 0x26
	windowsVKRight     = 0x27
	windowsVKDown      = 0x28
	windowsVKSnapshot  = 0x2c
	windowsVKInsert    = 0x2d
	windowsVKDelete    = 0x2e
	windowsVKLWin      = 0x5b
	windowsVKRWin      = 0x5c
	windowsVKApps      = 0x5d
	windowsVKNumpad0   = 0x60
	windowsVKMultiply  = 0x6a
	windowsVKAdd       = 0x6b
	windowsVKSeparator = 0x6c
	windowsVKSubtract  = 0x6d
	windowsVKDecimal   = 0x6e
	windowsVKDivide    = 0x6f
	windowsVKF1        = 0x70
	windowsVKNumLock   = 0x90
	windowsVKScroll    = 0x91
	windowsVKLShift    = 0xa0
	windowsVKRShift    = 0xa1
	windowsVKLControl  = 0xa2
	windowsVKRControl  = 0xa3
	windowsVKLMenu     = 0xa4
	windowsVKRMenu     = 0xa5
)

var windowsKeysymBindings = map[uint32]windowsKeyBinding{
	0xff08: {virtualKey: windowsVKBack},
	0xff09: {virtualKey: windowsVKTab},
	0xff0b: {virtualKey: windowsVKClear},
	0xff0d: {virtualKey: windowsVKReturn},
	0xff13: {virtualKey: windowsVKPause},
	0xff14: {virtualKey: windowsVKScroll},
	0xff1b: {virtualKey: windowsVKEscape},
	0xff50: {virtualKey: windowsVKHome, extended: true},
	0xff51: {virtualKey: windowsVKLeft, extended: true},
	0xff52: {virtualKey: windowsVKUp, extended: true},
	0xff53: {virtualKey: windowsVKRight, extended: true},
	0xff54: {virtualKey: windowsVKDown, extended: true},
	0xff55: {virtualKey: windowsVKPrior, extended: true},
	0xff56: {virtualKey: windowsVKNext, extended: true},
	0xff57: {virtualKey: windowsVKEnd, extended: true},
	0xff61: {virtualKey: windowsVKSnapshot, extended: true},
	0xff63: {virtualKey: windowsVKInsert, extended: true},
	0xff67: {virtualKey: windowsVKApps},
	0xff7e: {virtualKey: windowsVKRMenu, extended: true},
	0xff7f: {virtualKey: windowsVKNumLock, extended: true},
	0xff89: {virtualKey: windowsVKTab},
	0xff8d: {virtualKey: windowsVKReturn, extended: true},
	0xff95: {virtualKey: windowsVKHome},
	0xff96: {virtualKey: windowsVKLeft},
	0xff97: {virtualKey: windowsVKUp},
	0xff98: {virtualKey: windowsVKRight},
	0xff99: {virtualKey: windowsVKDown},
	0xff9a: {virtualKey: windowsVKPrior},
	0xff9b: {virtualKey: windowsVKNext},
	0xff9c: {virtualKey: windowsVKEnd},
	0xff9d: {virtualKey: windowsVKClear},
	0xff9e: {virtualKey: windowsVKInsert},
	0xff9f: {virtualKey: windowsVKDelete},
	0xffaa: {virtualKey: windowsVKMultiply},
	0xffab: {virtualKey: windowsVKAdd},
	0xffac: {virtualKey: windowsVKSeparator},
	0xffad: {virtualKey: windowsVKSubtract},
	0xffae: {virtualKey: windowsVKDecimal},
	0xffaf: {virtualKey: windowsVKDivide, extended: true},
	0xffe1: {virtualKey: windowsVKLShift},
	0xffe2: {virtualKey: windowsVKRShift},
	0xffe3: {virtualKey: windowsVKLControl},
	0xffe4: {virtualKey: windowsVKRControl, extended: true},
	0xffe5: {virtualKey: windowsVKCapital},
	0xffe7: {virtualKey: windowsVKLWin},
	0xffe8: {virtualKey: windowsVKRWin},
	0xffe9: {virtualKey: windowsVKLMenu},
	0xffea: {virtualKey: windowsVKRMenu, extended: true},
	0xffeb: {virtualKey: windowsVKLWin},
	0xffec: {virtualKey: windowsVKRWin},
	0xfe03: {virtualKey: windowsVKRMenu, extended: true},
	0xfe20: {virtualKey: windowsVKTab, shift: true},
	0xffff: {virtualKey: windowsVKDelete, extended: true},
}

func windowsKeyBindingForKeysym(keysym uint32) (windowsKeyBinding, bool) {
	if keysym >= 0xffb0 && keysym <= 0xffb9 {
		return windowsKeyBinding{virtualKey: windowsVKNumpad0 + uint16(keysym-0xffb0)}, true
	}
	if keysym >= 0xffbe && keysym <= 0xffd5 {
		return windowsKeyBinding{virtualKey: windowsVKF1 + uint16(keysym-0xffbe)}, true
	}
	if binding, ok := windowsKeysymBindings[keysym]; ok {
		return binding, true
	}
	return windowsKeyBinding{}, false
}

func windowsRuneForKeysym(keysym uint32) (rune, bool) {
	if (keysym >= 0x20 && keysym <= 0x7e) || (keysym >= 0xa0 && keysym <= 0xff) {
		return rune(keysym), true
	}
	if value, ok := windowsLegacyRuneForKeysym(keysym); ok {
		return value, true
	}
	if keysym&0xff000000 != 0x01000000 {
		return 0, false
	}
	value := rune(keysym & 0x00ffffff)
	if value < 0 || value > 0x10ffff || value >= 0xd800 && value <= 0xdfff {
		return 0, false
	}
	return value, true
}

func windowsVirtualKeyIsShift(virtualKey uint16) bool {
	return virtualKey == windowsVKShift || virtualKey == windowsVKLShift || virtualKey == windowsVKRShift
}

func windowsVirtualKeyIsShortcutModifier(virtualKey uint16) bool {
	switch virtualKey {
	case windowsVKControl, windowsVKLControl, windowsVKRControl,
		windowsVKMenu, windowsVKLMenu, windowsVKRMenu,
		windowsVKLWin, windowsVKRWin:
		return true
	default:
		return false
	}
}
