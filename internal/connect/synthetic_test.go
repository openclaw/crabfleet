package connect

import (
	"context"
	"errors"
	"testing"
)

func TestSyntheticCaptureAndBoundedInput(t *testing.T) {
	t.Parallel()
	backend, err := NewSynthetic(SyntheticOptions{Width: 16, Height: 8, EventCapacity: 2})
	if err != nil {
		t.Fatal(err)
	}
	first, err := backend.Capture(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	second, err := backend.Capture(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if err := first.Validate(); err != nil {
		t.Fatal(err)
	}
	if second.Sequence != first.Sequence+1 || string(first.Pixels) == string(second.Pixels) {
		t.Fatal("synthetic capture did not advance")
	}

	for index := uint16(0); index < 3; index++ {
		if err := backend.Pointer(context.Background(), PointerEvent{X: index, Y: 1}); err != nil {
			t.Fatal(err)
		}
	}
	events := backend.Events()
	if len(events) != 2 || events[0].Pointer.X != 1 || events[1].Pointer.X != 2 {
		t.Fatalf("unexpected bounded events: %+v", events)
	}
	cursor, err := backend.Cursor(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if err := cursor.Validate(16, 8); err != nil {
		t.Fatal(err)
	}
	if cursor.X != 2 || cursor.Y != 1 {
		t.Fatalf("cursor position = %d,%d", cursor.X, cursor.Y)
	}
}

func TestFrameRejectsMalformedBounds(t *testing.T) {
	t.Parallel()
	cases := []Frame{
		{Width: 0, Height: 1, Stride: 4, Pixels: make([]byte, 4)},
		{Width: 2, Height: 1, Stride: 4, Pixels: make([]byte, 4)},
		{Width: 1, Height: 2, Stride: 4, Pixels: make([]byte, 4)},
		{Width: 1, Height: 1, Stride: 4, Pixels: make([]byte, 4), DirtyRects: []Rect{{X: 1, Width: 1, Height: 1}}},
	}
	for _, frame := range cases {
		if err := frame.Validate(); err == nil {
			t.Fatalf("accepted malformed frame: %+v", frame)
		}
	}
}

func TestSyntheticCloseIsIdempotent(t *testing.T) {
	t.Parallel()
	backend, err := NewSynthetic(SyntheticOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if err := backend.Close(); err != nil {
		t.Fatal(err)
	}
	if err := backend.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := backend.Capture(context.Background()); !errors.Is(err, ErrClosed) {
		t.Fatalf("capture after close: %v", err)
	}
}

func TestSyntheticRejectsFramesAboveMemoryLimit(t *testing.T) {
	t.Parallel()
	if _, err := NewSynthetic(SyntheticOptions{Width: MaxDimension, Height: MaxDimension}); err == nil {
		t.Fatal("accepted synthetic frame above memory limit")
	}
}
