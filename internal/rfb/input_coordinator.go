package rfb

import (
	"context"
	"errors"
	"sync"

	"github.com/openclaw/crabfleet/internal/connect"
)

// inputCoordinator preserves input ownership when several viewers share one
// capture/input backend. A viewer can release only keys and buttons it pressed.
type inputCoordinator struct {
	sink connect.InputSink

	mu          sync.Mutex
	nextID      uint64
	sessions    map[uint64]*sessionInputState
	keyRefs     map[uint32]int
	buttonRefs  [8]int
	lastPointer connect.PointerEvent
}

type captureCoordinator struct {
	backend connect.Backend
	mu      sync.Mutex
}

type sessionInputState struct {
	keys        map[uint32]struct{}
	buttonMask  byte
	lastPointer connect.PointerEvent
	closing     bool
}

type coordinatedInput struct {
	coordinator *inputCoordinator
	id          uint64
}

type coordinatedBackend struct {
	connect.Backend
	input   *coordinatedInput
	capture *captureCoordinator
}

func newInputCoordinator(sink connect.InputSink) *inputCoordinator {
	return &inputCoordinator{
		sink:     sink,
		sessions: make(map[uint64]*sessionInputState),
		keyRefs:  make(map[uint32]int),
	}
}

func (coordinator *inputCoordinator) newSession() *coordinatedInput {
	coordinator.mu.Lock()
	defer coordinator.mu.Unlock()
	coordinator.nextID++
	id := coordinator.nextID
	coordinator.sessions[id] = &sessionInputState{keys: make(map[uint32]struct{})}
	return &coordinatedInput{coordinator: coordinator, id: id}
}

func (input *coordinatedInput) Key(ctx context.Context, event connect.KeyEvent) error {
	coordinator := input.coordinator
	coordinator.mu.Lock()
	defer coordinator.mu.Unlock()
	state := coordinator.sessions[input.id]
	if state == nil {
		return errors.New("input session is closed")
	}
	_, held := state.keys[event.Keysym]
	if event.Down {
		if held {
			return coordinator.sink.Key(ctx, event)
		}
		if coordinator.keyRefs[event.Keysym] == 0 {
			if err := coordinator.sink.Key(ctx, event); err != nil {
				return err
			}
		}
		state.keys[event.Keysym] = struct{}{}
		coordinator.keyRefs[event.Keysym]++
		return nil
	}
	if !held {
		return nil
	}
	if coordinator.keyRefs[event.Keysym] == 1 {
		if err := coordinator.sink.Key(ctx, event); err != nil {
			return err
		}
	}
	delete(state.keys, event.Keysym)
	coordinator.keyRefs[event.Keysym]--
	if coordinator.keyRefs[event.Keysym] == 0 {
		delete(coordinator.keyRefs, event.Keysym)
	}
	return nil
}

func (input *coordinatedInput) Pointer(ctx context.Context, event connect.PointerEvent) error {
	coordinator := input.coordinator
	coordinator.mu.Lock()
	defer coordinator.mu.Unlock()
	state := coordinator.sessions[input.id]
	if state == nil {
		return errors.New("input session is closed")
	}
	previousMask := state.buttonMask
	previousRefs := coordinator.buttonRefs
	for bit := 0; bit < 8; bit++ {
		button := byte(1 << bit)
		wasDown := previousMask&button != 0
		isDown := event.ButtonMask&button != 0
		if wasDown == isDown {
			continue
		}
		if isDown {
			coordinator.buttonRefs[bit]++
		} else if coordinator.buttonRefs[bit] > 0 {
			coordinator.buttonRefs[bit]--
		}
	}
	global := coordinator.globalButtonMask()
	forwarded := event
	forwarded.ButtonMask = global
	if err := coordinator.sink.Pointer(ctx, forwarded); err != nil {
		coordinator.buttonRefs = previousRefs
		return err
	}
	state.buttonMask = event.ButtonMask
	state.lastPointer = event
	coordinator.lastPointer = event
	return nil
}

