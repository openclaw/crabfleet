package connect

import "context"

const MaxClipboardBytes = 1 << 20

type Clipboard interface {
	ReadClipboard(context.Context) (string, error)
	WriteClipboard(context.Context, string) error
}

type AudioPacket struct {
	TimestampMS uint32
	Payload     []byte
}

// AudioSource emits raw AAC-LC access units at 48 kHz stereo. A subscription
// must stop when its context ends and close its channel after capture cleanup;
// slow subscribers lose packets, never block capture.
type AudioSource interface {
	Subscribe(context.Context) (<-chan AudioPacket, error)
}

type VideoEncoder interface {
	Encode(context.Context, Frame, string) ([]byte, error)
}
