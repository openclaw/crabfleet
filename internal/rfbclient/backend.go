// Package rfbclient adapts a private, authenticated capture helper to the common
// Crabfleet host. It requests bounded raw pixels and negotiated desktop sizing metadata.
package rfbclient

import (
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"sync"
	"time"

	"github.com/openclaw/crabfleet/internal/connect"
	"github.com/openclaw/crabfleet/internal/rfb"
)

var errResizeForwarded = errors.New("capture helper forwarded desktop resize")

type Backend struct {
	conn                             net.Conn
	writeMu, captureMu, resizeMu, mu sync.Mutex
	frame                            connect.Frame
	canvas                           connect.Frame
	coverage                         []uint64
	missing                          int
	pending                          bool
	resizeSupported                  bool
	resizeReply                      chan error
	updated                          chan struct{}
	done                             chan struct{}
	err                              error
}

func New(ctx context.Context, conn net.Conn, password string) (_ *Backend, err error) {
	defer func() {
		if err != nil {
			_ = conn.Close()
		}
	}()
	stop := context.AfterFunc(ctx, func() { _ = conn.Close() })
	defer stop()
	if err = conn.SetDeadline(time.Now().Add(10 * time.Second)); err != nil {
		return nil, err
	}
	banner := make([]byte, 12)
	if _, err = io.ReadFull(conn, banner); err != nil {
		return nil, err
	}
	if !bytes.Equal(banner, rfb.Version38Banner) {
		return nil, errors.New("capture helper requires RFB 3.8")
	}
	if err = writeAll(conn, banner); err != nil {
		return nil, err
	}
	var count [1]byte
	if _, err = io.ReadFull(conn, count[:]); err != nil {
		return nil, err
	}
	types := make([]byte, int(count[0]))
	if _, err = io.ReadFull(conn, types); err != nil {
		return nil, err
	}
	if bytes.Contains(types, []byte{1}) || !bytes.Contains(types, []byte{2}) {
		return nil, errors.New("capture helper must require VNC authentication")
	}
	if err = writeAll(conn, []byte{2}); err != nil {
		return nil, err
	}
	challenge := make([]byte, 16)
	if _, err = io.ReadFull(conn, challenge); err != nil {
		return nil, err
	}
	response, err := rfb.VNCChallengeResponse(challenge, password)
	if err != nil {
		return nil, err
	}
	if err = writeAll(conn, response); err != nil {
		return nil, err
	}
	var result [4]byte
	if _, err = io.ReadFull(conn, result[:]); err != nil {
		return nil, err
	}
	if binary.BigEndian.Uint32(result[:]) != 0 {
		return nil, errors.New("capture helper authentication failed")
	}
	if err = writeAll(conn, []byte{1}); err != nil {
		return nil, err
	}
	header := make([]byte, 24)
	if _, err = io.ReadFull(conn, header); err != nil {
		return nil, err
	}
	w, h := int(binary.BigEndian.Uint16(header)), int(binary.BigEndian.Uint16(header[2:]))
	if w == 0 || h == 0 || int64(w)*int64(h)*4 > connect.MaxFrameBytes {
		return nil, errors.New("invalid capture helper dimensions")
	}
	n := binary.BigEndian.Uint32(header[20:])
	if n > 4096 {
		return nil, errors.New("capture helper name is too long")
	}
	if _, err = io.CopyN(io.Discard, conn, int64(n)); err != nil {
		return nil, err
	}
	// BGRA byte order, independent of the helper's native pixel format.
	// Request RAW plus the two desktop metadata encodings only.
	if err = writeAll(conn, []byte{0, 0, 0, 0, 32, 24, 0, 1, 0, 255, 0, 255, 0, 255, 16, 8, 0, 0, 0, 0, 2, 0, 0, 3, 0, 0, 0, 0, 255, 255, 255, 33, 255, 255, 254, 204}); err != nil {
		return nil, err
	}
	if err = conn.SetDeadline(time.Time{}); err != nil {
		return nil, err
	}
	b := &Backend{conn: conn, updated: make(chan struct{}, 1), done: make(chan struct{})}
	b.setLayout(connect.DesktopLayout{Width: w, Height: h, Screens: []connect.Screen{{Width: w, Height: h}}})
	go func() {
		err := b.readLoop()
		b.mu.Lock()
		b.err = err
		b.mu.Unlock()
		_ = conn.Close()
		close(b.done)
	}()
	return b, nil
}

