package rfb

import (
	"context"
	"encoding/binary"
	"errors"
	"io"

	"github.com/openclaw/crabfleet/internal/connect"
)

// A complete request is bounded by its one-byte screen count. Invalid layouts
// are consumed before replying so subsequent client messages remain framed.
func parseSetDesktopSize(reader io.Reader) (connect.DesktopLayout, error) {
	var header [7]byte
	if _, err := io.ReadFull(reader, header[:]); err != nil {
		return connect.DesktopLayout{}, err
	}
	layout := connect.DesktopLayout{Width: int(binary.BigEndian.Uint16(header[1:])), Height: int(binary.BigEndian.Uint16(header[3:]))}
	count := int(header[5])
	payload := make([]byte, count*16)
	if _, err := io.ReadFull(reader, payload); err != nil {
		return connect.DesktopLayout{}, err
	}
	if header[0] != 0 || header[6] != 0 || count > connect.MaxScreens {
		return layout, nil
	}
	for offset := 0; offset < len(payload); offset += 16 {
		p := payload[offset:]
		layout.Screens = append(layout.Screens, connect.Screen{ID: binary.BigEndian.Uint32(p), X: int(binary.BigEndian.Uint16(p[4:])), Y: int(binary.BigEndian.Uint16(p[6:])), Width: int(binary.BigEndian.Uint16(p[8:])), Height: int(binary.BigEndian.Uint16(p[10:])), Flags: binary.BigEndian.Uint32(p[12:])})
	}
	return layout, nil
}

func desktopSizeUpdate(layout connect.DesktopLayout, extended bool, reason, status int) ([]byte, error) {
	if err := layout.Validate(); err != nil {
		return nil, err
	}
	encoding := EncodingDesktopSize
	if extended {
		encoding = EncodingExtendedDesktopSize
	}
	rect, err := appendRectangleHeader(nil, reason, status, layout.Width, layout.Height, encoding)
	if err != nil {
		return nil, err
	}
	if extended {
		rect = append(rect, byte(len(layout.Screens)), 0, 0, 0)
		for _, screen := range layout.Screens {
			rect = binary.BigEndian.AppendUint32(rect, screen.ID)
			rect = binary.BigEndian.AppendUint16(rect, uint16(screen.X))
			rect = binary.BigEndian.AppendUint16(rect, uint16(screen.Y))
			rect = binary.BigEndian.AppendUint16(rect, uint16(screen.Width))
			rect = binary.BigEndian.AppendUint16(rect, uint16(screen.Height))
			rect = binary.BigEndian.AppendUint32(rect, screen.Flags)
		}
	}
	return framebufferUpdate(rect)
}

// Shared servers hold the capture coordinator through both mode application and
// snapshotting, so another viewer cannot replace this request's acknowledgement.
func resizeDesktopFrame(ctx context.Context, backend connect.Backend, resizer connect.DesktopResizer, requested connect.DesktopLayout) (connect.Frame, error) {
	var frame connect.Frame
	var err error
	if source, ok := backend.(interface {
		resizeDesktopFrame(context.Context, connect.DesktopLayout) (connect.Frame, error)
	}); ok {
		frame, err = source.resizeDesktopFrame(ctx, requested)
	} else {
		err = resizer.ResizeDesktop(ctx, requested)
		if err == nil {
			frame, err = backend.Capture(ctx)
		}
	}
	if err != nil {
		return connect.Frame{}, err
	}
	if err = frame.Validate(); err != nil {
		return connect.Frame{}, err
	}
	if !frame.DesktopLayout().Equal(requested) {
		return connect.Frame{}, errors.New("desktop changed before resize acknowledgement")
	}
	return frame, nil
}
