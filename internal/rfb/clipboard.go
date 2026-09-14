package rfb

import (
	"bytes"
	"compress/zlib"
	"context"
	"encoding/binary"
	"errors"
	"io"
	"strings"
	"unicode/utf8"

	"github.com/openclaw/crabfleet/internal/connect"
)

const (
	clipboardText    uint32 = 1
	clipboardCaps    uint32 = 1 << 24
	clipboardRequest uint32 = 1 << 25
	clipboardPeek    uint32 = 1 << 26
	clipboardNotify  uint32 = 1 << 27
	clipboardProvide uint32 = 1 << 28
)

type clipboardSession struct {
	source                          connect.Clipboard
	viewOnly, extended, initialized bool
	last                            string
	observed                        string
	peerActions, peerMaximum        uint32
}

func clipboardFrame(body []byte, extended bool) []byte {
	p := make([]byte, 8)
	p[0] = 3
	n := int32(len(body))
	if extended {
		n = -n
	}
	binary.BigEndian.PutUint32(p[4:], uint32(n))
	return append(p, body...)
}
func clipboardAction(action uint32) []byte {
	return clipboardFrame(binary.BigEndian.AppendUint32(nil, action), true)
}
func (s *clipboardSession) capabilities() []byte {
	p := binary.BigEndian.AppendUint32(nil, clipboardCaps|clipboardRequest|clipboardPeek|clipboardNotify|clipboardProvide|clipboardText)
	p = binary.BigEndian.AppendUint32(p, maxLegacyClipboardBytes)
	return clipboardFrame(p, true)
}
func (s *clipboardSession) poll(ctx context.Context) ([]byte, error) {
	if s.source == nil {
		return nil, nil
	}
	text, err := s.source.ReadClipboard(ctx)
	if err != nil {
		return nil, nil
	}
	if len(text) >= maxLegacyClipboardBytes || !utf8.ValidString(text) || strings.ContainsRune(text, 0) {
		return nil, nil
	}
	if !s.initialized {
		s.initialized = true
		s.observed = text
		return nil, nil
	}
	if text == s.observed {
		return nil, nil
	}
	s.last = text
	s.observed = text
	if s.extended {
		if s.peerActions&clipboardNotify != 0 {
			return clipboardAction(clipboardNotify | clipboardText), nil
		}
		if s.peerActions&clipboardProvide != 0 {
			return s.provide()
		}
		return nil, nil
	}
	var p []byte
	for _, r := range text {
		if r > 255 {
			return nil, nil
		}
		p = append(p, byte(r))
	}
	return clipboardFrame(p, false), nil
}
func (s *clipboardSession) provide() ([]byte, error) {
	text := strings.ReplaceAll(s.last, "\r\n", "\n") + "\x00"
	if len(text) > maxLegacyClipboardBytes || uint32(len(text)) > s.peerMaximum {
		return nil, nil
	}
	var compressed bytes.Buffer
	w := zlib.NewWriter(&compressed)
	if err := writeFull(w, binary.BigEndian.AppendUint32(nil, uint32(len(text)))); err != nil {
		return nil, err
	}
	if err := writeFull(w, []byte(text)); err != nil {
		return nil, err
	}
	if err := w.Close(); err != nil {
		return nil, err
	}
	return clipboardFrame(append(binary.BigEndian.AppendUint32(nil, clipboardProvide|clipboardText), compressed.Bytes()...), true), nil
}
func (s *clipboardSession) receive(ctx context.Context, r io.Reader) ([]byte, error) {
	var header [7]byte
	if _, err := io.ReadFull(r, header[:]); err != nil {
		return nil, err
	}
	if header[0] != 0 || header[1] != 0 || header[2] != 0 {
		return nil, errors.New("invalid clipboard padding")
	}
	signed := int64(int32(binary.BigEndian.Uint32(header[3:])))
	n := signed
	if n < 0 {
		n = -n
	}
	limit := int64(maxLegacyClipboardBytes)
	if signed < 0 {
		limit = maxExtendedClipboardBody
	}
	if n > limit {
		return nil, errors.New("clipboard payload too large")
	}
	p := make([]byte, int(n))
	if _, err := io.ReadFull(r, p); err != nil {
		return nil, err
	}
	var text string
	if signed >= 0 {
		runes := make([]rune, len(p))
		for i, c := range p {
			runes[i] = rune(c)
		}
		text = string(runes)
	} else {
		if !s.extended || len(p) < 4 {
			return nil, errors.New("extended clipboard was not negotiated")
		}
		flags := binary.BigEndian.Uint32(p)
		action := flags & 0xff000000
		if action&clipboardCaps != 0 {
			if len(p) != 8 || flags&0xffffff != 1 {
				return nil, errors.New("invalid clipboard capabilities")
			}
			s.peerActions = action
			s.peerMaximum = min(binary.BigEndian.Uint32(p[4:]), uint32(maxLegacyClipboardBytes))
			return nil, nil
		}
		if flags&0xffffff > 1 {
			return nil, errors.New("unsupported clipboard format")
		}
		switch action {
		case clipboardPeek:
			if len(p) != 4 {
				return nil, errors.New("invalid clipboard peek")
			}
			f := clipboardNotify
			if s.last != "" {
				f |= clipboardText
			}
			return clipboardAction(f), nil
		case clipboardNotify:
			if len(p) != 4 {
				return nil, errors.New("invalid clipboard notify")
			}
			if flags&clipboardText != 0 && !s.viewOnly && s.source != nil {
				return clipboardAction(clipboardRequest | clipboardText), nil
			}
			return nil, nil
		case clipboardRequest:
			if len(p) != 4 {
				return nil, errors.New("invalid clipboard request")
			}
			if flags&clipboardText != 0 {
				return s.provide()
			}
			return nil, nil
		case clipboardProvide:
			if flags&clipboardText == 0 {
				return nil, errors.New("clipboard text format required")
			}
			z, err := zlib.NewReader(bytes.NewReader(p[4:]))
			if err != nil {
				return nil, errors.New("invalid clipboard compression")
			}
			decoded, err := io.ReadAll(io.LimitReader(z, maxLegacyClipboardBytes+5))
			closeErr := z.Close()
			if err != nil || closeErr != nil || len(decoded) < 5 || len(decoded) > maxLegacyClipboardBytes+4 {
				return nil, errors.New("invalid clipboard data")
			}
			n := binary.BigEndian.Uint32(decoded)
			if n == 0 || int(n) != len(decoded)-4 || decoded[len(decoded)-1] != 0 || !utf8.Valid(decoded[4:len(decoded)-1]) {
				return nil, errors.New("invalid clipboard text")
			}
			text = string(decoded[4 : len(decoded)-1])
			if strings.ContainsRune(text, 0) {
				return nil, errors.New("invalid clipboard text")
			}
		default:
			return nil, errors.New("invalid clipboard action")
		}
	}
	if s.source != nil && !s.viewOnly {
		text = strings.ReplaceAll(text, "\r\n", "\n")
		if err := s.source.WriteClipboard(ctx, text); err != nil {
			return nil, nil
		}
		s.last = text
		s.observed = text
		s.initialized = true
	}
	return nil, nil
}
