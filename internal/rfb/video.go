package rfb

import (
	"context"
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
