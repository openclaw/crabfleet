package rfb

import (
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"net"
	"sync"
	"testing"
	"time"

	"github.com/openclaw/crabfleet/internal/connect"
)

type desktopFixture struct {
	mu        sync.Mutex
	layout    connect.DesktopLayout
	calls     int
	resizeErr error
	partial   bool
}

func (b *desktopFixture) Capture(context.Context) (connect.Frame, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	l := b.layout
	return connect.Frame{Width: l.Width, Height: l.Height, Stride: l.Width * 4, Pixels: make([]byte, l.Width*l.Height*4), Screens: append([]connect.Screen(nil), l.Screens...)}, nil
}
func (*desktopFixture) Close() error                                        { return nil }
func (*desktopFixture) Key(context.Context, connect.KeyEvent) error         { return nil }
func (*desktopFixture) Pointer(context.Context, connect.PointerEvent) error { return nil }
func (*desktopFixture) DesktopResizeSupported() bool                        { return true }
func (b *desktopFixture) ResizeDesktop(_ context.Context, l connect.DesktopLayout) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.calls++
	if b.resizeErr != nil {
		if b.partial {
			b.layout = l
		}
		return b.resizeErr
	}
	b.layout = l
	return nil
}
func fixtureLayout(w, h int) connect.DesktopLayout {
	return connect.DesktopLayout{Width: w, Height: h, Screens: []connect.Screen{{ID: 42, Width: w, Height: h, Flags: 16}}}
}
func desktopRequest(l connect.DesktopLayout) []byte {
	p := binary.BigEndian.AppendUint16([]byte{251, 0}, uint16(l.Width))
	p = binary.BigEndian.AppendUint16(p, uint16(l.Height))
	p = append(p, byte(len(l.Screens)), 0)
	for _, s := range l.Screens {
		p = binary.BigEndian.AppendUint32(p, s.ID)
		p = binary.BigEndian.AppendUint16(p, uint16(s.X))
		p = binary.BigEndian.AppendUint16(p, uint16(s.Y))
		p = binary.BigEndian.AppendUint16(p, uint16(s.Width))
		p = binary.BigEndian.AppendUint16(p, uint16(s.Height))
		p = binary.BigEndian.AppendUint32(p, s.Flags)
	}
	return p
}
func startDesktopSession(t *testing.T, backend connect.Backend, allow, view bool) (net.Conn, <-chan error) {
	t.Helper()
	server, client := net.Pipe()
	_ = client.SetDeadline(time.Now().Add(3 * time.Second))
	done := make(chan error, 1)
	go func() {
		defer server.Close()
		done <- ServeConn(context.Background(), server, SessionConfig{Backend: backend, Password: "fixture", AllowResize: allow, ViewOnly: view})
	}()
	t.Cleanup(func() { client.Close() })
	completeHandshake(t, client, "fixture")
	header := readExactly(t, client, 24)
	readExactly(t, client, int(binary.BigEndian.Uint32(header[20:])))
	return client, done
}
func assertDesktopUpdate(t *testing.T, c net.Conn, l connect.DesktopLayout, extended bool, reason, status int) {
	t.Helper()
	want, err := desktopSizeUpdate(l, extended, reason, status)
	if err != nil {
		t.Fatal(err)
	}
	assertRead(t, c, want)
}
func requestDesktopFrame(t *testing.T, c net.Conn, incremental bool, w, h int) {
	t.Helper()
	p := []byte{3, 0, 0, 0, 0, 0}
	if incremental {
		p[1] = 1
	}
	p = binary.BigEndian.AppendUint16(p, uint16(w))
	p = binary.BigEndian.AppendUint16(p, uint16(h))
	assertWrite(t, c, p)
}
func readRawDesktop(t *testing.T, c net.Conn, w, h int) {
	t.Helper()
	assertRead(t, c, []byte{0, 0, 0, 1})
	header := readExactly(t, c, 12)
	if int(binary.BigEndian.Uint16(header[4:])) != w || int(binary.BigEndian.Uint16(header[6:])) != h || binary.BigEndian.Uint32(header[8:]) != 0 {
		t.Fatalf("raw header %x", header)
	}
	readExactly(t, c, w*h*4)
}

