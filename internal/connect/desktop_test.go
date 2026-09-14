package connect

import "testing"

func TestDesktopLayoutBoundsAndScreenIdentity(t *testing.T) {
	valid := DesktopLayout{Width: 100, Height: 80, Screens: []Screen{{ID: 1, Width: 50, Height: 80}, {ID: 2, X: 50, Width: 50, Height: 80}}}
	if err := valid.Validate(); err != nil {
		t.Fatal(err)
	}
	cases := []DesktopLayout{
		{Width: 100, Height: 80},
		{Width: 100, Height: 80, Screens: make([]Screen, 17)},
		{Width: 65535, Height: 65535, Screens: []Screen{{Width: 1, Height: 1}}},
		{Width: 100, Height: 80, Screens: []Screen{{ID: 1, Width: 50, Height: 80}, {ID: 1, X: 50, Width: 50, Height: 80}}},
		{Width: 100, Height: 80, Screens: []Screen{{X: -1, Width: 50, Height: 80}}},
		{Width: 100, Height: 80, Screens: []Screen{{X: 99, Width: 2, Height: 80}}},
	}
	for _, layout := range cases {
		if layout.Validate() == nil {
			t.Fatalf("accepted invalid layout %+v", layout)
		}
	}
	frame := Frame{Width: 100, Height: 80, Screens: valid.Screens}
	copy := frame.DesktopLayout()
	copy.Screens[0].ID = 9
	if frame.Screens[0].ID != 1 {
		t.Fatal("layout aliases source frame")
	}
}