func (input *coordinatedInput) release(ctx context.Context) {
	coordinator := input.coordinator
	coordinator.mu.Lock()
	defer coordinator.mu.Unlock()
	state := coordinator.sessions[input.id]
	if state == nil {
		return
	}
	state.closing = true
	for keysym := range state.keys {
		if coordinator.keyRefs[keysym] == 1 {
			if err := coordinator.sink.Key(ctx, connect.KeyEvent{Keysym: keysym}); err != nil {
				continue
			}
		}
		coordinator.keyRefs[keysym]--
		if coordinator.keyRefs[keysym] == 0 {
			delete(coordinator.keyRefs, keysym)
		}
		delete(state.keys, keysym)
	}
	if state.buttonMask != 0 {
		previousRefs := coordinator.buttonRefs
		for bit := 0; bit < 8; bit++ {
			if state.buttonMask&(1<<bit) != 0 && coordinator.buttonRefs[bit] > 0 {
				coordinator.buttonRefs[bit]--
			}
		}
		pointer := coordinator.lastPointer
		pointer.ButtonMask = coordinator.globalButtonMask()
		if err := coordinator.sink.Pointer(ctx, pointer); err != nil {
			coordinator.buttonRefs = previousRefs
		} else {
			state.buttonMask = 0
		}
	}
	if len(state.keys) == 0 && state.buttonMask == 0 {
		delete(coordinator.sessions, input.id)
	}
}

func (coordinator *inputCoordinator) releaseAll(ctx context.Context) {
	coordinator.mu.Lock()
	ids := make([]uint64, 0, len(coordinator.sessions))
	for id, state := range coordinator.sessions {
		if state.closing {
			ids = append(ids, id)
		}
	}
	coordinator.mu.Unlock()
	for _, id := range ids {
		(&coordinatedInput{coordinator: coordinator, id: id}).release(ctx)
	}
}

func (coordinator *inputCoordinator) globalButtonMask() byte {
	var result byte
	for bit, references := range coordinator.buttonRefs {
		if references > 0 {
			result |= 1 << bit
		}
	}
	return result
}

func (backend *coordinatedBackend) Key(ctx context.Context, event connect.KeyEvent) error {
	return backend.input.Key(ctx, event)
}

func (backend *coordinatedBackend) Pointer(ctx context.Context, event connect.PointerEvent) error {
	return backend.input.Pointer(ctx, event)
}

func (*coordinatedBackend) Close() error { return nil }

func (backend *coordinatedBackend) Cursor(ctx context.Context) (connect.Cursor, error) {
	return backend.capture.Cursor(ctx)
}

func (backend *coordinatedBackend) Capture(ctx context.Context) (connect.Frame, error) {
	return backend.capture.Capture(ctx)
}

func (backend *coordinatedBackend) releaseSessionInput(ctx context.Context) {
	backend.input.release(ctx)
}

func (coordinator *captureCoordinator) Capture(ctx context.Context) (connect.Frame, error) {
	coordinator.mu.Lock()
	defer coordinator.mu.Unlock()
	frame, err := coordinator.backend.Capture(ctx)
	if err != nil {
		return connect.Frame{}, err
	}
	frame.Pixels = append([]byte(nil), frame.Pixels...)
	frame.DirtyRects = append([]connect.Rect(nil), frame.DirtyRects...)
	return frame, nil
}

func (coordinator *captureCoordinator) Cursor(ctx context.Context) (connect.Cursor, error) {
	coordinator.mu.Lock()
	defer coordinator.mu.Unlock()
	source, ok := coordinator.backend.(connect.CursorCapturer)
	if !ok {
		return connect.Cursor{}, errors.New("cursor capture is unavailable")
	}
	cursor, err := source.Cursor(ctx)
	if err != nil {
		return connect.Cursor{}, err
	}
	cursor.RGBA = append([]byte(nil), cursor.RGBA...)
	return cursor, nil
}
