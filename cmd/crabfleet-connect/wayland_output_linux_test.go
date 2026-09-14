//go:build linux

package main

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/openclaw/crabfleet/internal/connect"
)

func outputIdentitySocket(t *testing.T, switched *atomic.Bool) string {
	t.Helper()
	socket := filepath.Join(t.TempDir(), "control.sock")
	listener, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	done := make(chan struct{})
	t.Cleanup(func() { _ = listener.Close(); <-done })
	go func() {
		defer close(done)
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			var request map[string]any
			_ = json.NewDecoder(conn).Decode(&request)
			changed := switched.Load()
			_ = json.NewEncoder(conn).Encode(struct {
				Code int             `json:"code"`
				ID   int             `json:"id"`
				Data []waylandOutput `json:"data"`
			}{ID: 1, Data: []waylandOutput{{Name: "DP-1", Width: 3, Height: 2, Captured: !changed}, {Name: "DP-2", Width: 2, Height: 1, Captured: changed}}})
			_ = conn.Close()
		}
	}()
	return socket
}

type outputSwitchCapture struct {
	*waylandOutputFixture
	captures     int
	afterCapture func()
}

func (f *outputSwitchCapture) Capture(ctx context.Context) (connect.Frame, error) {
	f.captures++
	frame, err := f.waylandOutputFixture.Capture(ctx)
	if f.afterCapture != nil {
		f.afterCapture()
	}
	return frame, err
}

func TestWaylandOutputIdentityRevocationStopsCaptureInputAndResize(t *testing.T) {
	for _, operation := range []string{"capture", "pointer", "key", "resize"} {
		t.Run(operation, func(t *testing.T) {
			var switched atomic.Bool
			backend := &outputSwitchCapture{waylandOutputFixture: outputFixture(3, 2, 10, 11)}
			stopped, cancel := context.WithCancel(context.Background())
			defer cancel()
			guard := &waylandOutputGuard{backend: backend, output: "DP-1", control: outputIdentitySocket(t, &switched), stop: cancel}
			if _, err := guard.Capture(context.Background()); err != nil {
				t.Fatal(err)
			}
			switched.Store(true)
			var err error
			switch operation {
			case "capture":
				_, err = guard.Capture(context.Background())
			case "pointer":
				err = guard.Pointer(context.Background(), connect.PointerEvent{ButtonMask: 1})
			case "key":
				err = guard.Key(context.Background(), connect.KeyEvent{Down: true, Keysym: 65})
			case "resize":
				err = guard.ResizeDesktop(context.Background(), backend.frame.DesktopLayout())
			}
			if err == nil || !strings.Contains(err.Error(), "changed selected output") {
				t.Fatalf("replacement output accepted: %v", err)
			}
			if stopped.Err() == nil {
				t.Fatal("identity change did not stop share")
			}
			if backend.captures != 1 || len(backend.pointers) != 0 || len(backend.keys) != 0 || len(backend.resized) != 0 {
				t.Fatal("operation reached replacement output")
			}
			switched.Store(false)
			if _, err := guard.Capture(context.Background()); err == nil {
				t.Fatal("revoked binding silently became valid again")
			}
			if guard.DesktopResizeSupported() {
				t.Fatal("revoked output advertised resize")
			}
		})
	}
}

func TestWaylandOutputSwitchDuringCaptureDiscardsReplacementFrame(t *testing.T) {
	var switched atomic.Bool
	backend := &outputSwitchCapture{waylandOutputFixture: outputFixture(3, 2, 10, 11), afterCapture: func() { switched.Store(true) }}
	stopped, cancel := context.WithCancel(context.Background())
	defer cancel()
	guard := &waylandOutputGuard{backend: backend, output: "DP-1", control: outputIdentitySocket(t, &switched), stop: cancel}
	frame, err := guard.Capture(context.Background())
	if err == nil || len(frame.Pixels) != 0 || backend.captures != 1 || stopped.Err() == nil {
		t.Fatalf("accepted frame spanning output switch: frame=%+v, error=%v", frame, err)
	}
}

func TestWaylandRevokedOutputAllowsOnlyHeldInputReleaseAndClose(t *testing.T) {
	var switched atomic.Bool
	backend := outputFixture(3, 2, 10, 11)
	guard := &waylandOutputGuard{backend: backend, output: "DP-1", control: outputIdentitySocket(t, &switched)}
	ctx := context.Background()
	if err := guard.Pointer(ctx, connect.PointerEvent{ButtonMask: 1, X: 2, Y: 1}); err != nil {
		t.Fatal(err)
	}
	if err := guard.Key(ctx, connect.KeyEvent{Down: true, Keysym: 65}); err != nil {
		t.Fatal(err)
	}
	switched.Store(true)
	if _, err := guard.Capture(ctx); err == nil {
		t.Fatal("identity change was not fenced")
	}
	if err := guard.Pointer(ctx, connect.PointerEvent{X: 88, Y: 99}); err != nil {
		t.Fatalf("held pointer cleanup failed: %v", err)
	}
	if err := guard.Key(ctx, connect.KeyEvent{Keysym: 65}); err != nil {
		t.Fatalf("held key cleanup failed: %v", err)
	}
	if len(backend.pointers) != 2 || backend.pointers[1] != (connect.PointerEvent{X: 2, Y: 1}) || len(backend.keys) != 2 || backend.keys[1].Down {
		t.Fatal("release cleanup moved pointer or kept input held")
	}
	if err := guard.Pointer(ctx, connect.PointerEvent{X: 1}); err == nil {
		t.Fatal("revoked output accepted pointer motion")
	}
	if err := guard.Key(ctx, connect.KeyEvent{Keysym: 66}); err == nil {
		t.Fatal("revoked output accepted unrelated key event")
	}
	if err := guard.Close(); err != nil || backend.closeCount != 1 {
		t.Fatal("revocation blocked upstream close")
	}
}

func TestWaylandCanceledVerificationDoesNotRevokeSharedOutput(t *testing.T) {
	for _, operation := range []string{"capture", "pointer", "key", "resize"} {
		t.Run(operation, func(t *testing.T) {
			var switched atomic.Bool
			backend := &outputSwitchCapture{waylandOutputFixture: outputFixture(3, 2, 10, 11)}
			shared, stop := context.WithCancel(context.Background())
			defer stop()
			guard := &waylandOutputGuard{backend: backend, output: "DP-1", control: outputIdentitySocket(t, &switched), stop: stop}
			ctx, cancel := context.WithCancel(context.Background())
			cancel()
			var err error
			switch operation {
			case "capture":
				_, err = guard.Capture(ctx)
			case "pointer":
				err = guard.Pointer(ctx, connect.PointerEvent{ButtonMask: 1})
			case "key":
				err = guard.Key(ctx, connect.KeyEvent{Down: true, Keysym: 65})
			case "resize":
				err = guard.ResizeDesktop(ctx, backend.frame.DesktopLayout())
			}
			if !errors.Is(err, context.Canceled) {
				t.Fatalf("canceled verification: %v", err)
			}
			if shared.Err() != nil || guard.failure() != nil {
				t.Fatal("one canceled caller revoked the shared output")
			}
			if backend.captures != 0 || len(backend.keys) != 0 || len(backend.pointers) != 0 || len(backend.resized) != 0 {
				t.Fatal("unverified operation reached backend")
			}
			if _, err := guard.Capture(context.Background()); err != nil {
				t.Fatalf("subsequent viewer cannot capture: %v", err)
			}
		})
	}
}
