package connect

import (
	"errors"
	"unicode"
)

const (
	x11KeysymModeSwitch     = 0xff7e
	x11KeysymNumLock        = 0xff7f
	x11KeysymCapsLock       = 0xffe5
	x11KeysymShiftLock      = 0xffe6
	x11KeysymISOLevel3Shift = 0xfe03
)

type x11KeyBinding struct {
	keycode        byte
	shift          bool
	mode           bool
	lockSensitive  bool
	shiftSensitive bool
	keypad         bool
}

type x11LockMode byte

const (
	x11LockNone x11LockMode = iota
	x11LockCaps
	x11LockShift
)

type x11ModifierMap [8][]byte

type x11Keymap struct {
	bindings       map[uint32]x11KeyBinding
	modifierKeys   map[byte]struct{}
	modifierMasks  map[byte]uint16
	shiftKeycodes  map[byte]struct{}
	modeKeycodes   map[byte]struct{}
	preferredShift byte
	preferredMode  byte
	modeMask       uint16
	numLockMask    uint16
	lockMode       x11LockMode
}

func buildX11Keymap(
	keysyms []uint32,
	minimum byte,
	count, perKeycode int,
	modifiers x11ModifierMap,
) (x11Keymap, error) {
	if count < 1 || perKeycode < 1 || len(keysyms) != count*perKeycode {
		return x11Keymap{}, errors.New("invalid X11 keymap dimensions")
	}
	result := x11Keymap{
		bindings:      make(map[uint32]x11KeyBinding),
		modifierKeys:  make(map[byte]struct{}),
		modifierMasks: make(map[byte]uint16),
		shiftKeycodes: make(map[byte]struct{}),
		modeKeycodes:  make(map[byte]struct{}),
	}
	symbolsByKeycode := make(map[byte][]uint32, count)
	for keyOffset := 0; keyOffset < count; keyOffset++ {
		keycode := byte(int(minimum) + keyOffset)
		rawLevels := keysyms[keyOffset*perKeycode : (keyOffset+1)*perKeycode]
		levels := normalizedX11Levels(rawLevels)
		if !x11GroupsEquivalent(rawLevels) {
			// Extra XKB keyboard groups (secondary layouts) cannot be
			// disambiguated from AltGr levels through the core protocol, so bind
			// only the primary group's base and shift levels. Standard typing
			// and — critically — screen capture keep working instead of the
			// whole backend falling back to the synthetic test pattern.
			// (Active-group-aware XKB mapping is a follow-up.)
			primary := normalizedX11Levels(rawLevels[:2])
			levels = []uint32{primary[0], primary[1], primary[0], primary[1]}
		}
		symbolsByKeycode[keycode] = levels
		for level, keysym := range levels[:2] {
			if keysym == 0 {
				continue
			}
			pair := level &^ 1
			binding := x11KeyBinding{
				keycode:        keycode,
				shift:          level%2 == 1,
				mode:           level >= 2,
				lockSensitive:  isX11CasePair(levels[pair], levels[pair+1]),
				shiftSensitive: levels[pair] != levels[pair+1],
				keypad:         isX11Keypad(keysym),
			}
			previous, exists := result.bindings[keysym]
			if !exists || bindingCost(binding) < bindingCost(previous) {
				result.bindings[keysym] = binding
			}
		}
	}
	for _, keycodes := range modifiers {
		for _, keycode := range keycodes {
			if keycode != 0 {
				result.modifierKeys[keycode] = struct{}{}
			}
		}
	}
	for modifier, keycodes := range modifiers {
		for _, keycode := range keycodes {
			if keycode != 0 {
				result.modifierMasks[keycode] |= 1 << modifier
			}
		}
	}
	for _, keycode := range modifiers[0] {
		if keycode == 0 {
			continue
		}
		result.shiftKeycodes[keycode] = struct{}{}
		if result.preferredShift == 0 {
			result.preferredShift = keycode
		}
	}
	for _, keycode := range modifiers[1] {
		for _, keysym := range symbolsByKeycode[keycode] {
			switch keysym {
			case x11KeysymShiftLock:
				if result.lockMode == x11LockNone {
					result.lockMode = x11LockShift
				}
			case x11KeysymCapsLock:
				result.lockMode = x11LockCaps
			}
		}
	}
	for modifier := 3; modifier < len(modifiers); modifier++ {
		var modeKeycode byte
		for _, keycode := range modifiers[modifier] {
			if keycode != 0 && containsX11Keysym(symbolsByKeycode[keycode], x11KeysymModeSwitch, x11KeysymISOLevel3Shift) {
				modeKeycode = keycode
				break
			}
		}
		if modeKeycode != 0 {
			for _, keycode := range modifiers[modifier] {
				if keycode != 0 {
					result.modeKeycodes[keycode] = struct{}{}
				}
			}
			result.modeMask |= 1 << modifier
			if result.preferredMode == 0 {
				result.preferredMode = modeKeycode
			}
		}
		for _, keycode := range modifiers[modifier] {
			if containsX11Keysym(symbolsByKeycode[keycode], x11KeysymNumLock) {
				result.numLockMask |= 1 << modifier
				break
			}
		}
	}
	for keysym, binding := range result.bindings {
		_, modifier := result.modifierKeys[binding.keycode]
		if (binding.shift && result.preferredShift == 0) || (binding.mode && result.preferredMode == 0) ||
			(modifier && (binding.shift || binding.mode)) {
			delete(result.bindings, keysym)
		}
	}
	return result, nil
}

