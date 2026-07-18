package connect

import (
	"context"
	"errors"
	"sync"
)

const defaultSyntheticEventCapacity = 128

type SyntheticOptions struct {
	Width         int
	Height        int
	EventCapacity int
}

type InputEvent struct {
	Pointer *PointerEvent
	Key     *KeyEvent
}

// Synthetic is a deterministic, pure-Go backend used by CI and as the CLI's
// explicit fallback when platform capture is unavailable.
type Synthetic struct {
	mu       sync.Mutex
	width    int
	height   int
	capacity int
	sequence uint64
	pointer  PointerEvent
	events   []InputEvent
	closed   bool
}

func NewSynthetic(options SyntheticOptions) (*Synthetic, error) {
	if options.Width == 0 {
		options.Width = 640
	}
	if options.Height == 0 {
		options.Height = 360
	}
	if options.EventCapacity == 0 {
		options.EventCapacity = defaultSyntheticEventCapacity
	}
	if options.Width < 1 || options.Width > MaxDimension || options.Height < 1 || options.Height > MaxDimension {
		return nil, errors.New("invalid synthetic dimensions")
	}
	pixelCount, ok := checkedMul(options.Width, options.Height)
	if !ok {
		return nil, errors.New("synthetic dimensions overflow")
	}
	frameBytes, ok := checkedMul(pixelCount, 4)
	if !ok || frameBytes > MaxFrameBytes {
		return nil, errors.New("synthetic frame exceeds memory limit")
	}
	if options.EventCapacity < 1 || options.EventCapacity > 4096 {
		return nil, errors.New("invalid synthetic event capacity")
	}
	return &Synthetic{
		width:    options.Width,
		height:   options.Height,
		capacity: options.EventCapacity,
		pointer: PointerEvent{
			X: uint16(options.Width / 2),
			Y: uint16(options.Height / 2),
		},
	}, nil
}

func (s *Synthetic) Capture(ctx context.Context) (Frame, error) {
	if err := ctx.Err(); err != nil {
		return Frame{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return Frame{}, ErrClosed
	}
	s.sequence++
	stride := s.width * 4
	pixels := make([]byte, stride*s.height)
	phase := int(s.sequence % 256)
	for y := 0; y < s.height; y++ {
		for x := 0; x < s.width; x++ {
			offset := y*stride + x*4
			pixels[offset] = byte((x + phase) % 256)
			pixels[offset+1] = byte((y + phase*2) % 256)
			pixels[offset+2] = byte((x/16 ^ y/16) * 31)
			pixels[offset+3] = 0xff
		}
	}
	return Frame{
		Width:      s.width,
		Height:     s.height,
		Stride:     stride,
		Pixels:     pixels,
		DirtyRects: []Rect{{Width: s.width, Height: s.height}},
		Sequence:   s.sequence,
	}, nil
}

func (s *Synthetic) Pointer(ctx context.Context, event PointerEvent) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return ErrClosed
	}
	if int(event.X) >= s.width || int(event.Y) >= s.height {
		return errors.New("pointer coordinates are outside the frame")
	}
	s.pointer = event
	copy := event
	s.appendEvent(InputEvent{Pointer: &copy})
	return nil
}

func (s *Synthetic) Key(ctx context.Context, event KeyEvent) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return ErrClosed
	}
	copy := event
	s.appendEvent(InputEvent{Key: &copy})
	return nil
}

func (s *Synthetic) Cursor(ctx context.Context) (Cursor, error) {
	if err := ctx.Err(); err != nil {
		return Cursor{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return Cursor{}, ErrClosed
	}
	return Cursor{
		Width:   8,
		Height:  12,
		X:       int(s.pointer.X),
		Y:       int(s.pointer.Y),
		Visible: true,
		RGBA:    syntheticCursorPixels(),
	}, nil
}

func (s *Synthetic) Events() []InputEvent {
	s.mu.Lock()
	defer s.mu.Unlock()
	result := make([]InputEvent, len(s.events))
	for index, event := range s.events {
		if event.Pointer != nil {
			copy := *event.Pointer
			result[index].Pointer = &copy
		}
		if event.Key != nil {
			copy := *event.Key
			result[index].Key = &copy
		}
	}
	return result
}

func (s *Synthetic) Close() error {
	s.mu.Lock()
	s.closed = true
	s.mu.Unlock()
	return nil
}

func (s *Synthetic) appendEvent(event InputEvent) {
	if len(s.events) == s.capacity {
		copy(s.events, s.events[1:])
		s.events[len(s.events)-1] = event
		return
	}
	s.events = append(s.events, event)
}

func syntheticCursorPixels() []byte {
	const width, height = 8, 12
	pixels := make([]byte, width*height*4)
	for y := 0; y < height; y++ {
		for x := 0; x <= y/2 && x < width; x++ {
			offset := (y*width + x) * 4
			if x == 0 || x == y/2 || y == height-1 {
				pixels[offset] = 0
				pixels[offset+1] = 0
				pixels[offset+2] = 0
			} else {
				pixels[offset] = 0xff
				pixels[offset+1] = 0xff
				pixels[offset+2] = 0xff
			}
			pixels[offset+3] = 0xff
		}
	}
	return pixels
}
