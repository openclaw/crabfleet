package rfbclient

import (
	"context"
	"net"
	"testing"
	"time"

	"github.com/openclaw/crabfleet/internal/connect"
	"github.com/openclaw/crabfleet/internal/rfb"
)

func TestCaptureAndInputThroughAuthenticatedHelper(t *testing.T) {
	t.Parallel()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	synthetic, err := connect.NewSynthetic(connect.SyntheticOptions{Width: 32, Height: 18})
	if err != nil {
		t.Fatal(err)
	}
	server, client := net.Pipe()
	defer server.Close()
	done := make(chan struct{})
	go func() {
		defer close(done)
		defer server.Close()
		_ = rfb.ServeConn(ctx, server, rfb.SessionConfig{Backend: synthetic, Password: "fixture1"})
	}()
	backend, err := New(ctx, client, "fixture1")
	if err != nil {
		t.Fatal(err)
	}
	defer backend.Close()
	frame, err := backend.Capture(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if err := frame.Validate(); err != nil {
		t.Fatal(err)
	}
	if frame.Width != 32 || frame.Height != 18 || frame.Pixels[3] != 255 {
		t.Fatalf("invalid frame: %dx%d", frame.Width, frame.Height)
	}
	if err := backend.Key(ctx, connect.KeyEvent{Keysym: 'a', Down: true}); err != nil {
		t.Fatal(err)
	}
	if err := backend.Pointer(ctx, connect.PointerEvent{X: 10, Y: 10, ButtonMask: 1}); err != nil {
		t.Fatal(err)
	}
	// A following capture is a wire barrier after both input messages.
	if _, err := backend.Capture(ctx); err != nil {
		t.Fatal(err)
	}
	events := synthetic.Events()
	if len(events) < 2 || events[0].Key == nil || events[0].Key.Keysym != 'a' || events[1].Pointer == nil || events[1].Pointer.X != 10 {
		t.Fatalf("input not forwarded: %#v", events)
	}
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("helper did not close")
	}
}

func TestHelperRejectsWrongPassword(t *testing.T) {
	t.Parallel()
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	synthetic, _ := connect.NewSynthetic(connect.SyntheticOptions{Width: 8, Height: 8})
	server, client := net.Pipe()
	defer server.Close()
	go func() {
		defer server.Close()
		_ = rfb.ServeConn(ctx, server, rfb.SessionConfig{Backend: synthetic, Password: "fixture1"})
	}()
	if backend, err := New(ctx, client, "fixture2"); err == nil {
		_ = backend.Close()
		t.Fatal("accepted incorrect password")
	}
}
