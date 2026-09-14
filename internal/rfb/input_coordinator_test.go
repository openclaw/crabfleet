package rfb

import (
	"context"
	"errors"
	"testing"

	"github.com/openclaw/crabfleet/internal/connect"
)

func TestInputCoordinatorPreservesSessionOwnership(t *testing.T) {
	t.Parallel()
	backend, err := connect.NewSynthetic(connect.SyntheticOptions{Width: 16, Height: 16})
	if err != nil {
		t.Fatal(err)
	}
	coordinator := newInputCoordinator(backend, 2)
	first := coordinator.newSession()
	second := coordinator.newSession()
	ctx := context.Background()

	if err := first.Key(ctx, connect.KeyEvent{Down: true, Keysym: 65}); err != nil {
		t.Fatal(err)
	}
	if err := second.Key(ctx, connect.KeyEvent{Down: true, Keysym: 65}); err != nil {
		t.Fatal(err)
	}
	if err := second.Key(ctx, connect.KeyEvent{Keysym: 65}); err != nil {
		t.Fatal(err)
	}
	second.release(ctx)
	if len(backend.Events()) != 1 {
		t.Fatalf("second session released first session key: %+v", backend.Events())
	}
	first.release(ctx)
	events := backend.Events()
	if len(events) != 2 || events[1].Key == nil || events[1].Key.Down {
		t.Fatalf("final key release missing: %+v", events)
	}
}

type transientReleaseSink struct {
	failRelease bool
	events      []connect.KeyEvent
}

func (sink *transientReleaseSink) Key(_ context.Context, event connect.KeyEvent) error {
	if !event.Down && sink.failRelease {
		sink.failRelease = false
		return errors.New("temporary input failure")
	}
	sink.events = append(sink.events, event)
	return nil
}

func (*transientReleaseSink) Pointer(context.Context, connect.PointerEvent) error { return nil }
func (*transientReleaseSink) Close() error                                        { return nil }

func TestInputCoordinatorRetainsFailedReleaseForRetry(t *testing.T) {
	t.Parallel()
	sink := &transientReleaseSink{failRelease: true}
	coordinator := newInputCoordinator(sink, 1)
	input := coordinator.newSession()
	if err := input.Key(context.Background(), connect.KeyEvent{Down: true, Keysym: 65}); err != nil {
		t.Fatal(err)
	}
	input.release(context.Background())
	if len(coordinator.sessions) != 1 || coordinator.keyRefs[65] != 1 {
		t.Fatal("failed release state was forgotten")
	}
	if coordinator.newSession() != nil {
		t.Fatal("failed cleanup bypassed the session bound")
	}
	if err := input.Key(context.Background(), connect.KeyEvent{Down: true, Keysym: 66}); err == nil {
		t.Fatal("retired session accepted new input")
	}
	input.release(context.Background())
	if len(coordinator.sessions) != 0 || len(coordinator.keyRefs) != 0 {
		t.Fatal("retired release state was not cleared")
	}
	if len(sink.events) != 2 || sink.events[1].Down {
		t.Fatalf("release events = %+v", sink.events)
	}
	if coordinator.newSession() == nil {
		t.Fatal("successful cleanup did not free the session slot")
	}
}

func TestInputCoordinatorReferenceCountsPointerButtons(t *testing.T) {
	t.Parallel()
	backend, err := connect.NewSynthetic(connect.SyntheticOptions{Width: 16, Height: 16})
	if err != nil {
		t.Fatal(err)
	}
	coordinator := newInputCoordinator(backend, 2)
	first := coordinator.newSession()
	second := coordinator.newSession()
	ctx := context.Background()
	if err := first.Pointer(ctx, connect.PointerEvent{ButtonMask: 1, X: 1, Y: 1}); err != nil {
		t.Fatal(err)
	}
	if err := second.Pointer(ctx, connect.PointerEvent{ButtonMask: 1, X: 2, Y: 2}); err != nil {
		t.Fatal(err)
	}
	first.release(ctx)
	events := backend.Events()
	if events[len(events)-1].Pointer.ButtonMask != 1 {
		t.Fatalf("first release cleared second button: %+v", events)
	}
	if events[len(events)-1].Pointer.X != 2 || events[len(events)-1].Pointer.Y != 2 {
		t.Fatalf("first release restored stale pointer coordinates: %+v", events)
	}
	second.release(ctx)
	events = backend.Events()
	if events[len(events)-1].Pointer.ButtonMask != 0 {
		t.Fatalf("last button was not released: %+v", events)
	}
}