func normalizedX11Levels(raw []uint32) []uint32 {
	levels := make([]uint32, 4)
	copy(levels, raw)
	levels[0], levels[1] = normalizedX11Pair(levels[:2])
	levels[2], levels[3] = normalizedX11Pair(levels[2:])
	if levels[2] == 0 && levels[3] == 0 {
		levels[2], levels[3] = levels[0], levels[1]
	}
	return levels
}

func x11GroupsEquivalent(raw []uint32) bool {
	baseLower, baseUpper := normalizedX11Pair(raw)
	for offset := 2; offset < len(raw); offset += 2 {
		end := min(offset+2, len(raw))
		lower, upper := normalizedX11Pair(raw[offset:end])
		if lower == 0 && upper == 0 {
			continue
		}
		if lower != baseLower || upper != baseUpper {
			return false
		}
	}
	return true
}

func normalizedX11Pair(raw []uint32) (uint32, uint32) {
	if len(raw) == 0 {
		return 0, 0
	}
	if raw[0] == 0 {
		if len(raw) > 1 {
			return 0, raw[1]
		}
		return 0, 0
	}
	if len(raw) < 2 || raw[1] == 0 {
		return x11ConvertCase(raw[0])
	}
	return raw[0], raw[1]
}

// x11ConvertCase mirrors Xlib XConvertCase for the legacy sets it supports and
// uses Go's Unicode tables for Latin-1 and UCS keysyms.
func x11ConvertCase(keysym uint32) (uint32, uint32) {
	if keysym < 0x100 {
		switch keysym {
		case 0xff:
			return keysym, 0x13be
		case 0xb5:
			return keysym, 0x07cc
		case 0xdf:
			return keysym, 0x01001e9e
		}
		return uint32(unicode.ToLower(rune(keysym))), uint32(unicode.ToUpper(rune(keysym)))
	}
	if keysym&0xff000000 == 0x01000000 {
		value := rune(keysym & 0x00ffffff)
		if value > unicode.MaxRune {
			return keysym, keysym
		}
		lower, upper := uint32(unicode.ToLower(value)), uint32(unicode.ToUpper(value))
		if lower >= 0x100 {
			lower |= 0x01000000
		}
		if upper >= 0x100 {
			upper |= 0x01000000
		}
		return lower, upper
	}
	lower, upper := keysym, keysym
	switch keysym >> 8 {
	case 1:
		switch {
		case keysym == 0x01a1:
			lower = 0x01b1
		case keysym >= 0x01a3 && keysym <= 0x01a6, keysym >= 0x01a9 && keysym <= 0x01ac,
			keysym >= 0x01ae && keysym <= 0x01af:
			lower += 0x10
		case keysym == 0x01b1:
			upper = 0x01a1
		case keysym >= 0x01b3 && keysym <= 0x01b6, keysym >= 0x01b9 && keysym <= 0x01bc,
			keysym >= 0x01be && keysym <= 0x01bf:
			upper -= 0x10
		case keysym >= 0x01c0 && keysym <= 0x01de:
			lower += 0x20
		case keysym >= 0x01e0 && keysym <= 0x01fe:
			upper -= 0x20
		}
	case 2:
		switch {
		case keysym >= 0x02a1 && keysym <= 0x02a6, keysym >= 0x02ab && keysym <= 0x02ac:
			lower += 0x10
		case keysym >= 0x02b1 && keysym <= 0x02b6, keysym >= 0x02bb && keysym <= 0x02bc:
			upper -= 0x10
		case keysym >= 0x02c5 && keysym <= 0x02de:
			lower += 0x20
		case keysym >= 0x02e5 && keysym <= 0x02fe:
			upper -= 0x20
		}
	case 3:
		switch {
		case keysym >= 0x03a3 && keysym <= 0x03ac:
			lower += 0x10
		case keysym >= 0x03b3 && keysym <= 0x03bc:
			upper -= 0x10
		case keysym == 0x03bd:
			lower = 0x03bf
		case keysym == 0x03bf:
			upper = 0x03bd
		case keysym >= 0x03c0 && keysym <= 0x03de:
			lower += 0x20
		case keysym >= 0x03e0 && keysym <= 0x03fe:
			upper -= 0x20
		}
	case 6:
		switch {
		case keysym >= 0x06b1 && keysym <= 0x06bf:
			lower -= 0x10
		case keysym >= 0x06a1 && keysym <= 0x06af:
			upper += 0x10
		case keysym >= 0x06e0 && keysym <= 0x06ff:
			lower -= 0x20
		case keysym >= 0x06c0 && keysym <= 0x06df:
			upper += 0x20
		}
	case 7:
		switch {
		case keysym >= 0x07a1 && keysym <= 0x07ab:
			lower += 0x10
		case keysym >= 0x07b1 && keysym <= 0x07bb && keysym != 0x07b6 && keysym != 0x07ba:
			upper -= 0x10
		case keysym >= 0x07c1 && keysym <= 0x07d9:
			lower += 0x20
		case keysym == 0x07f3:
			upper = 0x07d2
		case keysym >= 0x07e1 && keysym <= 0x07f9:
			upper -= 0x20
		}
	case 0x13:
		switch keysym {
		case 0x13bc:
			lower = 0x13bd
		case 0x13bd:
			upper = 0x13bc
		case 0x13be:
			lower = 0xff
		}
	}
	return lower, upper
}

func isX11CasePair(lower, upper uint32) bool {
	if lower == 0 || upper == 0 || lower == upper {
		return false
	}
	convertedLower, convertedUpper := x11ConvertCase(lower)
	return convertedLower == lower && convertedUpper == upper
}

func containsX11Keysym(keysyms []uint32, wanted ...uint32) bool {
	for _, keysym := range keysyms {
		for _, candidate := range wanted {
			if keysym == candidate {
				return true
			}
		}
	}
	return false
}

func isX11Keypad(keysym uint32) bool {
	return keysym >= 0xff80 && keysym <= 0xffbd
}

func requiredX11PhysicalShift(
	binding x11KeyBinding,
	lockActive bool,
	lockMode x11LockMode,
	numLockActive bool,
) bool {
	lockShifts := lockMode == x11LockShift || (lockMode == x11LockCaps && binding.lockSensitive)
	return binding.shift != (lockActive && lockShifts) !=
		(binding.keypad && binding.shiftSensitive && numLockActive)
}

func bindingCost(binding x11KeyBinding) int {
	cost := 0
	if binding.shift {
		cost++
	}
	if binding.mode {
		cost += 2
	}
	return cost
}