func (b *Backend) readLoop() error {
	for {
		var kind [1]byte
		if _, err := io.ReadFull(b.conn, kind[:]); err != nil {
			return err
		}
		switch kind[0] {
		case 0:
			var header [3]byte
			if _, err := io.ReadFull(b.conn, header[:]); err != nil {
				return err
			}
			count := binary.BigEndian.Uint16(header[1:])
			if header[0] != 0 || count > 4096 {
				return errors.New("invalid helper update")
			}
			changed := false
			for range count {
				var rect [12]byte
				if _, err := io.ReadFull(b.conn, rect[:]); err != nil {
					return err
				}
				x, y, w, h := int(binary.BigEndian.Uint16(rect[:])), int(binary.BigEndian.Uint16(rect[2:])), int(binary.BigEndian.Uint16(rect[4:])), int(binary.BigEndian.Uint16(rect[6:]))
				encoding := int32(binary.BigEndian.Uint32(rect[8:]))
				switch encoding {
				case -223:
					layout := connect.DesktopLayout{Width: w, Height: h, Screens: []connect.Screen{{Width: w, Height: h}}}
					if x != 0 || y != 0 {
						return errors.New("invalid helper desktop size")
					}
					if err := layout.Validate(); err != nil {
						return err
					}
					b.mu.Lock()
					b.setLayout(layout)
					b.mu.Unlock()
				case -308:
					if err := b.readDesktopLayout(x, y, w, h); err != nil {
						return err
					}
				case 0:
					b.mu.Lock()
					valid := w > 0 && h > 0 && x <= b.canvas.Width-w && y <= b.canvas.Height-h
					b.mu.Unlock()
					if !valid {
						return errors.New("invalid helper rectangle")
					}
					pixels := make([]byte, w*h*4)
					if _, err := io.ReadFull(b.conn, pixels); err != nil {
						return err
					}
					for i := 0; i < len(pixels); i += 4 {
						pixels[i], pixels[i+2] = pixels[i+2], pixels[i]
						pixels[i+3] = 255
					}
					b.mu.Lock()
					for row := 0; row < h; row++ {
						copy(b.canvas.Pixels[(y+row)*b.canvas.Stride+x*4:], pixels[row*w*4:(row+1)*w*4])
						if b.missing > 0 {
							for col := x; col < x+w; col++ {
								index := (y+row)*b.canvas.Width + col
								mask := uint64(1) << uint(index%64)
								if b.coverage[index/64]&mask == 0 {
									b.coverage[index/64] |= mask
									b.missing--
								}
							}
						}
					}
					b.mu.Unlock()
					changed = true
				default:
					return fmt.Errorf("unsupported capture helper encoding %d", encoding)
				}
			}
			b.mu.Lock()
			if changed && b.missing == 0 {
				b.publishCanvas()
				b.coverage = nil
			}
			b.pending = false
			b.mu.Unlock()
			select {
			case b.updated <- struct{}{}:
			default:
			}

		case 2: // Bell has no payload.
		case 3:
			var header [7]byte
			if _, err := io.ReadFull(b.conn, header[:]); err != nil {
				return err
			}
			n := binary.BigEndian.Uint32(header[3:])
			if header[0] != 0 || header[1] != 0 || header[2] != 0 || n > 1<<20 {
				return errors.New("invalid helper clipboard")
			}
			if _, err := io.CopyN(io.Discard, b.conn, int64(n)); err != nil {
				return err
			}
		default:
			return fmt.Errorf("unsupported capture helper message %d", kind[0])
		}
	}
}

// setLayout runs under mu (or before the reader starts). Keep the last valid
// snapshot until every pixel in a new framebuffer has arrived.
func (b *Backend) setLayout(layout connect.DesktopLayout) {
	if b.canvas.Width != layout.Width || b.canvas.Height != layout.Height {
		b.canvas = connect.Frame{Width: layout.Width, Height: layout.Height, Stride: layout.Width * 4, Pixels: make([]byte, layout.Width*layout.Height*4)}
		b.missing = layout.Width * layout.Height
		b.coverage = make([]uint64, (b.missing+63)/64)
	}
	b.canvas.Screens = append([]connect.Screen(nil), layout.Screens...)
	if b.missing == 0 && !b.frame.DesktopLayout().Equal(layout) {
		b.publishCanvas()
	}
}

