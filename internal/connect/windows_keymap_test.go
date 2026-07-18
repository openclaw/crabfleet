package connect

import "testing"

func TestWindowsKeyBindingForKeysym(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name   string
		keysym uint32
		want   windowsKeyBinding
	}{
		{name: "left arrow", keysym: 0xff51, want: windowsKeyBinding{virtualKey: windowsVKLeft, extended: true}},
		{name: "right control", keysym: 0xffe4, want: windowsKeyBinding{virtualKey: windowsVKRControl, extended: true}},
		{name: "AltGr", keysym: 0xfe03, want: windowsKeyBinding{virtualKey: windowsVKRMenu, extended: true}},
		{name: "ISO left tab", keysym: 0xfe20, want: windowsKeyBinding{virtualKey: windowsVKTab, shift: true}},
		{name: "keypad begin", keysym: 0xff9d, want: windowsKeyBinding{virtualKey: windowsVKClear}},
		{name: "keypad seven", keysym: 0xffb7, want: windowsKeyBinding{virtualKey: windowsVKNumpad0 + 7}},
		{name: "F24", keysym: 0xffd5, want: windowsKeyBinding{virtualKey: windowsVKF1 + 23}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			got, ok := windowsKeyBindingForKeysym(test.keysym)
			if !ok || got != test.want {
				t.Fatalf("binding(%#x) = %+v, %v; want %+v, true", test.keysym, got, ok, test.want)
			}
		})
	}
}

func TestWindowsRuneForKeysym(t *testing.T) {
	t.Parallel()
	tests := []struct {
		keysym uint32
		want   rune
	}{
		{keysym: 'A', want: 'A'},
		{keysym: 0xe9, want: 'é'},
		{keysym: 0x03c0, want: 'Ā'},
		{keysym: 0x06c1, want: 'а'},
		{keysym: 0x0101f980, want: '🦀'},
	}
	for _, test := range tests {
		got, ok := windowsRuneForKeysym(test.keysym)
		if !ok || got != test.want {
			t.Fatalf("rune(%#x) = %q, %v; want %q, true", test.keysym, got, ok, test.want)
		}
	}
}

func TestWindowsRuneRejectsNonCharacterKeysyms(t *testing.T) {
	t.Parallel()
	for _, keysym := range []uint32{0x1f, 0xff51, 0x01110000, 0x0100d800} {
		if _, ok := windowsRuneForKeysym(keysym); ok {
			t.Fatalf("mapped non-character keysym %#x", keysym)
		}
	}
}
