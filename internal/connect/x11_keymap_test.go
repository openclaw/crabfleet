package connect

import "testing"

func TestBuildX11KeymapPreservesRequiredLevels(t *testing.T) {
	t.Parallel()
	var modifiers x11ModifierMap
	modifiers[0] = []byte{50}
	modifiers[4] = []byte{54}
	modifiers[5] = []byte{51, 53}
	keymap, err := buildX11Keymap([]uint32{
		0xffe1, 0, 0, 0,
		x11KeysymModeSwitch, 0, 0, 0,
		'a', 'A', 'a', 'A',
		0xffe9, 0, 0, 0,
		x11KeysymNumLock, 0, 0, 0,
	}, 50, 5, 4, modifiers)
	if err != nil {
		t.Fatal(err)
	}
	checks := map[uint32]x11KeyBinding{
		'a': {keycode: 52, lockSensitive: true, shiftSensitive: true},
		'A': {keycode: 52, shift: true, lockSensitive: true, shiftSensitive: true},
	}
	for keysym, expected := range checks {
		if actual := keymap.bindings[keysym]; actual != expected {
			t.Fatalf("keysym %#x binding = %+v, want %+v", keysym, actual, expected)
		}
	}
	if keymap.preferredShift != 50 || keymap.preferredMode != 51 || keymap.modeMask != 1<<5 || keymap.numLockMask != 1<<4 {
		t.Fatalf("modifier keycodes = %d/%d", keymap.preferredShift, keymap.preferredMode)
	}
	if _, exists := keymap.modeKeycodes[53]; !exists {
		t.Fatal("did not include another keycode sharing the mode modifier slot")
	}
}

func TestBuildX11KeymapBindsPrimaryGroupIgnoringSecondary(t *testing.T) {
	t.Parallel()
	// A second XKB group (Arabic here) must not disable the keymap; the primary
	// group's base and shift bind, and the secondary group's keysyms are ignored.
	keymap, err := buildX11Keymap([]uint32{'a', 'A', 0x06c1, 0x06e1}, 20, 1, 4, x11ModifierMap{})
	if err != nil {
		t.Fatalf("multi-group keymap must build: %v", err)
	}
	if b, ok := keymap.bindings['a']; !ok || b.keycode != 20 || b.shift {
		t.Fatalf("primary base binding missing/wrong: %+v ok=%v", b, ok)
	}
	if _, ok := keymap.bindings[0x06c1]; ok {
		t.Fatal("secondary-group keysym must not be bound")
	}
}

func TestBuildX11KeymapIgnoresDifferingThirdGroup(t *testing.T) {
	t.Parallel()
	keymap, err := buildX11Keymap(
		[]uint32{'a', 'A', 'a', 'A', 0x06c1, 0x06e1},
		20, 1, 6, x11ModifierMap{},
	)
	if err != nil {
		t.Fatalf("keymap with a differing third group must build: %v", err)
	}
	if _, ok := keymap.bindings['a']; !ok {
		t.Fatal("primary base binding missing")
	}
	if _, ok := keymap.bindings[0x06c1]; ok {
		t.Fatal("differing third-group keysym must not be bound")
	}
}

func TestBuildX11KeymapDropsUnreachableLevels(t *testing.T) {
	t.Parallel()
	keymap, err := buildX11Keymap([]uint32{'a', 'A', 'a', 'A'}, 20, 1, 4, x11ModifierMap{})
	if err != nil {
		t.Fatal(err)
	}
	if _, exists := keymap.bindings['A']; exists {
		t.Fatal("retained shifted binding without a Shift key")
	}
}

func TestBuildX11KeymapExpandsImplicitCaseAndGroupLevels(t *testing.T) {
	t.Parallel()
	var modifiers x11ModifierMap
	modifiers[0] = []byte{10}
	keymap, err := buildX11Keymap([]uint32{0xffe1, 0, 'a', 0}, 10, 2, 2, modifiers)
	if err != nil {
		t.Fatal(err)
	}
	binding, exists := keymap.bindings['A']
	if !exists || binding.keycode != 11 || !binding.shift || !binding.lockSensitive || !binding.shiftSensitive {
		t.Fatalf("implicit uppercase binding = %+v, exists=%v", binding, exists)
	}
}

