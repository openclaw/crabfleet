package rfbclient

import (
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"strings"
	"sync"
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

type failingWriteConn struct {
	net.Conn
	failure      error
	failDeadline bool
}

func (conn *failingWriteConn) Write(p []byte) (int, error) {
	if conn.failure == nil {
		return conn.Conn.Write(p)
	}
	n, err := conn.Conn.Write(p[:1])
	if err != nil {
		return n, err
	}
	return n, conn.failure
}

func (conn *failingWriteConn) SetWriteDeadline(deadline time.Time) error {
	if conn.failure != nil && conn.failDeadline {
		return conn.failure
	}
	return conn.Conn.SetWriteDeadline(deadline)
}

func TestInputWriteFailureClosesHelperAndReleasesInput(t *testing.T) {
	for _, failDeadline := range []bool{false, true} {
		for _, pointer := range []bool{false, true} {
			t.Run(fmt.Sprintf("deadline=%t/pointer=%t", failDeadline, pointer), func(t *testing.T) {
				t.Parallel()
				ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
				defer cancel()
				synthetic, err := connect.NewSynthetic(connect.SyntheticOptions{Width: 2, Height: 2})
				if err != nil {
					t.Fatal(err)
				}
				server, client := net.Pipe()
				defer server.Close()
				helperDone := make(chan struct{})
				go func() {
					defer close(helperDone)
					defer server.Close()
					_ = rfb.ServeConn(ctx, server, rfb.SessionConfig{Backend: synthetic, Password: "fixture1"})
				}()
				conn := &failingWriteConn{Conn: client, failDeadline: failDeadline}
				backend, err := New(ctx, conn, "fixture1")
				if err != nil {
					t.Fatal(err)
				}
				defer backend.Close()
				sendInput := func(ctx context.Context) error {
					if pointer {
						return backend.Pointer(ctx, connect.PointerEvent{ButtonMask: 1, X: 1, Y: 1})
					}
					return backend.Key(ctx, connect.KeyEvent{Keysym: 'a', Down: true})
				}
				canceled, stop := context.WithCancel(ctx)
				stop()
				if err := sendInput(canceled); !errors.Is(err, context.Canceled) {
					t.Fatalf("canceled input: %v", err)
				}
				if err := sendInput(ctx); err != nil {
					t.Fatalf("input after canceled request: %v", err)
				}
				conn.failure = errors.New("fixture transport failure")
				if err := sendInput(ctx); !errors.Is(err, conn.failure) {
					t.Fatalf("failed input: %v", err)
				}
				for _, done := range []<-chan struct{}{backend.done, helperDone} {
					select {
					case <-done:
					case <-ctx.Done():
						t.Fatal("input write failure left the helper session running")
					}
				}
				events := synthetic.Events()
				if len(events) != 2 {
					t.Fatalf("input and release events: %+v", events)
				}
				if pointer {
					if events[1].Pointer == nil || events[1].Pointer.ButtonMask != 0 {
						t.Fatalf("pointer was not released: %+v", events)
					}
				} else if events[1].Key == nil || events[1].Key.Down {
					t.Fatalf("key was not released: %+v", events)
				}
			})
		}
	}
}

// wireBackend isolates server message parsing; authentication and negotiation
// are exercised above against the common authenticated server.
func wireBackend(t *testing.T) (*Backend, net.Conn, <-chan []byte) {
	t.Helper()
	server, client := net.Pipe()
	backend := &Backend{conn: client, updated: make(chan struct{}, 1), done: make(chan struct{})}
	backend.setLayout(connect.DesktopLayout{Width: 2, Height: 2, Screens: []connect.Screen{{Width: 2, Height: 2}}})
	go func() {
		err := backend.readLoop()
		backend.mu.Lock()
		backend.err = err
		backend.mu.Unlock()
		client.Close()
		close(backend.done)
	}()
	requests := make(chan []byte, 32)
	go func() {
		defer close(requests)
		for {
			var kind [1]byte
			if _, err := io.ReadFull(server, kind[:]); err != nil {
				return
			}
			size := 10
			if kind[0] == 251 {
				size = 8
			}
			request := make([]byte, size)
			request[0] = kind[0]
			if _, err := io.ReadFull(server, request[1:]); err != nil {
				return
			}
			if kind[0] == 251 {
				screens := make([]byte, int(request[6])*16)
				if _, err := io.ReadFull(server, screens); err != nil {
					return
				}
				request = append(request, screens...)
			}
			requests <- request
		}
	}()
	t.Cleanup(func() { server.Close(); backend.Close() })
	return backend, server, requests
}

func desktopUpdate(reason, status, width, height int, screens ...connect.Screen) []byte {
	p := make([]byte, 20+16*len(screens))
	p[3] = 1
	binary.BigEndian.PutUint16(p[4:], uint16(reason))
	binary.BigEndian.PutUint16(p[6:], uint16(status))
	binary.BigEndian.PutUint16(p[8:], uint16(width))
	binary.BigEndian.PutUint16(p[10:], uint16(height))
	binary.BigEndian.PutUint32(p[12:], 0xfffffecc)
	p[16] = byte(len(screens))
	for i, screen := range screens {
		dest := p[20+16*i:]
		binary.BigEndian.PutUint32(dest, screen.ID)
		binary.BigEndian.PutUint16(dest[4:], uint16(screen.X))
		binary.BigEndian.PutUint16(dest[6:], uint16(screen.Y))
		binary.BigEndian.PutUint16(dest[8:], uint16(screen.Width))
		binary.BigEndian.PutUint16(dest[10:], uint16(screen.Height))
		binary.BigEndian.PutUint32(dest[12:], screen.Flags)
	}
	return p
}

func rawUpdate(x, y, width, height int) []byte {
	p := make([]byte, 16+width*height*4)
	p[3] = 1
	binary.BigEndian.PutUint16(p[4:], uint16(x))
	binary.BigEndian.PutUint16(p[6:], uint16(y))
	binary.BigEndian.PutUint16(p[8:], uint16(width))
	binary.BigEndian.PutUint16(p[10:], uint16(height))
	for i := 16; i < len(p); i += 4 {
		p[i] = 30
		p[i+1] = 20
		p[i+2] = 10
	}
	return p
}

func sendUpdate(t *testing.T, server net.Conn, backend *Backend, update []byte) {
	t.Helper()
	if err := writeAll(server, update); err != nil {
		t.Fatal(err)
	}
	select {
	case <-backend.updated:
	case <-backend.done:
		t.Fatal(backend.readError())
	case <-time.After(time.Second):
		t.Fatal("update was not processed")
	}
}

func TestStaticCaptureKeepsPendingIncrementalRequest(t *testing.T) {
	t.Parallel()
	backend, server, requests := wireBackend(t)
	sendUpdate(t, server, backend, rawUpdate(0, 0, 2, 2))
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	for range 3 {
		frame, err := backend.Capture(ctx)
		if err != nil {
			t.Fatal(err)
		}
		if frame.Width != 2 || frame.Pixels[0] != 10 || frame.Pixels[3] != 255 {
			t.Fatalf("invalid capture: %+v", frame)
		}
	}
	request := <-requests
	if request[0] != 3 || request[1] != 1 {
		t.Fatalf("expected incremental update: %x", request)
	}
	select {
	case request := <-requests:
		t.Fatalf("duplicate pending request: %x", request)
	default:
	}
	select {
	case <-backend.done:
		t.Fatal("static helper disconnected")
	default:
	}
}

func TestDesktopMetadataWaitsForCompletePixels(t *testing.T) {
	t.Parallel()
	backend, server, _ := wireBackend(t)
	sendUpdate(t, server, backend, rawUpdate(0, 0, 2, 2))
	layout := connect.Screen{ID: 9, Width: 3, Height: 2}
	sendUpdate(t, server, backend, desktopUpdate(0, 0, 3, 2, layout))
	if !backend.DesktopResizeSupported() {
		t.Fatal("metadata did not negotiate resize")
	}
	for _, update := range [][]byte{nil, rawUpdate(0, 0, 3, 1), rawUpdate(0, 0, 3, 1)} {
		if update != nil {
			sendUpdate(t, server, backend, update)
		}
		frame, err := backend.Capture(context.Background())
		if err != nil || frame.Width != 2 {
			t.Fatalf("published incomplete framebuffer: %dx%d, %v", frame.Width, frame.Height, err)
		}
	}
	sendUpdate(t, server, backend, rawUpdate(0, 1, 3, 1))
	frame, err := backend.Capture(context.Background())
	if err != nil || frame.Width != 3 || frame.Screens[0].ID != 9 {
		t.Fatalf("resized capture: %+v, %v", frame, err)
	}
	if err := frame.Validate(); err != nil {
		t.Fatal(err)
	}
	for i := 3; i < len(frame.Pixels); i += 4 {
		if frame.Pixels[i] != 255 {
			t.Fatal("blank resize pixel")
		}
	}
}

func TestResizeRequiresNegotiationAndParsesEveryReply(t *testing.T) {
	t.Parallel()
	backend, server, requests := wireBackend(t)
	layout := connect.DesktopLayout{Width: 3, Height: 2, Screens: []connect.Screen{{ID: 4, Width: 3, Height: 2}}}
	if err := backend.ResizeDesktop(context.Background(), layout); !errors.Is(err, connect.ErrResizeUnsupported) {
		t.Fatalf("unnegotiated resize: %v", err)
	}
	sendUpdate(t, server, backend, desktopUpdate(0, 0, 2, 2, connect.Screen{ID: 4, Width: 2, Height: 2}))
	for index, status := range []int{1, 2, 3, 65535, 0, 0} {
		result := make(chan error, 1)
		go func() { result <- backend.ResizeDesktop(context.Background(), layout) }()
		request := <-requests
		if request[0] != 251 || binary.BigEndian.Uint16(request[2:]) != 3 || binary.BigEndian.Uint32(request[8:]) != 4 {
			t.Fatalf("invalid resize request: %x", request)
		}
		if err := writeAll(server, desktopUpdate(1, status, 3, 2, layout.Screens...)); err != nil {
			t.Fatal(err)
		}
		if status == 0 && index == 4 {
			if request := <-requests; request[0] != 3 {
				t.Fatalf("expected post-resize capture request: %x", request)
			}
			if err := writeAll(server, rawUpdate(0, 0, 3, 2)); err != nil {
				t.Fatal(err)
			}
		}
		select {
		case err := <-result:
			if (err == nil) != (status == 0) {
				t.Fatalf("resize status %d returned %v", status, err)
			}
			if status == 3 && !errors.Is(err, connect.ErrResizeUnsupported) {
				t.Fatalf("unsupported layout status: %v", err)
			}
			if status == 1 && !errors.Is(err, connect.ErrResizeProhibited) {
				t.Fatalf("prohibited status: %v", err)
			}
		case <-time.After(time.Second):
			t.Fatal("resize response deadlocked")
		}
	}
}

func TestMalformedDesktopLayoutsFailSession(t *testing.T) {
	t.Parallel()
	screen := connect.Screen{Width: 2, Height: 2}
	for name, packet := range map[string][]byte{
		"empty":        desktopUpdate(0, 0, 2, 2),
		"zero size":    desktopUpdate(0, 0, 0, 2, screen),
		"duplicate ID": desktopUpdate(0, 0, 2, 2, screen, screen),
		"outside":      desktopUpdate(0, 0, 1, 2, screen),
	} {
		t.Run(name, func(t *testing.T) {
			backend, server, _ := wireBackend(t)
			_ = writeAll(server, packet)
			select {
			case <-backend.done:
				if backend.readError() == nil {
					t.Fatal("missing parse error")
				}
			case <-time.After(time.Second):
				t.Fatal("malformed layout accepted")
			}
		})
	}
}

func TestInitialCaptureTimeoutDoesNotPoisonConnection(t *testing.T) {
	t.Parallel()
	backend, server, requests := wireBackend(t)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	if _, err := backend.Capture(ctx); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("initial capture: %v", err)
	}
	if request := <-requests; request[1] != 0 {
		t.Fatalf("initial request was incremental: %x", request)
	}
	sendUpdate(t, server, backend, rawUpdate(0, 0, 2, 2))
	if _, err := backend.Capture(context.Background()); err != nil {
		t.Fatal(err)
	}
}

