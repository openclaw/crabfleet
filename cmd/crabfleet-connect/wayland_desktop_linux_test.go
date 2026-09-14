//go:build linux

package main

import (
	"context"
	"errors"
	"sync"
	"testing"

	"github.com/openclaw/crabfleet/internal/connect"
)

type waylandOutputFixture struct {
	frame           connect.Frame
	pointers        []connect.PointerEvent
	keys            []connect.KeyEvent
	resized         []connect.DesktopLayout
	closeCount      int
	resizeSupported bool
	resizeErr       error
}

func (f *waylandOutputFixture) Capture(context.Context) (connect.Frame, error) { return f.frame, nil }
func (f *waylandOutputFixture) Pointer(_ context.Context, event connect.PointerEvent) error {
	f.pointers = append(f.pointers, event)
	return nil
}
func (f *waylandOutputFixture) Key(_ context.Context, event connect.KeyEvent) error {
	f.keys = append(f.keys, event)
	return nil
}
func (f *waylandOutputFixture) Close() error                 { f.closeCount++; return nil }
func (f *waylandOutputFixture) DesktopResizeSupported() bool { return f.resizeSupported }
func (f *waylandOutputFixture) ResizeDesktop(_ context.Context, layout connect.DesktopLayout) error {
	f.resized = append(f.resized, layout)
	if f.resizeErr != nil {
		return f.resizeErr
	}
	f.frame = connect.Frame{Width: layout.Width, Height: layout.Height, Stride: layout.Width * 4, Pixels: make([]byte, layout.Width*layout.Height*4), Screens: layout.Screens}
	return nil
}
func outputFixture(width, height int, id uint32, color byte) *waylandOutputFixture {
	pixels := make([]byte, width*height*4)
	for i := range pixels {
		pixels[i] = color
	}
	return &waylandOutputFixture{frame: connect.Frame{Width: width, Height: height, Stride: width * 4, Pixels: pixels, Screens: []connect.Screen{{ID: id, Width: width, Height: height, Flags: 7}}}, resizeSupported: true}
}

