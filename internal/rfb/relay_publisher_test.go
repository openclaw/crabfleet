package rfb

import (
	"context"
	"encoding/binary"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/openclaw/crabfleet/internal/connect"
)

func TestRelayPublisherAuthenticatesUpgradeAndServesBoundedFrames(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	backend, err := connect.NewSynthetic(connect.SyntheticOptions{Width: 320, Height: 240})
	if err != nil {
		t.Fatal(err)
	}
	server, err := NewServer(ServerConfig{Session: SessionConfig{Backend: backend, Password: "fixture1"}})
	if err != nil {
		t.Fatal(err)
	}
	defer server.Close()
	completed := make(chan error, 1)
	relay := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/desktop-hosts/linux-test/relay/host" || r.Header.Get("X-Crabfleet-Ownership-Token") != "fixture-ownership-token" {
			http.Error(w, "denied", 403)
			return
		}
		ws, err := websocket.Accept(w, r, nil)
		if err != nil {
			completed <- err
			return
		}
		defer ws.CloseNow()
		conn := websocket.NetConn(ctx, ws, websocket.MessageBinary)
		ws.SetReadLimit(256 << 10)
		defer conn.Close()
		read := func(n int) ([]byte, error) { p := make([]byte, n); _, err := io.ReadFull(conn, p); return p, err }
		banner, err := read(12)
		if err != nil {
			completed <- err
			return
		}
		if err := writeFull(conn, banner); err != nil {
			completed <- err
			return
		}
		offer, err := read(2)
		if err != nil {
			completed <- err
			return
		}
		if offer[0] != 1 || offer[1] != 1 {
			t.Error("relay did not use Worker-authenticated security")
		}
		if err := writeFull(conn, []byte{1}); err != nil {
			completed <- err
			return
		}
		if _, err := read(4); err != nil {
			completed <- err
			return
		}
		if err := writeFull(conn, []byte{1}); err != nil {
			completed <- err
			return
		}
		init, err := read(24)
		if err != nil {
			completed <- err
			return
		}
		if _, err := read(int(binary.BigEndian.Uint32(init[20:]))); err != nil {
			completed <- err
			return
		}
		if err := writeFull(conn, []byte{2, 0, 0, 1, 0, 0, 0, 0, 3, 0, 0, 0, 0, 0, 1, 64, 0, 240}); err != nil {
			completed <- err
			return
		}
		if _, err := read(16); err != nil {
			completed <- err
			return
		}
		_, err = read(320 * 240 * 4)
		completed <- err
	}))
	defer relay.Close()
	done := make(chan error, 1)
	go func() { done <- server.PublishRelay(ctx, relay.URL, "linux-test", "fixture-ownership-token") }()
	select {
	case err := <-completed:
		if err != nil {
			t.Fatal(err)
		}
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("relay did not stop")
	}
	if err := server.PublishRelay(context.Background(), "http://fleet.example", "linux-test", "fixture-ownership-token"); err == nil {
		t.Fatal("accepted unencrypted public relay")
	}
}
