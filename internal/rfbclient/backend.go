// Package rfbclient adapts a private, authenticated capture helper to the common
// Crabfleet host. It deliberately requests only bounded raw framebuffer updates.
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

type Backend struct {
	conn                   net.Conn
	writeMu, captureMu, mu sync.Mutex
	frame                  connect.Frame
	updated                chan struct{}
	done                   chan struct{}
	err                    error
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
	if err = writeAll(conn, []byte{0, 0, 0, 0, 32, 24, 0, 1, 0, 255, 0, 255, 0, 255, 16, 8, 0, 0, 0, 0, 2, 0, 0, 1, 0, 0, 0, 0}); err != nil {
		return nil, err
	}
	if err = conn.SetDeadline(time.Time{}); err != nil {
		return nil, err
	}
	b := &Backend{conn: conn, frame: connect.Frame{Width: w, Height: h, Stride: w * 4, Pixels: make([]byte, w*h*4)}, updated: make(chan struct{}, 1), done: make(chan struct{})}
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
			for range count {
				var rect [12]byte
				if _, err := io.ReadFull(b.conn, rect[:]); err != nil {
					return err
				}
				x, y, w, h := int(binary.BigEndian.Uint16(rect[:])), int(binary.BigEndian.Uint16(rect[2:])), int(binary.BigEndian.Uint16(rect[4:])), int(binary.BigEndian.Uint16(rect[6:]))
				if binary.BigEndian.Uint32(rect[8:]) != 0 || w < 1 || h < 1 || x > b.frame.Width-w || y > b.frame.Height-h {
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
					copy(b.frame.Pixels[(y+row)*b.frame.Stride+x*4:], pixels[row*w*4:(row+1)*w*4])
				}
				b.mu.Unlock()
			}
			b.mu.Lock()
			b.frame.Sequence++
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

func (b *Backend) Capture(ctx context.Context) (connect.Frame, error) {
	b.captureMu.Lock()
	defer b.captureMu.Unlock()
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	request := make([]byte, 10)
	request[0] = 3
	binary.BigEndian.PutUint16(request[6:], uint16(b.frame.Width))
	binary.BigEndian.PutUint16(request[8:], uint16(b.frame.Height))
	if err := b.write(ctx, request); err != nil {
		return connect.Frame{}, err
	}
	select {
	case <-b.updated:
		b.mu.Lock()
		defer b.mu.Unlock()
		frame := b.frame
		frame.Pixels = bytes.Clone(frame.Pixels)
		return frame, nil
	case <-b.done:
		b.mu.Lock()
		defer b.mu.Unlock()
		return connect.Frame{}, b.err
	case <-ctx.Done():
		_ = b.conn.Close()
		return connect.Frame{}, ctx.Err()
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