func TestWaylandDesktopCombinesPixelsAndRoutesInput(t *testing.T) {
	a, b := outputFixture(3, 2, 10, 11), outputFixture(2, 1, 20, 22)
	d := newWaylandDesktop([]connect.Backend{a, b}, false)
	ctx := context.Background()
	frame, err := d.Capture(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if err := frame.Validate(); err != nil {
		t.Fatal(err)
	}
	if frame.Width != 5 || frame.Height != 2 || len(frame.Screens) != 2 || frame.Screens[1].X != 3 {
		t.Fatalf("bad combined frame: %+v", frame)
	}
	if frame.Pixels[0] != 11 || frame.Pixels[12] != 22 || frame.Pixels[32] != 0 {
		t.Fatalf("bad combined pixels: %v", frame.Pixels)
	}
	if err := d.Pointer(ctx, connect.PointerEvent{ButtonMask: 1, X: 2, Y: 1}); err != nil {
		t.Fatal(err)
	}
	if err := d.Pointer(ctx, connect.PointerEvent{ButtonMask: 1, X: 4, Y: 0}); err != nil {
		t.Fatal(err)
	}
	if len(a.pointers) != 2 || a.pointers[1].ButtonMask != 0 || len(b.pointers) != 1 || b.pointers[0].X != 1 {
		t.Fatalf("output crossing did not release/map: %v / %v", a.pointers, b.pointers)
	}
	if err := d.Pointer(ctx, connect.PointerEvent{X: 4, Y: 1}); err != nil {
		t.Fatal(err)
	}
	if len(b.pointers) != 2 || b.pointers[1].ButtonMask != 0 {
		t.Fatal("empty area retained held buttons")
	}
	for _, down := range []bool{true, false} {
		if err := d.Key(ctx, connect.KeyEvent{Down: down, Keysym: 65}); err != nil {
			t.Fatal(err)
		}
	}
	if len(a.keys) != 2 || len(b.keys) != 0 {
		t.Fatal("keyboard ownership changed with pointer")
	}
	var wg sync.WaitGroup
	for range 8 {
		wg.Go(func() { _ = d.Close() })
	}
	wg.Wait()
	if a.closeCount != 1 || b.closeCount != 1 {
		t.Fatal("close was not idempotent")
	}
	if _, err := d.Capture(ctx); !errors.Is(err, connect.ErrClosed) {
		t.Fatalf("capture after close: %v", err)
	}
}

func TestWaylandDesktopResizesActualOutputsAndPreservesNativeIDs(t *testing.T) {
	a, b := outputFixture(3, 2, 10, 11), outputFixture(2, 1, 20, 22)
	d := newWaylandDesktop([]connect.Backend{a, b}, true)
	ctx := context.Background()
	if _, err := d.Capture(ctx); err != nil {
		t.Fatal(err)
	}
	layout := connect.DesktopLayout{Width: 7, Height: 3, Screens: []connect.Screen{{ID: 1, Width: 4, Height: 3}, {ID: 2, X: 4, Width: 3, Height: 2}}}
	if !d.DesktopResizeSupported() {
		t.Fatal("supported outputs did not advertise resize")
	}
	if err := d.ResizeDesktop(ctx, layout); err != nil {
		t.Fatal(err)
	}
	if a.resized[0].Screens[0].ID != 10 || b.resized[0].Screens[0].ID != 20 || a.resized[0].Screens[0].Flags != 7 {
		t.Fatal("lost upstream screen metadata")
	}
	frame, err := d.Capture(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if !frame.DesktopLayout().Equal(layout) {
		t.Fatalf("actual output resize not captured: %+v", frame.DesktopLayout())
	}
	bad := layout
	bad.Screens = append([]connect.Screen(nil), layout.Screens...)
	bad.Screens[1].ID = 88
	if err := d.ResizeDesktop(ctx, bad); err == nil || len(a.resized) != 1 {
		t.Fatal("invalid layout changed an output")
	}
	d.allowResize = false
	if d.DesktopResizeSupported() {
		t.Fatal("resize advertised without opt-in")
	}
	if err := d.ResizeDesktop(ctx, layout); err == nil || len(a.resized) != 1 {
		t.Fatal("resize without opt-in changed an output")
	}
	d.allowResize = true
	b.resizeSupported = false
	if d.DesktopResizeSupported() {
		t.Fatal("resize advertised when one output cannot resize")
	}
	if err := d.ResizeDesktop(ctx, layout); err == nil || len(a.resized) != 1 {
		t.Fatal("unsupported resize changed first output")
	}
}

func TestWaylandDesktopBoundsAndPartialResizeFailure(t *testing.T) {
	ctx := context.Background()
	a, b := outputFixture(40000, 1, 0, 0), outputFixture(40000, 1, 0, 0)
	d := newWaylandDesktop([]connect.Backend{a, b}, true)
	if _, err := d.Capture(ctx); err == nil {
		t.Fatal("accepted combined width beyond protocol limits")
	}
	a, b = outputFixture(2, 2, 0, 0), outputFixture(2, 2, 0, 0)
	d = newWaylandDesktop([]connect.Backend{a, b}, true)
	if _, err := d.Capture(ctx); err != nil {
		t.Fatal(err)
	}
	b.resizeErr = errors.New("compositor rejected mode")
	layout := connect.DesktopLayout{Width: 6, Height: 3, Screens: []connect.Screen{{ID: 1, Width: 3, Height: 3}, {ID: 2, X: 3, Width: 3, Height: 3}}}
	if err := d.ResizeDesktop(ctx, layout); err == nil {
		t.Fatal("partial resize reported success")
	}
	actual, err := d.Capture(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if actual.Width != 5 || actual.Screens[1].Width != 2 {
		t.Fatal("partial failure hid actual output geometry")
	}
}
