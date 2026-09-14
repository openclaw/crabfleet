//go:build linux

package main

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"sync/atomic"

	"github.com/openclaw/crabfleet/internal/connect"
)

// Each private upstream maps absolute pointer coordinates into its own output.
// Output-list has no desktop positions, so the public layout is a stable row.
type waylandDesktop struct {
	backends      []connect.Backend
	allowResize   bool
	mu            sync.Mutex
	screens       []connect.Screen
	nativeScreens []connect.Screen
	sequence      uint64
	active        int
	pointer       connect.PointerEvent
	closed        atomic.Bool
	once          sync.Once
	closeErr      error
}

func newWaylandDesktop(backends []connect.Backend, allowResize bool) *waylandDesktop {
	return &waylandDesktop{backends: append([]connect.Backend(nil), backends...), allowResize: allowResize, active: -1}
}

func (d *waylandDesktop) Capture(ctx context.Context) (connect.Frame, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.closed.Load() {
		return connect.Frame{}, connect.ErrClosed
	}
	if len(d.backends) < 1 || len(d.backends) > 16 {
		return connect.Frame{}, errors.New("invalid Wayland output count")
	}
	frames := make([]connect.Frame, len(d.backends))
	screens := make([]connect.Screen, len(d.backends))
	nativeScreens := make([]connect.Screen, len(d.backends))
	width, height := 0, 0
	for i, backend := range d.backends {
		frame, err := backend.Capture(ctx)
		if err != nil {
			return connect.Frame{}, fmt.Errorf("capture Wayland output %d: %w", i+1, err)
		}
		if err := frame.Validate(); err != nil {
			return connect.Frame{}, err
		}
		frames[i] = frame
		local := frame.DesktopLayout()
		if len(local.Screens) != 1 {
			return connect.Frame{}, errors.New("Wayland helper must capture exactly one output")
		}
		nativeScreens[i] = local.Screens[0]
		screens[i] = connect.Screen{ID: uint32(i + 1), X: width, Width: frame.Width, Height: frame.Height}
		width += frame.Width
		height = max(height, frame.Height)
		if width > connect.MaxDimension || height > connect.MaxDimension || int64(width)*int64(height)*4 > connect.MaxFrameBytes {
			return connect.Frame{}, errors.New("combined Wayland desktop exceeds framebuffer limits")
		}
	}
	d.sequence++
	result := connect.Frame{Width: width, Height: height, Stride: width * 4, Pixels: make([]byte, width*height*4), Screens: screens, Sequence: d.sequence}
	for i, frame := range frames {
		for y := 0; y < frame.Height; y++ {
			offset := y*result.Stride + screens[i].X*4
			copy(result.Pixels[offset:offset+frame.Width*4], frame.Pixels[y*frame.Stride:y*frame.Stride+frame.Width*4])
		}
	}
	d.screens = append(d.screens[:0], screens...)
	d.nativeScreens = nativeScreens
	return result, nil
}

func (d *waylandDesktop) Pointer(ctx context.Context, event connect.PointerEvent) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.closed.Load() {
		return connect.ErrClosed
	}
	target := -1
	for i, screen := range d.screens {
		if int(event.X) >= screen.X && int(event.X) < screen.X+screen.Width && int(event.Y) >= screen.Y && int(event.Y) < screen.Y+screen.Height {
			target = i
			event.X -= uint16(screen.X)
			event.Y -= uint16(screen.Y)
			break
		}
	}
	// Release the previous helper's buttons before crossing outputs or entering
	// the empty area below a shorter monitor; no upstream retains a held button.
	if d.active >= 0 && target != d.active && d.pointer.ButtonMask != 0 {
		release := d.pointer
		release.ButtonMask = 0
		if err := d.backends[d.active].Pointer(ctx, release); err != nil {
			return err
		}
		d.pointer = release
	}
	if target < 0 {
		d.active = -1
		return nil
	}
	if err := d.backends[target].Pointer(ctx, event); err != nil {
		return err
	}
	d.active, d.pointer = target, event
	return nil
}

func (d *waylandDesktop) Key(ctx context.Context, event connect.KeyEvent) error {
	if d.closed.Load() {
		return connect.ErrClosed
	}
	// All helpers share the compositor seat. Keep keyboard ownership on one
	// upstream even when the pointer moves between outputs, including key-up.
	return d.backends[0].Key(ctx, event)
}

func (d *waylandDesktop) DesktopResizeSupported() bool {
	if !d.allowResize || d.closed.Load() {
		return false
	}
	for _, backend := range d.backends {
		resizer, ok := backend.(connect.DesktopResizer)
		if !ok || !resizer.DesktopResizeSupported() {
			return false
		}
	}
	return len(d.backends) != 0
}

func (d *waylandDesktop) ResizeDesktop(ctx context.Context, layout connect.DesktopLayout) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	if !d.allowResize {
		return connect.ErrResizeProhibited
	}
	if !d.DesktopResizeSupported() {
		return connect.ErrResizeUnsupported
	}
	if err := layout.Validate(); err != nil {
		return fmt.Errorf("%w: %v", connect.ErrResizeUnsupported, err)
	}
	if len(d.nativeScreens) != len(d.backends) {
		return fmt.Errorf("%w: Wayland outputs have not been captured", connect.ErrResizeUnsupported)
	}
	if len(layout.Screens) != len(d.backends) {
		return fmt.Errorf("%w: Wayland resize must preserve all selected outputs", connect.ErrResizeUnsupported)
	}
	width, height := 0, 0
	for i, screen := range layout.Screens {
		if screen.ID != uint32(i+1) || screen.X != width || screen.Y != 0 || screen.Flags != 0 {
			return fmt.Errorf("%w: Wayland resize must preserve output identities and side-by-side placement", connect.ErrResizeUnsupported)
		}
		width += screen.Width
		height = max(height, screen.Height)
	}
	if width != layout.Width || height != layout.Height {
		return fmt.Errorf("%w: Wayland resize bounds must match selected outputs", connect.ErrResizeUnsupported)
	}
	for i, screen := range layout.Screens {
		// Preserve each helper's negotiated screen identity.
		native := d.nativeScreens[i]
		if native.Width == screen.Width && native.Height == screen.Height {
			continue
		}
		native.Width, native.Height = screen.Width, screen.Height
		local := connect.DesktopLayout{Width: screen.Width, Height: screen.Height, Screens: []connect.Screen{native}}
		if err := d.backends[i].(connect.DesktopResizer).ResizeDesktop(ctx, local); err != nil {
			return fmt.Errorf("resize Wayland output %d: %w", i+1, err)
		}
		d.nativeScreens[i] = native
	}
	return nil
}

func (d *waylandDesktop) Close() error {
	d.once.Do(func() {
		d.closed.Store(true)
		for _, backend := range d.backends {
			d.closeErr = errors.Join(d.closeErr, backend.Close())
		}
	})
	return d.closeErr
}