func TestDesktopMetadataSeparatedFromPixelsAndExternalChanges(t *testing.T) {
	for _, extended := range []bool{false, true} {
		t.Run(map[bool]string{true: "extended", false: "legacy-size"}[extended], func(t *testing.T) {
			b := &desktopFixture{layout: fixtureLayout(8, 6)}
			c, _ := startDesktopSession(t, b, true, false)
			encoding := EncodingDesktopSize
			if extended {
				encoding = EncodingExtendedDesktopSize
			}
			assertWrite(t, c, encodeSetEncodings([]int32{EncodingRaw, encoding}))
			requestDesktopFrame(t, c, false, 8, 6)
			if extended {
				assertDesktopUpdate(t, c, b.layout, true, 0, 0)
			}
			readRawDesktop(t, c, 8, 6)
			b.mu.Lock()
			b.layout = fixtureLayout(10, 7)
			b.mu.Unlock()
			requestDesktopFrame(t, c, true, 8, 6)
			assertDesktopUpdate(t, c, fixtureLayout(10, 7), extended, 0, 0)
			readRawDesktop(t, c, 10, 7)
		})
	}
}
func TestSetDesktopSizeRepliesEveryTimeAndEnforcesPolicy(t *testing.T) {
	for _, test := range []struct {
		name              string
		allow, view       bool
		resizeErr         error
		wantStatus, calls int
	}{{"allowed", true, false, nil, 0, 2}, {"default-deny", false, false, nil, 1, 0}, {"view-only", true, true, nil, 1, 0}, {"unsupported-layout", true, false, connect.ErrResizeUnsupported, 3, 2}, {"resources", true, false, errors.New("resources"), 2, 2}} {
		t.Run(test.name, func(t *testing.T) {
			b := &desktopFixture{layout: fixtureLayout(8, 6), resizeErr: test.resizeErr}
			c, _ := startDesktopSession(t, b, test.allow, test.view)
			assertWrite(t, c, encodeSetEncodings([]int32{EncodingRaw, EncodingExtendedDesktopSize}))
			l := fixtureLayout(10, 7)
			for range 2 {
				assertWrite(t, c, desktopRequest(l))
				expected := fixtureLayout(8, 6)
				if test.wantStatus == 0 {
					expected = l
				}
				assertDesktopUpdate(t, c, expected, true, 1, test.wantStatus)
			}
			b.mu.Lock()
			calls := b.calls
			b.mu.Unlock()
			if calls != test.calls {
				t.Fatalf("resize calls=%d", calls)
			}
			invalid := l
			invalid.Screens = nil
			assertWrite(t, c, desktopRequest(invalid))
			expected := fixtureLayout(8, 6)
			if test.wantStatus == 0 {
				expected = l
			}
			assertDesktopUpdate(t, c, expected, true, 1, 3)
		})
	}
}
func TestResizeRequiresNegotiationAndOldPeerClosesBeforeNewPixels(t *testing.T) {
	b := &desktopFixture{layout: fixtureLayout(8, 6)}
	c, done := startDesktopSession(t, b, true, false)
	assertWrite(t, c, encodeSetEncodings([]int32{EncodingRaw}))
	b.mu.Lock()
	b.layout = fixtureLayout(10, 7)
	b.mu.Unlock()
	requestDesktopFrame(t, c, true, 8, 6)
	if err := <-done; err == nil {
		t.Fatal("old peer received changed geometry")
	}
	b = &desktopFixture{layout: fixtureLayout(8, 6)}
	c, done = startDesktopSession(t, b, true, false)
	assertWrite(t, c, desktopRequest(fixtureLayout(10, 7)))
	if err := <-done; err == nil {
		t.Fatal("unnegotiated resize accepted")
	}
	if b.calls != 0 {
		t.Fatal("unnegotiated resize reached backend")
	}
}
func TestSetDesktopSizeConsumesBoundedInvalidScreenLists(t *testing.T) {
	l := fixtureLayout(8, 6)
	l.Screens = make([]connect.Screen, 17)
	p := desktopRequest(l)
	reader := bytes.NewReader(append(p[1:], 99))
	parsed, err := parseSetDesktopSize(reader)
	if err != nil || parsed.Validate() == nil || reader.Len() != 1 {
		t.Fatalf("parse=%+v err=%v left=%d", parsed, err, reader.Len())
	}
}

