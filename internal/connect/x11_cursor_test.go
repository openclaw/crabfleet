package connect

import "testing"

func TestCursorFromXFixesConvertsPremultipliedARGB(t *testing.T) {
	t.Parallel()
	cursor, err := cursorFromXFixes(20, 30, 2, 1, 1, 0, []uint32{0x80402010, 0xff112233}, 100, 100)
	if err != nil {
		t.Fatal(err)
	}
	if !cursor.Visible || cursor.HotspotX != 1 || cursor.X != 20 || cursor.Y != 30 {
		t.Fatalf("cursor geometry = %+v", cursor)
	}
	want := []byte{0x40, 0x20, 0x10, 0x80, 0x11, 0x22, 0x33, 0xff}
	if string(cursor.RGBA) != string(want) {
		t.Fatalf("RGBA = %x, want %x", cursor.RGBA, want)
	}
}

func TestCursorFromXFixesTreatsTransparentImageAsHidden(t *testing.T) {
	t.Parallel()
	cursor, err := cursorFromXFixes(0, 0, 1, 1, 0, 0, []uint32{0x00ffffff}, 1, 1)
	if err != nil {
		t.Fatal(err)
	}
	if cursor.Visible {
		t.Fatal("transparent cursor was visible")
	}
}

func TestCursorFromXFixesRejectsOversizedCursor(t *testing.T) {
	t.Parallel()
	if _, err := cursorFromXFixes(0, 0, 129, 1, 0, 0, make([]uint32, 129), 640, 480); err == nil {
		t.Fatal("accepted oversized XFixes cursor")
	}
}
