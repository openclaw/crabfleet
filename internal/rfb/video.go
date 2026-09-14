package rfb

import (
	"context"
	"crypto/sha256"
	"encoding/binary"
	"errors"

	"github.com/openclaw/crabfleet/internal/connect"
)

func encodeVideoRectangle(ctx context.Context, config SessionConfig, e Encodings, frame connect.Frame) ([]byte, error) {
	if config.Video != nil && frame.Width%2 == 0 && frame.Height%2 == 0 {
		for _, candidate := range []struct {
			enabled  bool
			name     string
			encoding int32
		}{{e.HEVC, "hevc", EncodingHEVC}, {e.H264, "h264", EncodingH264}} {
			if !candidate.enabled {
				continue
			}
			payload, err := config.Video.Encode(ctx, frame, candidate.name)
			if err != nil {
				continue
			}
			if len(payload) == 0 || len(payload) >= 16<<20 {
				return nil, errors.New("invalid encoded video length")
			}
			p, err := appendRectangleHeader(nil, 0, 0, frame.Width, frame.Height, candidate.encoding)
			if err != nil {
				return nil, err
			}
			p = binary.BigEndian.AppendUint32(p, uint32(len(payload)))
			// Decoder reset flags are applied by the per-viewer delivery state.
			p = binary.BigEndian.AppendUint32(p, 0)
			return append(p, payload...), nil
		}
	}
	if e.Tight {
		p, err := EncodeJPEG(frame, config.JPEGQuality)
		if err != nil {
			return nil, err
		}
		return tightJPEGRectangle(frame.Width, frame.Height, p)
	}
	if !e.Raw {
		return nil, errors.New("no supported video encoding")
	}
	p, err := appendRectangleHeader(nil, 0, 0, frame.Width, frame.Height, EncodingRaw)
	if err != nil {
		return nil, err
	}
	for y := 0; y < frame.Height; y++ {
		for x := 0; x < frame.Width; x++ {
			i := y*frame.Stride + x*4
			p = append(p, frame.Pixels[i+2], frame.Pixels[i+1], frame.Pixels[i], 0)
		}
	}
	return p, nil
}

// Decoder context belongs to a viewer, even when its encoder is shared. Only
// commit a prepared context after its complete framebuffer update was sent.
type videoContext struct {
	encoding      int32
	width, height uint16
	parameters    [sha256.Size]byte
}

type videoSession struct {
	delivered    videoContext
	resetPending bool
}

func (session *videoSession) prepare(rectangle []byte) videoContext {
	next := videoContext{encoding: int32(binary.BigEndian.Uint32(rectangle[8:])), width: binary.BigEndian.Uint16(rectangle[4:]), height: binary.BigEndian.Uint16(rectangle[6:])}
	if next.encoding == EncodingH264 || next.encoding == EncodingHEVC {
		next.parameters = videoParameterFingerprint(rectangle[20:], next.encoding)
		if session.resetPending || next != session.delivered {
			binary.BigEndian.PutUint32(rectangle[16:], binary.BigEndian.Uint32(rectangle[16:])|0x2)
		}
	}
	return next
}

func (session *videoSession) sent(next videoContext) {
	session.delivered = next
	session.resetPending = false
}

// Independent encoder frames repeat their parameter sets. Fingerprint only
// those NAL units so pixel content and access-unit delimiters do not reset a
// decoder, while a same-size encoder/backend change reaches every viewer.
func videoParameterFingerprint(payload []byte, encoding int32) [sha256.Size]byte {
	fingerprint := sha256.New()
	start := -1
	appendParameters := func(end int) {
		if start < 0 || start >= end {
			return
		}
		for end > start && payload[end-1] == 0 {
			end--
		}
		if start >= end {
			return
		}
		nalType := payload[start] & 0x1f
		parameter := nalType == 7 || nalType == 8
		if encoding == EncodingHEVC {
			nalType = (payload[start] >> 1) & 0x3f
			parameter = nalType == 32 || nalType == 33 || nalType == 34
		}
		if !parameter {
			return
		}
		var length [4]byte
		binary.BigEndian.PutUint32(length[:], uint32(end-start))
		_, _ = fingerprint.Write(length[:])
		_, _ = fingerprint.Write(payload[start:end])
	}
	for i := 0; i+2 < len(payload); i++ {
		if payload[i] != 0 || payload[i+1] != 0 {
			continue
		}
		prefix := 0
		if payload[i+2] == 1 {
			prefix = 3
		} else if i+3 < len(payload) && payload[i+2] == 0 && payload[i+3] == 1 {
			prefix = 4
		}
		if prefix == 0 {
			continue
		}
		appendParameters(i)
		start = i + prefix
		i = start - 1
	}
	appendParameters(len(payload))
	var result [sha256.Size]byte
	copy(result[:], fingerprint.Sum(nil))
	return result
}