func TestCaptureCoordinatorClonesLayoutAndMarksSharedResize(t *testing.T) {
	b := &desktopFixture{layout: fixtureLayout(8, 6)}
	capture := &captureCoordinator{backend: b}
	backend := &coordinatedBackend{Backend: b, capture: capture}
	if !backend.DesktopResizeSupported() {
		t.Fatal("resize capability lost")
	}
	frame, err := backend.Capture(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	frame.Screens[0].ID = 55
	if b.layout.Screens[0].ID != 42 {
		t.Fatal("capture layout aliases backend")
	}
	if err := backend.ResizeDesktop(context.Background(), fixtureLayout(10, 7)); err != nil {
		t.Fatal(err)
	}
	next, err := backend.Capture(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if next.DesktopRevision != 1 || next.Width != 10 {
		t.Fatalf("resize not forwarded: %+v", next.DesktopLayout())
	}
}

func TestOtherViewerReceivesClientInitiatedLayoutChange(t *testing.T) {
	b := &desktopFixture{layout: fixtureLayout(8, 6)}
	capture := &captureCoordinator{backend: b}
	input := newInputCoordinator(b, 2)
	first, _ := startDesktopSession(t, &coordinatedBackend{Backend: b, capture: capture, input: input.newSession()}, true, false)
	second, _ := startDesktopSession(t, &coordinatedBackend{Backend: b, capture: capture, input: input.newSession()}, true, false)
	for _, client := range []net.Conn{first, second} {
		assertWrite(t, client, encodeSetEncodings([]int32{EncodingRaw, EncodingExtendedDesktopSize}))
		requestDesktopFrame(t, client, false, 8, 6)
		assertDesktopUpdate(t, client, fixtureLayout(8, 6), true, 0, 0)
		readRawDesktop(t, client, 8, 6)
	}
	assertWrite(t, first, desktopRequest(fixtureLayout(10, 7)))
	assertDesktopUpdate(t, first, fixtureLayout(10, 7), true, 1, 0)
	requestDesktopFrame(t, second, true, 8, 6)
	assertDesktopUpdate(t, second, fixtureLayout(10, 7), true, 2, 0)
	readRawDesktop(t, second, 10, 7)
}

func TestPartialResizeFailureAnnouncesActualLayoutBeforeNextPixels(t *testing.T) {
	b := &desktopFixture{layout: fixtureLayout(8, 6), resizeErr: errors.New("second output failed"), partial: true}
	client, _ := startDesktopSession(t, b, true, false)
	assertWrite(t, client, encodeSetEncodings([]int32{EncodingRaw, EncodingExtendedDesktopSize}))
	assertWrite(t, client, desktopRequest(fixtureLayout(10, 7)))
	assertDesktopUpdate(t, client, fixtureLayout(8, 6), true, 1, 2)
	requestDesktopFrame(t, client, true, 8, 6)
	assertDesktopUpdate(t, client, fixtureLayout(10, 7), true, 0, 0)
	readRawDesktop(t, client, 10, 7)
}

type blockedDesktopCapture struct {
	*desktopFixture
	captureEntered chan struct{}
	releaseCapture chan struct{}
	resizeEntered  chan int
	once           sync.Once
}

func (b *blockedDesktopCapture) Capture(ctx context.Context) (connect.Frame, error) {
	b.once.Do(func() { close(b.captureEntered); <-b.releaseCapture })
	return b.desktopFixture.Capture(ctx)
}
func (b *blockedDesktopCapture) ResizeDesktop(ctx context.Context, l connect.DesktopLayout) error {
	b.resizeEntered <- l.Width
	return b.desktopFixture.ResizeDesktop(ctx, l)
}
func TestConcurrentResizeKeepsItsOwnAcknowledgementSnapshot(t *testing.T) {
	b := &blockedDesktopCapture{desktopFixture: &desktopFixture{layout: fixtureLayout(8, 6)}, captureEntered: make(chan struct{}), releaseCapture: make(chan struct{}), resizeEntered: make(chan int, 2)}
	captures := &captureCoordinator{backend: b}
	backend := &coordinatedBackend{Backend: b, capture: captures}
	type result struct {
		frame connect.Frame
		err   error
	}
	first, second := make(chan result, 1), make(chan result, 1)
	go func() {
		f, e := resizeDesktopFrame(context.Background(), backend, backend, fixtureLayout(10, 7))
		first <- result{f, e}
	}()
	<-b.captureEntered
	if width := <-b.resizeEntered; width != 10 {
		t.Fatal(width)
	}
	go func() {
		f, e := resizeDesktopFrame(context.Background(), backend, backend, fixtureLayout(12, 8))
		second <- result{f, e}
	}()
	select {
	case width := <-b.resizeEntered:
		close(b.releaseCapture)
		t.Fatalf("second resize (%d) overtook first acknowledgement capture", width)
	case <-time.After(20 * time.Millisecond):
	}
	close(b.releaseCapture)
	a, c := <-first, <-second
	if a.err != nil || c.err != nil || a.frame.Width != 10 || c.frame.Width != 12 {
		t.Fatalf("resize snapshots: first=%d/%v second=%d/%v", a.frame.Width, a.err, c.frame.Width, c.err)
	}
}