// publishCanvas runs under mu. The reader keeps mutating canvas across
// rectangles, so a published snapshot must own separate pixel storage.
func (b *Backend) publishCanvas() {
	b.canvas.Sequence = b.frame.Sequence + 1
	b.frame = b.canvas
	b.frame.Pixels = bytes.Clone(b.canvas.Pixels)
	b.frame.Screens = append([]connect.Screen(nil), b.canvas.Screens...)
}

func (b *Backend) readDesktopLayout(reason, status, width, height int) error {
	var header [4]byte
	if _, err := io.ReadFull(b.conn, header[:]); err != nil {
		return err
	}
	// Unknown reasons are server-side changes; status is defined only for a
	// response to this client's request. Padding and failed layouts are undefined.
	if reason != 1 {
		status = 0
	}
	if status == 0 && int(header[0]) > connect.MaxScreens {
		return errors.New("invalid helper extended desktop screen count")
	}
	layout := connect.DesktopLayout{Width: width, Height: height, Screens: make([]connect.Screen, int(header[0]))}
	for i := range layout.Screens {
		var screen [16]byte
		if _, err := io.ReadFull(b.conn, screen[:]); err != nil {
			return err
		}
		layout.Screens[i] = connect.Screen{ID: binary.BigEndian.Uint32(screen[:]), X: int(binary.BigEndian.Uint16(screen[4:])), Y: int(binary.BigEndian.Uint16(screen[6:])), Width: int(binary.BigEndian.Uint16(screen[8:])), Height: int(binary.BigEndian.Uint16(screen[10:])), Flags: binary.BigEndian.Uint32(screen[12:])}
	}
	if status == 0 {
		if err := layout.Validate(); err != nil {
			return err
		}
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	if status == 0 {
		b.resizeSupported = true
		b.setLayout(layout)
	}
	if reason == 1 && b.resizeReply != nil {
		var err error
		switch status {
		case 1:
			err = connect.ErrResizeProhibited
		case 2:
			err = errors.New("capture helper has insufficient resources to resize")
		case 3:
			err = fmt.Errorf("%w: capture helper rejected desktop layout", connect.ErrResizeUnsupported)
		case 4:
			err = errResizeForwarded
		default:
			if status != 0 {
				err = fmt.Errorf("capture helper resize failed with status %d", status)
			}
		}
		b.resizeReply <- err
		b.resizeReply = nil
	}
	return nil
}

func (b *Backend) DesktopResizeSupported() bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.resizeSupported
}

func (b *Backend) ResizeDesktop(ctx context.Context, layout connect.DesktopLayout) error {
	if err := layout.Validate(); err != nil {
		return err
	}
	b.resizeMu.Lock()
	defer b.resizeMu.Unlock()
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	if err := ctx.Err(); err != nil {
		return err
	}
	reply := make(chan error, 1)
	b.mu.Lock()
	if !b.resizeSupported {
		b.mu.Unlock()
		return connect.ErrResizeUnsupported
	}
	b.resizeReply = reply
	b.mu.Unlock()
	defer func() {
		b.mu.Lock()
		if b.resizeReply == reply {
			b.resizeReply = nil
		}
		b.mu.Unlock()
	}()
	request := make([]byte, 8+16*len(layout.Screens))
	request[0] = 251
	binary.BigEndian.PutUint16(request[2:], uint16(layout.Width))
	binary.BigEndian.PutUint16(request[4:], uint16(layout.Height))
	request[6] = byte(len(layout.Screens))
	for i, screen := range layout.Screens {
		p := request[8+16*i:]
		binary.BigEndian.PutUint32(p, screen.ID)
		binary.BigEndian.PutUint16(p[4:], uint16(screen.X))
		binary.BigEndian.PutUint16(p[6:], uint16(screen.Y))
		binary.BigEndian.PutUint16(p[8:], uint16(screen.Width))
		binary.BigEndian.PutUint16(p[10:], uint16(screen.Height))
		binary.BigEndian.PutUint32(p[12:], screen.Flags)
	}
	if err := b.write(ctx, request); err != nil {
		_ = b.conn.Close()
		return err
	}
	select {
	case err := <-reply:
		if errors.Is(err, errResizeForwarded) {
			err = b.awaitForwardedResize(ctx, layout)
			if err != nil {
				_ = b.conn.Close()
			}
			return err
		}
		if err != nil {
			return err
		}
		_, err = b.capture(ctx, true)
		if err != nil {
			_ = b.conn.Close()
		}
		return err
	case <-b.done:
		return b.readError()
	case <-ctx.Done():
		// RFB has no request identifier. A late reply must never acknowledge a
		// subsequent resize after this request times out.
		_ = b.conn.Close()
		return ctx.Err()
	}
}

