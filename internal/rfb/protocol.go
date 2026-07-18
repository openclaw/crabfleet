// Package rfb implements the host side of Crabfleet's RFB 3.8 profile.
package rfb

import (
	"bytes"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
)

const (
	SecurityVNC = 2
	SecurityARD = 30

	EncodingTight           int32 = 7
	EncodingPointerPosition int32 = -232
	EncodingCursor          int32 = -239
	EncodingCursorWithAlpha int32 = -314

	MaxEncodings       = 256
	MaxDesktopName     = 4096
	MaxSecurityReason  = 4096
	MaxTightJPEGLength = 1 << 22
)

var (
	Version38Banner = []byte("RFB 003.008\n")
	bgra8888        = []byte{
		32, 24, 0, 1,
		0, 255, 0, 255, 0, 255,
		16, 8, 0,
		0, 0, 0,
	}
)

type Encodings struct {
	Tight           bool
	CursorWithAlpha bool
	Cursor          bool
	PointerPosition bool
}

func (e Encodings) cursorEncoding() int32 {
	if e.CursorWithAlpha {
		return EncodingCursorWithAlpha
	}
	if e.Cursor {
		return EncodingCursor
	}
	return 0
}

func ServerInit(width, height int, name string) ([]byte, error) {
	if width < 1 || width > 65_535 || height < 1 || height > 65_535 {
		return nil, errors.New("invalid framebuffer dimensions")
	}
	nameBytes := []byte(name)
	if len(nameBytes) > MaxDesktopName {
		return nil, errors.New("desktop name is too long")
	}
	result := make([]byte, 24+len(nameBytes))
	binary.BigEndian.PutUint16(result, uint16(width))
	binary.BigEndian.PutUint16(result[2:], uint16(height))
	copy(result[4:20], bgra8888)
	binary.BigEndian.PutUint32(result[20:], uint32(len(nameBytes)))
	copy(result[24:], nameBytes)
	return result, nil
}

func parseSetPixelFormat(reader io.Reader) error {
	payload := make([]byte, 19)
	if _, err := io.ReadFull(reader, payload); err != nil {
		return err
	}
	format := payload[3:]
	if payload[0] != 0 || payload[1] != 0 || payload[2] != 0 || format[3] == 0 ||
		!bytes.Equal(format[:3], bgra8888[:3]) || !bytes.Equal(format[4:], bgra8888[4:]) {
		return errors.New("only 24-bit true-color BGRA pixels are supported")
	}
	return nil
}

func parseSetEncodings(reader io.Reader) (Encodings, error) {
	header := make([]byte, 3)
	if _, err := io.ReadFull(reader, header); err != nil {
		return Encodings{}, err
	}
	if header[0] != 0 {
		return Encodings{}, errors.New("invalid SetEncodings padding")
	}
	count := int(binary.BigEndian.Uint16(header[1:]))
	if count > MaxEncodings {
		return Encodings{}, errors.New("too many requested encodings")
	}
	payload := make([]byte, count*4)
	if _, err := io.ReadFull(reader, payload); err != nil {
		return Encodings{}, err
	}
	var result Encodings
	for offset := 0; offset < len(payload); offset += 4 {
		switch int32(binary.BigEndian.Uint32(payload[offset:])) {
		case EncodingTight:
			result.Tight = true
		case EncodingCursorWithAlpha:
			result.CursorWithAlpha = true
		case EncodingCursor:
			result.Cursor = true
		case EncodingPointerPosition:
			result.PointerPosition = true
		}
	}
	return result, nil
}

type framebufferRequest struct {
	Incremental bool
	X           uint16
	Y           uint16
	Width       uint16
	Height      uint16
}

func parseFramebufferRequest(reader io.Reader, frameWidth, frameHeight int) (framebufferRequest, error) {
	payload := make([]byte, 9)
	if _, err := io.ReadFull(reader, payload); err != nil {
		return framebufferRequest{}, err
	}
	request := framebufferRequest{
		Incremental: payload[0] != 0,
		X:           binary.BigEndian.Uint16(payload[1:]),
		Y:           binary.BigEndian.Uint16(payload[3:]),
		Width:       binary.BigEndian.Uint16(payload[5:]),
		Height:      binary.BigEndian.Uint16(payload[7:]),
	}
	// The RFB rectangle is a hint. Its intersection with the framebuffer may
	// be empty, and oversized requests are cropped by the server. Crabfleet's
	// negotiated Tight profile still responds with one full-frame rectangle.
	_ = frameWidth
	_ = frameHeight
	return request, nil
}

func parseKeyEvent(reader io.Reader) (down bool, keysym uint32, err error) {
	payload := make([]byte, 7)
	if _, err = io.ReadFull(reader, payload); err != nil {
		return false, 0, err
	}
	if payload[1] != 0 || payload[2] != 0 {
		return false, 0, errors.New("invalid key event")
	}
	return payload[0] != 0, binary.BigEndian.Uint32(payload[3:]), nil
}

func parsePointerEvent(reader io.Reader, frameWidth, frameHeight int) (mask byte, x, y uint16, err error) {
	payload := make([]byte, 5)
	if _, err = io.ReadFull(reader, payload); err != nil {
		return 0, 0, 0, err
	}
	x = binary.BigEndian.Uint16(payload[1:])
	y = binary.BigEndian.Uint16(payload[3:])
	if int(x) >= frameWidth || int(y) >= frameHeight {
		return 0, 0, 0, errors.New("pointer event is outside the desktop")
	}
	return payload[0], x, y, nil
}

func appendRectangleHeader(dst []byte, x, y, width, height int, encoding int32) ([]byte, error) {
	if x < 0 || x > 65_535 || y < 0 || y > 65_535 || width < 0 || width > 65_535 || height < 0 || height > 65_535 {
		return nil, fmt.Errorf("invalid rectangle geometry %d,%d %dx%d", x, y, width, height)
	}
	start := len(dst)
	dst = append(dst, make([]byte, 12)...)
	binary.BigEndian.PutUint16(dst[start:], uint16(x))
	binary.BigEndian.PutUint16(dst[start+2:], uint16(y))
	binary.BigEndian.PutUint16(dst[start+4:], uint16(width))
	binary.BigEndian.PutUint16(dst[start+6:], uint16(height))
	binary.BigEndian.PutUint32(dst[start+8:], uint32(encoding))
	return dst, nil
}
