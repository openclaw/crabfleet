//go:build linux

package main

import (
	"context"
	"errors"
	"fmt"
	"sync"

	"github.com/openclaw/crabfleet/internal/connect"
)

// wayvnc can silently switch to a surviving monitor after its selected output
// disappears. Fence that fallback before input/resize and on both sides of
// capture so replacement pixels are never accepted under the old screen ID.
type waylandOutputGuard struct {
	aggregate       bool
	inputMu         sync.Mutex
	pointer         connect.PointerEvent
	keys            map[uint32]bool
	backend         connect.Backend
	output, control string
	stop            context.CancelFunc
	mu              sync.Mutex
	err             error
}

func (g *waylandOutputGuard) failure() error {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.err
}

func (g *waylandOutputGuard) fail(err error) error {
	g.mu.Lock()
	if g.err == nil {
		g.err = err
	}
	result := g.err
	g.mu.Unlock()
	if g.stop != nil {
		g.stop()
	}
	return result
}

func (g *waylandOutputGuard) check(ctx context.Context) error {
	if err := g.failure(); err != nil {
		return err
	}
	outputs, err := readWaylandOutputs(ctx, g.control, g.aggregate)
	if err != nil {
		// Verification failure withholds this operation. Only a confirmed output
		// change revokes the shared binding; callers can cancel independently.
		return fmt.Errorf("verify Wayland output %q: %w", g.output, err)
	}
	matched := false
	for _, output := range outputs {
		if !output.Captured {
			continue
		}
		if output.Name != g.output {
			return g.fail(fmt.Errorf("Wayland helper changed selected output %q to %q; restart sharing to select the new layout", g.output, output.Name))
		}
		matched = true
	}
	if !matched {
		return g.fail(fmt.Errorf("Wayland helper no longer captures selected output %q; restart sharing to select the new layout", g.output))
	}
	return g.failure()
}

func (g *waylandOutputGuard) Capture(ctx context.Context) (connect.Frame, error) {
	if err := g.check(ctx); err != nil {
		return connect.Frame{}, err
	}
	frame, err := g.backend.Capture(ctx)
	if err != nil {
		return connect.Frame{}, err
	}
	if err := g.check(ctx); err != nil {
		return connect.Frame{}, err
	}
	return frame, nil
}

func (g *waylandOutputGuard) Pointer(ctx context.Context, event connect.PointerEvent) error {
	g.inputMu.Lock()
	defer g.inputMu.Unlock()
	if err := g.check(ctx); err != nil {
		if g.failure() == nil || event.ButtonMask != 0 || g.pointer.ButtonMask == 0 {
			return err
		}
		// Cleanup may release an existing press after identity was revoked, but
		// never move to a new position or create a press on the replacement output.
		event = g.pointer
		event.ButtonMask = 0
	}
	if err := g.backend.Pointer(ctx, event); err != nil {
		return err
	}
	g.pointer = event
	return nil
}

func (g *waylandOutputGuard) Key(ctx context.Context, event connect.KeyEvent) error {
	g.inputMu.Lock()
	defer g.inputMu.Unlock()
	if err := g.check(ctx); err != nil {
		if g.failure() == nil || event.Down || !g.keys[event.Keysym] {
			return err
		}
	}
	if event.Down && !g.keys[event.Keysym] && len(g.keys) >= 256 {
		return errors.New("too many held Wayland keys")
	}
	if err := g.backend.Key(ctx, event); err != nil {
		return err
	}
	if event.Down {
		if g.keys == nil {
			g.keys = make(map[uint32]bool)
		}
		g.keys[event.Keysym] = true
	} else {
		delete(g.keys, event.Keysym)
	}
	return nil
}

func (g *waylandOutputGuard) DesktopResizeSupported() bool {
	if g.failure() != nil {
		return false
	}
	resizer, ok := g.backend.(connect.DesktopResizer)
	return ok && resizer.DesktopResizeSupported()
}

func (g *waylandOutputGuard) ResizeDesktop(ctx context.Context, layout connect.DesktopLayout) error {
	if err := g.check(ctx); err != nil {
		return err
	}
	resizer, ok := g.backend.(connect.DesktopResizer)
	if !ok {
		return connect.ErrResizeUnsupported
	}
	if err := resizer.ResizeDesktop(ctx, layout); err != nil {
		return err
	}
	return g.check(ctx)
}

func (g *waylandOutputGuard) Close() error { return g.backend.Close() }