// A forwarded request is acknowledged before the compositor applies it. Drive
// incremental updates until the actual layout and its complete pixels arrive.
func (b *Backend) awaitForwardedResize(ctx context.Context, requested connect.DesktopLayout) error {
	for {
		frame, err := b.Capture(ctx)
		if err != nil {
			return err
		}
		if frame.DesktopLayout().Equal(requested) {
			return nil
		}
		select {
		case <-b.updated:
		case <-b.done:
			return b.readError()
		case <-ctx.Done():
			return ctx.Err()
		}
	}
}

func (b *Backend) readError() error {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.err
}

func (b *Backend) Capture(ctx context.Context) (connect.Frame, error) {
	return b.capture(ctx, false)
}

func (b *Backend) capture(ctx context.Context, requireCurrent bool) (connect.Frame, error) {
	b.captureMu.Lock()
	defer b.captureMu.Unlock()
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	waiting := false
	for {
		if err := ctx.Err(); err != nil {
			return connect.Frame{}, err
		}
		select {
		case <-b.done:
			return connect.Frame{}, b.readError()
		default:
		}
		b.mu.Lock()
		if (requireCurrent || waiting) && b.frame.Sequence != 0 && (!requireCurrent || b.missing == 0) {
			frame := b.frame
			frame.Pixels = bytes.Clone(frame.Pixels)
			frame.Screens = append([]connect.Screen(nil), frame.Screens...)
			b.mu.Unlock()
			return frame, nil
		}
		requestNeeded := !b.pending
		request := make([]byte, 10)
		request[0] = 3
		if b.missing == 0 {
			request[1] = 1
		}
		binary.BigEndian.PutUint16(request[6:], uint16(b.canvas.Width))
		binary.BigEndian.PutUint16(request[8:], uint16(b.canvas.Height))
		if requestNeeded {
			b.pending = true
		}
		b.mu.Unlock()
		if requestNeeded {
			if err := b.write(ctx, request); err != nil {
				_ = b.conn.Close()
				return connect.Frame{}, err
			}
		}
		b.mu.Lock()
		frame := b.frame
		ready := frame.Sequence != 0 && (!requireCurrent || b.missing == 0)
		if ready {
			frame.Pixels = bytes.Clone(frame.Pixels)
			frame.Screens = append([]connect.Screen(nil), frame.Screens...)
		}
		b.mu.Unlock()
		if ready {
			return frame, nil
		}
		select {
		case <-b.updated:
			waiting = true
		case <-b.done:
			return connect.Frame{}, b.readError()
		case <-ctx.Done():
			return connect.Frame{}, ctx.Err()
		}
	}
}

func (b *Backend) Key(ctx context.Context, event connect.KeyEvent) error {
	p := make([]byte, 8)
	p[0] = 4
	if event.Down {
		p[1] = 1
	}
	binary.BigEndian.PutUint32(p[4:], event.Keysym)
	return b.write(ctx, p)
}
func (b *Backend) Pointer(ctx context.Context, event connect.PointerEvent) error {
	p := []byte{5, event.ButtonMask, 0, 0, 0, 0}
	binary.BigEndian.PutUint16(p[2:], event.X)
	binary.BigEndian.PutUint16(p[4:], event.Y)
	return b.write(ctx, p)
}
func (b *Backend) write(ctx context.Context, p []byte) error {
	b.writeMu.Lock()
	defer b.writeMu.Unlock()
	if err := ctx.Err(); err != nil {
		return err
	}
	deadline := time.Now().Add(5 * time.Second)
	if d, ok := ctx.Deadline(); ok && d.Before(deadline) {
		deadline = d
	}
	if err := b.conn.SetWriteDeadline(deadline); err != nil {
		return err
	}
	return writeAll(b.conn, p)
}
func (b *Backend) Close() error { err := b.conn.Close(); <-b.done; return err }
func writeAll(w io.Writer, p []byte) error {
	for len(p) > 0 {
		n, err := w.Write(p)
		if err != nil {
			return err
		}
		if n == 0 {
			return io.ErrShortWrite
		}
		p = p[n:]
	}
	return nil
}
