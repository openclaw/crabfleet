package rfb

import (
	"context"
	"encoding/binary"
	"net"
	"sync"
	"testing"
	"time"

	"github.com/openclaw/crabfleet/internal/connect"
)

type blockingBackend struct {
	mu        sync.Mutex
	calls     int
	blocked   chan struct{}
	closed    chan struct{}
	closeOnce sync.Once
}

func (backend *blockingBackend) Capture(ctx context.Context) (connect.Frame, error) {
	backend.mu.Lock()
	backend.calls++
	call := backend.calls
	backend.mu.Unlock()
	if call > 1 {
		close(backend.blocked)
		<-backend.closed
		return connect.Frame{}, connect.ErrClosed
	}
	return connect.Frame{
		Width: 2, Height: 2, Stride: 8,
		Pixels: []byte{
			0, 0, 0, 255, 0, 0, 0, 255,
			0, 0, 0, 255, 0, 0, 0, 255,
		},
	}, nil
}

func (*blockingBackend) Pointer(context.Context, connect.PointerEvent) error { return nil }
func (*blockingBackend) Key(context.Context, connect.KeyEvent) error         { return nil }
func (backend *blockingBackend) Close() error {
	backend.closeOnce.Do(func() { close(backend.closed) })
	return nil
}

func TestServerCloseCancelsBlockedCapture(t *testing.T) {
	t.Parallel()
	backend := &blockingBackend{blocked: make(chan struct{}), closed: make(chan struct{})}
	server, err := NewServer(ServerConfig{Session: SessionConfig{
		Backend: backend, Password: sessionFixturePassword(), ChallengeReader: &repeatReader{},
	}})
	if err != nil {
		t.Fatal(err)
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	serveDone := make(chan error, 1)
	go func() { serveDone <- server.Serve(context.Background(), listener) }()
	client, err := net.Dial("tcp", listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	completeHandshake(t, client, sessionFixturePassword())
	init := readExactly(t, client, 24)
	_ = readExactly(t, client, int(binary.BigEndian.Uint32(init[20:])))
	assertWrite(t, client, encodeSetEncodings([]int32{EncodingTight}))
	assertWrite(t, client, []byte{3, 0, 0, 0, 0, 0, 0, 2, 0, 2})
	select {
	case <-backend.blocked:
	case <-time.After(time.Second):
		t.Fatal("capture did not block")
	}
	closed := make(chan error, 1)
	go func() { closed <- server.Close() }()
	select {
	case err := <-closed:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("server Close blocked behind capture")
	}
	_ = client.Close()
	if err := <-serveDone; err != nil {
		t.Fatal(err)
	}
	if err := server.Close(); err != nil {
		t.Fatal(err)
	}
}

func TestServerRetriesDisconnectedInputWithFreshContext(t *testing.T) {
	t.Parallel()
	backend, err := connect.NewSynthetic(connect.SyntheticOptions{Width: 4, Height: 4})
	if err != nil {
		t.Fatal(err)
	}
	server, err := NewServer(ServerConfig{Session: SessionConfig{Backend: backend, Password: "fixture"}, MaxSessions: 1})
	if err != nil {
		t.Fatal(err)
	}
	defer server.Close()
	input := server.inputs.newSession()
	if err := input.Key(context.Background(), connect.KeyEvent{Down: true, Keysym: 65}); err != nil {
		t.Fatal(err)
	}
	if err := input.Pointer(context.Background(), connect.PointerEvent{ButtonMask: 1, X: 2, Y: 3}); err != nil {
		t.Fatal(err)
	}
	expired, cancel := context.WithCancel(context.Background())
	cancel()
	input.release(expired)
	deadline := time.After(2 * time.Second)
	ticker := time.NewTicker(10 * time.Millisecond)
	defer ticker.Stop()
	for {
		server.inputs.mu.Lock()
		clean := len(server.inputs.sessions) == 0 && len(server.inputs.keyRefs) == 0 && server.inputs.globalButtonMask() == 0
		server.inputs.mu.Unlock()
		if clean {
			break
		}
		select {
		case <-deadline:
			t.Fatal("failed disconnect cleanup was not retried during normal operation")
		case <-ticker.C:
		}
	}
	events := backend.Events()
	if len(events) != 4 || events[2].Key == nil || events[2].Key.Down || events[3].Pointer == nil || events[3].Pointer.ButtonMask != 0 {
		t.Fatalf("input releases = %+v", events)
	}
	if input := server.inputs.newSession(); input == nil {
		t.Fatal("cleanup did not restore admission capacity")
	} else {
		input.release(context.Background())
	}
}

type blockingInputBackend struct {
	connect.Backend
	entered chan struct{}
	closed  chan struct{}
}

func (backend *blockingInputBackend) Key(context.Context, connect.KeyEvent) error {
	close(backend.entered)
	<-backend.closed
	return connect.ErrClosed
}

func (backend *blockingInputBackend) Close() error {
	close(backend.closed)
	return backend.Backend.Close()
}

func TestServerCloseUnblocksInputAndPendingAdmission(t *testing.T) {
	t.Parallel()
	synthetic, err := connect.NewSynthetic(connect.SyntheticOptions{Width: 4, Height: 4})
	if err != nil {
		t.Fatal(err)
	}
	backend := &blockingInputBackend{Backend: synthetic, entered: make(chan struct{}), closed: make(chan struct{})}
	server, err := NewServer(ServerConfig{Session: SessionConfig{Backend: backend, Password: "fixture"}})
	if err != nil {
		t.Fatal(err)
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	serveDone := make(chan error, 1)
	go func() { serveDone <- server.Serve(context.Background(), listener) }()
	input := server.inputs.newSession()
	inputDone := make(chan struct{})
	go func() {
		_ = input.Key(context.Background(), connect.KeyEvent{Down: true, Keysym: 65})
		close(inputDone)
	}()
	<-backend.entered
	client, err := net.Dial("tcp", listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	// Allow Accept to reach the input coordinator while desktop input is blocked.
	time.Sleep(20 * time.Millisecond)
	closed := make(chan error, 1)
	go func() { closed <- server.Close() }()
	select {
	case err := <-closed:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Close waited for admission instead of unblocking the desktop")
	}
	<-inputDone
	if err := <-serveDone; err != nil {
		t.Fatal(err)
	}
}

type repeatReader struct{}

func (*repeatReader) Read(payload []byte) (int, error) {
	for index := range payload {
		payload[index] = byte(index)
	}
	return len(payload), nil
}
