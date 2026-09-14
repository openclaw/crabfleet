//go:build linux

package connect

import (
	"context"
	"fmt"
	"testing"

	"github.com/jezek/xgb"
	"github.com/jezek/xgb/xproto"
	"github.com/jezek/xgb/xtest"
)

func TestX11LiveModifierOwnership(t *testing.T) {
	for _, mode := range []string{"release", "close", "unowned"} {
		t.Run(mode, func(t *testing.T) {
			backend := startX11GeometryFixture(t)
			observer, err := xgb.NewConnDisplay(fmt.Sprintf(":%d", backend.connection.DisplayNumber))
			if err != nil {
				t.Fatal(err)
			}
			defer observer.Close()
			if err := xtest.Init(observer); err != nil {
				t.Fatal(err)
			}
			shift := backend.keymap.preferredShift
			if shift == 0 || !backend.keymap.bindings['A'].shift {
				t.Fatal("private Xvfb did not provide a shifted A binding")
			}
			assertShift := func(want bool) {
				t.Helper()
				keys, err := xproto.QueryKeymap(observer).Reply()
				if err != nil || keys == nil {
					t.Fatalf("query private keyboard: %v", err)
				}
				if down := keys.Keys[int(shift)/8]&(1<<uint(shift%8)) != 0; down != want {
					t.Fatalf("Shift down=%v, want %v", down, want)
				}
			}
			if mode == "unowned" {
				// A second client holds a key the backend must not take ownership of.
				if err := xtest.FakeInputChecked(observer, xproto.KeyPress, shift, 0, 0, 0, 0, 0).Check(); err != nil {
					t.Fatal(err)
				}
				defer func() { _ = xtest.FakeInputChecked(observer, xproto.KeyRelease, shift, 0, 0, 0, 0, 0).Check() }()
				if err := backend.Key(context.Background(), KeyEvent{Down: true, Keysym: 'a'}); err == nil {
					t.Fatal("accepted a key while an unowned modifier was active")
				}
			} else {
				if err := backend.Key(context.Background(), KeyEvent{Down: true, Keysym: 'A'}); err != nil {
					t.Fatal(err)
				}
				backend.connection.Sync()
				assertShift(true)
				if mode == "release" {
					if err := backend.Key(context.Background(), KeyEvent{Keysym: 'A'}); err != nil {
						t.Fatal(err)
					}
					backend.connection.Sync()
					assertShift(false)
				}
			}
			if err := backend.Close(); err != nil {
				t.Fatal(err)
			}
			assertShift(mode == "unowned")
		})
	}
}
