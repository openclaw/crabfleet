package rfb

import (
	"bytes"
	"encoding/binary"
	"errors"
	"image"
	"image/jpeg"

	"github.com/openclaw/crabfleet/internal/connect"
)

func EncodeJPEG(frame connect.Frame, quality int) ([]byte, error) {
	if err := frame.Validate(); err != nil {
		return nil, err
	}
	if quality < 1 || quality > 100 {
		return nil, errors.New("JPEG quality must be between 1 and 100")
	}
	input := &image.RGBA{
		Pix:    frame.Pixels,
		Stride: frame.Stride,
		Rect:   image.Rect(0, 0, frame.Width, frame.Height),
	}
	// Tight compact lengths are limited to 22 bits. Reduce quality before
	// failing a valid frame so high-entropy captures stay on the negotiated
	// full-frame path expected by the existing Crabfleet clients.
	qualities := []int{quality}
	for candidate := quality - 10; candidate > 1; candidate -= 10 {
		qualities = append(qualities, candidate)
	}
	if qualities[len(qualities)-1] != 1 {
		qualities = append(qualities, 1)
	}
	for _, candidate := range qualities {
		var output bytes.Buffer
		if err := jpeg.Encode(&output, input, &jpeg.Options{Quality: candidate}); err != nil {
			return nil, err
		}
		if output.Len() > 0 && output.Len() < MaxTightJPEGLength {
			return output.Bytes(), nil
		}
	}
	return nil, errors.New("Tight JPEG exceeds protocol bounds at minimum quality")
}

func TightCompactLength(length int) ([]byte, error) {
	if length < 0 || length >= MaxTightJPEGLength {
		return nil, errors.New("invalid Tight length")
	}
	remaining := length
	result := []byte{byte(remaining & 0x7f)}
	remaining >>= 7
	if remaining == 0 {
		return result, nil
	}
	result[0] |= 0x80
	result = append(result, byte(remaining&0x7f))
	remaining >>= 7
	if remaining == 0 {
		return result, nil
	}
	result[1] |= 0x80
	return append(result, byte(remaining&0xff)), nil
}

func tightJPEGRectangle(width, height int, payload []byte) ([]byte, error) {
	// Crabfleet's Tight/JPEG profile is intentionally one full-frame rectangle,
	// matching the Swift host. The TypeScript client requires origin 0,0 and
	// presents the rectangle as a complete decoded video frame, so generic Tight
	// tiling would be wire-incompatible with existing peers.
	if width < 1 || width > 65_535 || height < 1 || height > 65_535 || len(payload) == 0 || len(payload) >= MaxTightJPEGLength {
		return nil, errors.New("invalid Tight JPEG frame")
	}
	compact, err := TightCompactLength(len(payload))
	if err != nil {
		return nil, err
	}
	result, err := appendRectangleHeader(nil, 0, 0, width, height, EncodingTight)
	if err != nil {
		return nil, err
	}
	result = append(result, 0x90)
	result = append(result, compact...)
	return append(result, payload...), nil
}

func framebufferUpdate(rectangles ...[]byte) ([]byte, error) {
	if len(rectangles) > 65_535 {
		return nil, errors.New("too many framebuffer rectangles")
	}
	result := make([]byte, 4)
	binary.BigEndian.PutUint16(result[2:], uint16(len(rectangles)))
	for _, rectangle := range rectangles {
		result = append(result, rectangle...)
	}
	return result, nil
}

func cursorRectangle(cursor connect.Cursor, encoding int32) ([]byte, error) {
	if !cursor.Visible {
		result, err := appendRectangleHeader(nil, 0, 0, 0, 0, encoding)
		if err != nil {
			return nil, err
		}
		if encoding == EncodingCursorWithAlpha {
			result = append(result, 0, 0, 0, 0)
		}
		return result, nil
	}
	result, err := appendRectangleHeader(nil, cursor.HotspotX, cursor.HotspotY, cursor.Width, cursor.Height, encoding)
	if err != nil {
		return nil, err
	}
	if encoding == EncodingCursorWithAlpha {
		result = append(result, 0, 0, 0, 0)
		return append(result, cursor.RGBA...), nil
	}
	if encoding != EncodingCursor {
		return nil, errors.New("unsupported cursor encoding")
	}
	maskStride := (cursor.Width + 7) / 8
	mask := make([]byte, maskStride*cursor.Height)
	for y := 0; y < cursor.Height; y++ {
		for x := 0; x < cursor.Width; x++ {
			offset := (y*cursor.Width + x) * 4
			alpha := cursor.RGBA[offset+3]
			result = append(result,
				unpremultiply(cursor.RGBA[offset+2], alpha),
				unpremultiply(cursor.RGBA[offset+1], alpha),
				unpremultiply(cursor.RGBA[offset], alpha),
				0,
			)
			if alpha >= 0x80 {
				mask[y*maskStride+x/8] |= 0x80 >> (x % 8)
			}
		}
	}
	return append(result, mask...), nil
}

func pointerPositionRectangle(x, y int) ([]byte, error) {
	return appendRectangleHeader(nil, x, y, 0, 0, EncodingPointerPosition)
}

func unpremultiply(component, alpha byte) byte {
	if alpha == 0 {
		return 0
	}
	value := (int(component)*255 + int(alpha)/2) / int(alpha)
	if value > 255 {
		return 255
	}
	return byte(value)
}