type resizingFixture struct {
	mu    sync.Mutex
	frame connect.Frame
}

func (fixture *resizingFixture) Capture(context.Context) (connect.Frame, error) {
	fixture.mu.Lock()
	defer fixture.mu.Unlock()
	frame := fixture.frame
	frame.Pixels = bytes.Clone(frame.Pixels)
	return frame, nil
}
func (*resizingFixture) Key(context.Context, connect.KeyEvent) error         { return nil }
func (*resizingFixture) Pointer(context.Context, connect.PointerEvent) error { return nil }
func (*resizingFixture) Close() error                                        { return nil }
func (*resizingFixture) DesktopResizeSupported() bool                        { return true }
func (fixture *resizingFixture) ResizeDesktop(_ context.Context, layout connect.DesktopLayout) error {
	fixture.mu.Lock()
	defer fixture.mu.Unlock()
	fixture.frame = connect.Frame{Width: layout.Width, Height: layout.Height, Stride: layout.Width * 4, Pixels: bytes.Repeat([]byte{70, 40, 20, 255}, layout.Width*layout.Height), Screens: layout.Screens, Sequence: fixture.frame.Sequence + 1}
	return nil
}

func TestResizeThroughAuthenticatedCommonServer(t *testing.T) {
	t.Parallel()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	fixture := new(resizingFixture)
	if err := fixture.ResizeDesktop(ctx, connect.DesktopLayout{Width: 2, Height: 2, Screens: []connect.Screen{{ID: 5, Width: 2, Height: 2}}}); err != nil {
		t.Fatal(err)
	}
	server, client := net.Pipe()
	defer server.Close()
	go func() {
		defer server.Close()
		_ = rfb.ServeConn(ctx, server, rfb.SessionConfig{Backend: fixture, Password: "fixture1", AllowResize: true})
	}()
	backend, err := New(ctx, client, "fixture1")
	if err != nil {
		t.Fatal(err)
	}
	defer backend.Close()
	initial, err := backend.Capture(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if initial.Width != 2 || initial.Screens[0].ID != 5 || !backend.DesktopResizeSupported() {
		t.Fatalf("initial negotiated frame: %+v", initial)
	}
	target := connect.DesktopLayout{Width: 4, Height: 3, Screens: []connect.Screen{{ID: 5, Width: 4, Height: 3}}}
	if err := backend.ResizeDesktop(ctx, target); err != nil {
		t.Fatal(err)
	}
	frame, err := backend.Capture(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if !frame.DesktopLayout().Equal(target) || frame.Pixels[0] != 70 {
		t.Fatalf("invalid resized frame: %+v", frame)
	}

	if err := backend.ResizeDesktop(ctx, target); err != nil {
		t.Fatalf("same-size request was not acknowledged: %v", err)
	}
}

func TestLegacyDesktopSizeUpdatesCaptureGeometry(t *testing.T) {
	t.Parallel()
	backend, server, _ := wireBackend(t)
	packet := desktopUpdate(0, 0, 3, 2)[:16]
	binary.BigEndian.PutUint32(packet[12:], 0xffffff21)
	sendUpdate(t, server, backend, packet)
	if backend.DesktopResizeSupported() {
		t.Fatal("legacy desktop size enabled SetDesktopSize")
	}
	sendUpdate(t, server, backend, rawUpdate(0, 0, 3, 2))
	frame, err := backend.Capture(context.Background())
	if err != nil || frame.Width != 3 || frame.Height != 2 {
		t.Fatalf("legacy resized frame: %+v, %v", frame, err)
	}
}

func TestResizeDeadlineClosesUncorrelatedReplyStream(t *testing.T) {
	t.Parallel()
	backend, server, requests := wireBackend(t)
	screen := connect.Screen{Width: 2, Height: 2}
	sendUpdate(t, server, backend, desktopUpdate(0, 0, 2, 2, screen))
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	result := make(chan error, 1)
	go func() {
		result <- backend.ResizeDesktop(ctx, connect.DesktopLayout{Width: 2, Height: 2, Screens: []connect.Screen{screen}})
	}()
	if request := <-requests; request[0] != 251 {
		t.Fatalf("expected resize: %x", request)
	}
	select {
	case err := <-result:
		if !errors.Is(err, context.DeadlineExceeded) {
			t.Fatalf("resize deadline: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("resize ignored its deadline")
	}
	select {
	case <-backend.done:
	case <-time.After(time.Second):
		t.Fatal("late resize reply could be reused")
	}
}

func TestForwardedResizeWaitsForActualLayoutAndPixels(t *testing.T) {
	t.Parallel()
	backend, server, requests := wireBackend(t)
	screen := connect.Screen{ID: 4, Width: 2, Height: 2}
	sendUpdate(t, server, backend, desktopUpdate(0, 0, 2, 2, screen))
	sendUpdate(t, server, backend, rawUpdate(0, 0, 2, 2))
	target := connect.DesktopLayout{Width: 3, Height: 2, Screens: []connect.Screen{{ID: 4, Width: 3, Height: 2}}}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	result := make(chan error, 1)
	go func() { result <- backend.ResizeDesktop(ctx, target) }()
	if request := <-requests; request[0] != 251 {
		t.Fatalf("expected resize: %x", request)
	}
	// A failure/forwarded response has undefined layout and padding fields.
	forwarded := desktopUpdate(1, 4, 0, 0, connect.Screen{})
	forwarded[17], forwarded[18], forwarded[19] = 1, 2, 3
	if err := writeAll(server, forwarded); err != nil {
		t.Fatal(err)
	}
	if request := <-requests; request[0] != 3 || request[1] != 1 {
		t.Fatalf("expected old-layout incremental request: %x", request)
	}
	if err := writeAll(server, desktopUpdate(0, 0, 3, 2, target.Screens...)); err != nil {
		t.Fatal(err)
	}
	if request := <-requests; request[0] != 3 || request[1] != 0 || binary.BigEndian.Uint16(request[6:]) != 3 {
		t.Fatalf("expected new-layout full request: %x", request)
	}
	if err := writeAll(server, rawUpdate(0, 0, 3, 1)); err != nil {
		t.Fatal(err)
	}
	if request := <-requests; request[0] != 3 {
		t.Fatalf("expected remaining pixels request: %x", request)
	}
	select {
	case err := <-result:
		t.Fatalf("completed before all pixels: %v", err)
	default:
	}
	if err := writeAll(server, rawUpdate(0, 1, 3, 1)); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-result:
		if err != nil {
			t.Fatal(err)
		}
	case <-ctx.Done():
		t.Fatal("forwarded resize did not complete")
	}
	frame, err := backend.Capture(ctx)
	if err != nil || !frame.DesktopLayout().Equal(target) {
		t.Fatalf("incomplete forwarded capture: %+v, %v", frame, err)
	}
}

func TestExtendedDesktopFutureReasonIgnoresStatusAndPadding(t *testing.T) {
	t.Parallel()
	backend, server, _ := wireBackend(t)
	packet := desktopUpdate(65535, 65535, 3, 2, connect.Screen{ID: 42, Width: 3, Height: 2})
	packet[17], packet[18], packet[19] = 1, 2, 3
	sendUpdate(t, server, backend, packet)
	sendUpdate(t, server, backend, rawUpdate(0, 0, 3, 2))
	frame, err := backend.Capture(context.Background())
	if err != nil || frame.Width != 3 || frame.Screens[0].ID != 42 {
		t.Fatalf("future external layout: %+v, %v", frame, err)
	}
}

func TestUnknownResizeFailureIgnoresUndefinedLayout(t *testing.T) {
	t.Parallel()
	backend, server, requests := wireBackend(t)
	screen := connect.Screen{Width: 2, Height: 2}
	sendUpdate(t, server, backend, desktopUpdate(0, 0, 2, 2, screen))
	result := make(chan error, 1)
	go func() {
		result <- backend.ResizeDesktop(context.Background(), connect.DesktopLayout{Width: 2, Height: 2, Screens: []connect.Screen{screen}})
	}()
	if request := <-requests; request[0] != 251 {
		t.Fatalf("expected resize: %x", request)
	}
	// Failure records must be consumed even when their geometry is undefined.
	packet := desktopUpdate(1, 65535, 0, 0, make([]connect.Screen, 255)...)
	if err := writeAll(server, packet); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-result:
		if err == nil || !strings.Contains(err.Error(), "65535") {
			t.Fatalf("unknown resize failure: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("unknown failure was not delivered")
	}
	sendUpdate(t, server, backend, rawUpdate(0, 0, 2, 2))
	if _, err := backend.Capture(context.Background()); err != nil {
		t.Fatalf("resize failure disconnected capture: %v", err)
	}
}

func TestCapturePublishesWholeUpdatesAtomically(t *testing.T) {
	t.Parallel()
	for _, metadata := range []bool{false, true} {
		t.Run(fmt.Sprintf("metadata=%v", metadata), func(t *testing.T) {
			backend, server, _ := wireBackend(t)
			sendUpdate(t, server, backend, rawUpdate(0, 0, 2, 2))
			if metadata {
				sendUpdate(t, server, backend, desktopUpdate(0, 0, 2, 2, connect.Screen{ID: 9, Width: 2, Height: 2}))
			}
			before, err := backend.Capture(context.Background())
			if err != nil {
				t.Fatal(err)
			}
			top, bottom := rawUpdate(0, 0, 2, 1), rawUpdate(0, 1, 2, 1)
			top[3] = 2
			for i := 18; i < len(top); i += 4 {
				top[i] = 70
			}
			for i := 18; i < len(bottom); i += 4 {
				bottom[i] = 90
			}
			// Reading the second rectangle header proves the first was applied to
			// the working canvas; leave the second rectangle's pixels pending.
			prefix := append(top, bottom[4:16]...)
			if err := writeAll(server, prefix); err != nil {
				t.Fatal(err)
			}
			during, err := backend.Capture(context.Background())
			if err != nil {
				t.Fatal(err)
			}
			if during.Sequence != before.Sequence || !bytes.Equal(during.Pixels, before.Pixels) || !during.DesktopLayout().Equal(before.DesktopLayout()) {
				t.Fatalf("published partial update: before=%+v during=%+v", before, during)
			}
			if err := writeAll(server, bottom[16:]); err != nil {
				t.Fatal(err)
			}
			select {
			case <-backend.updated:
			case <-backend.done:
				t.Fatal(backend.readError())
			case <-time.After(time.Second):
				t.Fatal("complete update was not published")
			}
			after, err := backend.Capture(context.Background())
			if err != nil {
				t.Fatal(err)
			}
			if after.Sequence != before.Sequence+1 || after.Pixels[0] != 70 || after.Pixels[8] != 90 {
				t.Fatalf("complete update missing: before=%+v after=%+v", before, after)
			}
		})
	}
}
