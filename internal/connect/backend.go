// Package connect defines capture and input backends for Crabfleet Connect.
package connect

import (
	"context"
	"errors"
	"fmt"
)

const (
	MaxDimension  = 65_535
	MaxDirtyRects = 256
	MaxFrameBytes = 256 * 1024 * 1024
)

var ErrClosed = errors.New("connect backend is closed")

// Rect is a pixel-space dirty rectangle.
type Rect struct {
	X      int
	Y      int
	Width  int
	Height int
}

// Frame contains tightly described, row-major RGBA pixels. Stride may include
// padding after each row. DirtyRects is advisory; an empty slice means the
// whole frame may have changed.
type Frame struct {
	Width      int
	Height     int
	Stride     int
	Pixels     []byte
	DirtyRects []Rect
	Sequence   uint64
}

func (f Frame) Validate() error {
	if f.Width < 1 || f.Width > MaxDimension || f.Height < 1 || f.Height > MaxDimension {
		return fmt.Errorf("invalid frame dimensions %dx%d", f.Width, f.Height)
	}
	minimumStride, ok := checkedMul(f.Width, 4)
	if !ok || f.Stride < minimumStride {
		return fmt.Errorf("invalid frame stride %d", f.Stride)
	}
	required, ok := checkedMul(f.Stride, f.Height)
	if !ok || required > MaxFrameBytes || len(f.Pixels) != required {
		return fmt.Errorf("invalid frame pixel length %d", len(f.Pixels))
	}
	if len(f.DirtyRects) > MaxDirtyRects {
		return fmt.Errorf("too many dirty rectangles: %d", len(f.DirtyRects))
	}
	for _, rect := range f.DirtyRects {
		if rect.X < 0 || rect.Y < 0 || rect.Width < 1 || rect.Height < 1 ||
			rect.X > f.Width-rect.Width || rect.Y > f.Height-rect.Height {
			return fmt.Errorf("dirty rectangle is outside the frame: %+v", rect)
		}
	}
	return nil
}

// PointerEvent uses the RFB button mask and framebuffer coordinates.
type PointerEvent struct {
	ButtonMask byte
	X          uint16
	Y          uint16
}

// KeyEvent uses an X11 keysym, as specified by RFB.
type KeyEvent struct {
	Down   bool
	Keysym uint32
}

type Capturer interface {
	Capture(context.Context) (Frame, error)
	Close() error
}

type InputSink interface {
	Pointer(context.Context, PointerEvent) error
	Key(context.Context, KeyEvent) error
	Close() error
}

type Backend interface {
	Capturer
	InputSink
}

// Cursor is an optional client-side cursor snapshot. RGBA pixels must be
// premultiplied and are bounded to the cursor limits used by Crabfleet clients.
type Cursor struct {
	Width    int
	Height   int
	HotspotX int
	HotspotY int
	X        int
	Y        int
	Visible  bool
	RGBA     []byte
}

func (c Cursor) Validate(frameWidth, frameHeight int) error {
	if !c.Visible {
		return nil
	}
	if c.Width < 1 || c.Width > 128 || c.Height < 1 || c.Height > 128 ||
		c.HotspotX < 0 || c.HotspotX >= c.Width || c.HotspotY < 0 || c.HotspotY >= c.Height {
		return errors.New("invalid cursor geometry")
	}
	length, ok := checkedMul(c.Width, c.Height)
	if !ok {
		return errors.New("invalid cursor dimensions")
	}
	length, ok = checkedMul(length, 4)
	if !ok || len(c.RGBA) != length {
		return errors.New("invalid cursor pixel length")
	}
	if c.X < 0 || c.X >= frameWidth || c.Y < 0 || c.Y >= frameHeight {
		return errors.New("cursor position is outside the frame")
	}
	for offset := 0; offset < len(c.RGBA); offset += 4 {
		alpha := c.RGBA[offset+3]
		if c.RGBA[offset] > alpha || c.RGBA[offset+1] > alpha || c.RGBA[offset+2] > alpha {
			return errors.New("cursor pixels are not premultiplied")
		}
	}
	return nil
}

type CursorCapturer interface {
	Cursor(context.Context) (Cursor, error)
}

func checkedMul(left, right int) (int, bool) {
	if left < 0 || right < 0 || (left != 0 && right > int(^uint(0)>>1)/left) {
		return 0, false
	}
	return left * right, true
}