func TestBuildX11KeymapUsesActualModifierMembership(t *testing.T) {
	t.Parallel()
	var modifiers x11ModifierMap
	modifiers[0] = []byte{99}
	keymap, err := buildX11Keymap([]uint32{0xffe1, 0, 'a', 'A'}, 10, 2, 2, modifiers)
	if err != nil {
		t.Fatal(err)
	}
	if keymap.preferredShift != 99 {
		t.Fatalf("preferred Shift = %d", keymap.preferredShift)
	}
}

func TestBuildX11KeymapCapsLockWinsOverShiftLock(t *testing.T) {
	t.Parallel()
	var modifiers x11ModifierMap
	modifiers[0] = []byte{10}
	modifiers[1] = []byte{11, 12}
	keymap, err := buildX11Keymap([]uint32{
		0xffe1, 0,
		x11KeysymShiftLock, 0,
		x11KeysymCapsLock, 0,
	}, 10, 3, 2, modifiers)
	if err != nil {
		t.Fatal(err)
	}
	if keymap.lockMode != x11LockCaps {
		t.Fatalf("lock mode = %d", keymap.lockMode)
	}
}

func TestBuildX11KeymapPreservesShiftedOnlyPair(t *testing.T) {
	t.Parallel()
	var modifiers x11ModifierMap
	modifiers[0] = []byte{10}
	keymap, err := buildX11Keymap([]uint32{0xffe1, 0, 0, '@'}, 10, 2, 2, modifiers)
	if err != nil {
		t.Fatal(err)
	}
	binding, exists := keymap.bindings['@']
	if !exists || binding.keycode != 11 || !binding.shift {
		t.Fatalf("shifted-only binding = %+v, exists=%v", binding, exists)
	}
}

func TestRequiredX11PhysicalShiftAccountsForLocks(t *testing.T) {
	t.Parallel()
	lower := x11KeyBinding{lockSensitive: true}
	upper := x11KeyBinding{shift: true, lockSensitive: true}
	digit := x11KeyBinding{}
	if !requiredX11PhysicalShift(lower, true, x11LockCaps, false) {
		t.Fatal("Caps Lock lowercase did not require physical Shift")
	}
	if requiredX11PhysicalShift(upper, true, x11LockCaps, false) {
		t.Fatal("Caps Lock uppercase unnecessarily required physical Shift")
	}
	if requiredX11PhysicalShift(digit, true, x11LockCaps, false) {
		t.Fatal("Caps Lock changed a non-alphabetic key")
	}
	if !requiredX11PhysicalShift(digit, true, x11LockShift, false) {
		t.Fatal("Shift Lock did not affect a non-alphabetic key")
	}
}

func TestRequiredX11PhysicalShiftAccountsForNumLock(t *testing.T) {
	t.Parallel()
	keypadLower := x11KeyBinding{keypad: true, shiftSensitive: true}
	keypadUpper := x11KeyBinding{shift: true, keypad: true, shiftSensitive: true}
	if !requiredX11PhysicalShift(keypadLower, false, x11LockNone, true) {
		t.Fatal("Num Lock keypad base level did not require Shift reversal")
	}
	if requiredX11PhysicalShift(keypadUpper, false, x11LockNone, true) {
		t.Fatal("Num Lock keypad shifted level retained Shift")
	}
	if requiredX11PhysicalShift(x11KeyBinding{keypad: true}, false, x11LockNone, true) {
		t.Fatal("Num Lock altered a one-level keypad key")
	}
}

func TestBuildX11KeymapDropsShiftedModifierAlias(t *testing.T) {
	t.Parallel()
	var modifiers x11ModifierMap
	modifiers[3] = []byte{20}
	keymap, err := buildX11Keymap([]uint32{0xffe9, 0xffe7}, 20, 1, 2, modifiers)
	if err != nil {
		t.Fatal(err)
	}
	if _, exists := keymap.bindings[0xffe9]; !exists {
		t.Fatal("dropped base modifier binding")
	}
	if _, exists := keymap.bindings[0xffe7]; exists {
		t.Fatal("retained shifted modifier alias")
	}
}

func TestX11ConvertCaseSupportsLegacyAndUCSKeysyms(t *testing.T) {
	t.Parallel()
	checks := map[uint32][2]uint32{
		0x06c0:     {0x06c0, 0x06e0},
		0x07e1:     {0x07e1, 0x07c1},
		0x010003b1: {0x010003b1, 0x01000391},
	}
	for input, expected := range checks {
		lower, upper := x11ConvertCase(input)
		if lower != expected[0] || upper != expected[1] {
			t.Fatalf("case(%#x) = %#x/%#x, want %#x/%#x", input, lower, upper, expected[0], expected[1])
		}
	}
}
