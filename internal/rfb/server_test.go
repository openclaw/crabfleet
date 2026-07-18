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
	mu      sync.Mutex
	calls   int
	blocked chan struct{}
}

func (backend *blockingBackend) Capture(ctx context.Context) (connect.Frame, error) {
	backend.mu.Lock()
	backend.calls++
	call := backend.calls
	backend.mu.Unlock()
	if call > 1 {
		close(backend.blocked)
		<-ctx.Done()
		return connect.Frame{}, ctx.Err()
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
func (*blockingBackend) Close() error                                        { return nil }

func TestServerCloseCancelsBlockedCapture(t *testing.T) {
	t.Parallel()
	backend := &blockingBackend{blocked: make(chan struct{})}
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

type repeatReader struct{}

func (*repeatReader) Read(payload []byte) (int, error) {
	for index := range payload {
		payload[index] = byte(index)
	}
	return len(payload), nil
}
