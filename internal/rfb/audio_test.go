package rfb

import (
	"context"
	"encoding/binary"
	"net"
	"testing"
	"time"

	"github.com/openclaw/crabfleet/internal/connect"
)

type delayedAudioCleanup struct {
	canceled chan struct{}
	release  chan struct{}
}

func (s *delayedAudioCleanup) Subscribe(ctx context.Context) (<-chan connect.AudioPacket, error) {
	packets := make(chan connect.AudioPacket)
	go func() {
		<-ctx.Done()
		close(s.canceled)
		<-s.release
		close(packets)
	}()
	return packets, nil
}

func TestSessionWaitsForAudioCaptureCleanup(t *testing.T) {
	for _, readConfiguration := range []bool{false, true} {
		name := "configuration write failure"
		if readConfiguration {
			name = "active stream disconnect"
		}
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			backend, err := connect.NewSynthetic(connect.SyntheticOptions{Width: 4, Height: 4})
			if err != nil {
				t.Fatal(err)
			}
			defer backend.Close()
			source := &delayedAudioCleanup{canceled: make(chan struct{}), release: make(chan struct{})}
			t.Cleanup(func() { close(source.release) })
			server, client := net.Pipe()
			defer client.Close()
			defer server.Close()
			_ = client.SetDeadline(time.Now().Add(3 * time.Second))
			done := make(chan error, 1)
			go func() {
				done <- ServeConn(context.Background(), server, SessionConfig{
					Backend: backend, Password: "fixture", Audio: source,
					HandshakeTimeout: time.Second, MediaTimeout: time.Second,
				})
			}()
			completeHandshake(t, client, "fixture")
			init := readExactly(t, client, 24)
			_ = readExactly(t, client, int(binary.BigEndian.Uint32(init[20:])))
			assertWrite(t, client, encodeSetEncodings([]int32{EncodingRaw, EncodingAudio}))
			if readConfiguration {
				assertRead(t, client, []byte{200, 1, 1, 2, 0, 0, 187, 128, 0, 0, 0, 2, 0x11, 0x90})
			}
			_ = client.Close()
			select {
			case <-source.canceled:
			case <-time.After(3 * time.Second):
				t.Fatal("audio capture was not canceled")
			}
			select {
			case err := <-done:
				t.Fatalf("session returned before capture cleanup: %v", err)
			case <-time.After(30 * time.Millisecond):
			}
			source.release <- struct{}{}
			select {
			case <-done:
			case <-time.After(3 * time.Second):
				t.Fatal("session did not finish after capture cleanup")
			}
		})
	}
}
