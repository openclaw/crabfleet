//go:build linux

package connect

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os/exec"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

// BoundedBuffer fails a helper write instead of allowing unbounded subprocess
// output to accumulate. CommandContext then bounds termination and pipe draining.
type BoundedBuffer struct {
	bytes.Buffer
	Limit int
}

func (b *BoundedBuffer) Write(p []byte) (int, error) {
	if len(p) > b.Limit-b.Len() {
		return 0, errors.New("helper output limit exceeded")
	}
	return b.Buffer.Write(p)
}

type PulseAudio struct{ executable, monitor string }

func NewPulseAudio(ctx context.Context) (*PulseAudio, error) {
	ffmpeg, err := exec.LookPath("ffmpeg")
	if err != nil {
		return nil, errors.New("audio sharing requires ffmpeg")
	}
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "pactl", "get-default-sink")
	cmd.WaitDelay = time.Second
	out := &BoundedBuffer{Limit: 1024}
	cmd.Stdout = out
	if err := cmd.Run(); err != nil {
		return nil, errors.New("audio sharing requires pactl and a running PulseAudio or PipeWire Pulse server")
	}
	sink := strings.TrimSpace(out.String())
	if sink == "" || strings.ContainsAny(sink, "\x00\r\n") {
		return nil, errors.New("invalid default audio sink")
	}
	return &PulseAudio{executable: ffmpeg, monitor: sink + ".monitor"}, nil
}
func (a *PulseAudio) Subscribe(ctx context.Context) (<-chan AudioPacket, error) {
	ctx, cancel := context.WithCancel(ctx)
	cmd := exec.CommandContext(ctx, a.executable, "-nostdin", "-hide_banner", "-loglevel", "error", "-f", "pulse", "-i", a.monitor, "-vn", "-ac", "2", "-ar", "48000", "-c:a", "aac", "-profile:a", "aac_low", "-b:a", "128k", "-f", "adts", "pipe:1")
	cmd.WaitDelay = time.Second
	pipe, err := cmd.StdoutPipe()
	if err != nil {
		cancel()
		return nil, err
	}
	cmd.Stderr = &BoundedBuffer{Limit: 4096}
	if err := cmd.Start(); err != nil {
		cancel()
		_ = pipe.Close()
		return nil, err
	}
	packets := make(chan AudioPacket, 8)
	go func() {
		defer close(packets)
		defer func() { cancel(); _ = cmd.Wait() }()
		stopPipe := context.AfterFunc(ctx, func() { _ = pipe.Close() })
		defer stopPipe()
		var samples uint64
		for {
			p, err := readADTS(pipe)
			if err != nil {
				return
			}
			packet := AudioPacket{TimestampMS: uint32(samples * 1000 / 48000), Payload: p}
			samples += 1024
			select {
			case <-ctx.Done():
				return
			default:
			}
			select {
			case packets <- packet:
			default:
			}
		}
	}()
	return packets, nil
}
func readADTS(r io.Reader) ([]byte, error) {
	var header [7]byte
	if _, err := io.ReadFull(r, header[:]); err != nil {
		return nil, err
	}
	length := (int(header[3]&3) << 11) | (int(header[4]) << 3) | int(header[5]>>5)
	channels := ((header[2] & 1) << 2) | (header[3] >> 6)
	if header[0] != 255 || header[1]&0xf6 != 0xf0 || header[2]>>6 != 1 || (header[2]>>2)&15 != 3 || channels != 2 || header[6]&3 != 0 {
		return nil, errors.New("expected AAC-LC 48 kHz stereo")
	}
	size := 7
	if header[1]&1 == 0 {
		size = 9
		if _, err := io.CopyN(io.Discard, r, 2); err != nil {
			return nil, err
		}
	}
	if length <= size {
		return nil, errors.New("invalid ADTS length")
	}
	payload := make([]byte, length-size)
	_, err := io.ReadFull(r, payload)
	return payload, err
}

type CommandClipboard struct {
	ctx         context.Context
	cancel      context.CancelFunc
	read, write []string
	mu          sync.Mutex
	stop        context.CancelFunc
	done        chan error
}

func NewCommandClipboard(ctx context.Context, wayland bool) (*CommandClipboard, error) {
	read, write := []string{"xclip", "-selection", "clipboard", "-out"}, []string{"xclip", "-selection", "clipboard", "-in", "-quiet"}
	if wayland {
		read = []string{"wl-paste", "--no-newline", "--type", "text/plain;charset=utf-8"}
		write = []string{"wl-copy", "--foreground", "--type", "text/plain;charset=utf-8"}
	}
	for _, p := range []string{read[0], write[0]} {
		if _, err := exec.LookPath(p); err != nil {
			return nil, fmt.Errorf("clipboard sharing requires %s", p)
		}
	}
	ctx, cancel := context.WithCancel(ctx)
	return &CommandClipboard{ctx: ctx, cancel: cancel, read: read, write: write}, nil
}
func (c *CommandClipboard) ReadClipboard(ctx context.Context) (string, error) {
	if c.ctx.Err() != nil {
		return "", ErrClosed
	}
	ctx, cancel := context.WithTimeout(ctx, time.Second)
	defer cancel()
	stop := context.AfterFunc(c.ctx, cancel)
	defer stop()
	cmd := exec.CommandContext(ctx, c.read[0], c.read[1:]...)
	cmd.WaitDelay = time.Second
	out := &BoundedBuffer{Limit: MaxClipboardBytes}
	cmd.Stdout = out
	if err := cmd.Run(); err != nil {
		return "", errors.New("clipboard unavailable")
	}
	if !utf8.Valid(out.Bytes()) {
		return "", errors.New("clipboard is not UTF-8")
	}
	return out.String(), nil
}
func (c *CommandClipboard) WriteClipboard(ctx context.Context, text string) error {
	if !utf8.ValidString(text) || len(text) >= MaxClipboardBytes || strings.ContainsRune(text, 0) {
		return errors.New("invalid clipboard text")
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.ctx.Err() != nil {
		return ErrClosed
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	c.stopOwnerLocked()
	holderContext, cancel := context.WithCancel(c.ctx)
	cmd := exec.CommandContext(holderContext, c.write[0], c.write[1:]...)
	cmd.WaitDelay = time.Second
	cmd.Stdin = strings.NewReader(text)
	if err := cmd.Start(); err != nil {
		cancel()
		return err
	}
	done := make(chan error, 1)
	c.stop, c.done = cancel, done
	go func() { done <- cmd.Wait() }()
	deadline := time.NewTimer(time.Second)
	defer deadline.Stop()
	ticker := time.NewTicker(20 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case err := <-c.done:
			c.stop, c.done = nil, nil
			cancel()
			if err == nil {
				return errors.New("clipboard owner exited")
			}
			return err
		case <-ctx.Done():
			c.stopOwnerLocked()
			return ctx.Err()
		case <-deadline.C:
			c.stopOwnerLocked()
			return errors.New("clipboard ownership timed out")
		case <-ticker.C:
			current, err := c.ReadClipboard(ctx)
			if err == nil && current == text {
				return nil
			}
		}
	}
}
func (c *CommandClipboard) Close() error {
	c.cancel()
	c.mu.Lock()
	defer c.mu.Unlock()
	c.stopOwnerLocked()
	return nil
}

func (c *CommandClipboard) stopOwnerLocked() {
	if c.stop != nil {
		c.stop()
		<-c.done
		c.stop, c.done = nil, nil
	}
}
