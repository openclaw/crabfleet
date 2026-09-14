//go:build linux

package connect

import (
	"bytes"
	"context"
	"io"
	"os"
	"os/exec"
	"testing"
	"time"
)

func TestADTSBoundsAndConfiguration(t *testing.T) {
	payload := []byte{1, 2, 3, 4}
	header := []byte{0xff, 0xf1, 0x4c, 0x80, 0x01, 0x7f, 0xfc}
	p, err := readADTS(bytes.NewReader(append(header, payload...)))
	if err != nil || !bytes.Equal(p, payload) {
		t.Fatalf("AAC packet: %v %v", p, err)
	}
	for _, mutate := range []func([]byte){func(p []byte) { p[0] = 0 }, func(p []byte) { p[2] = 0x50 }, func(p []byte) { p[6] |= 1 }, func(p []byte) { p[4] = 0; p[5] = 0 }} {
		bad := bytes.Clone(header)
		mutate(bad)
		if _, err := readADTS(bytes.NewReader(append(bad, payload...))); err == nil {
			t.Fatal("accepted malformed ADTS")
		}
	}
	if _, err := readADTS(bytes.NewReader(header)); err != io.EOF {
		t.Fatalf("truncated AAC: %v", err)
	}
}
func TestFFmpegLiveVideoCodecs(t *testing.T) {
	if os.Getenv("CRABFLEET_TEST_MEDIA") != "1" {
		t.Skip("opt-in real FFmpeg codec proof")
	}
	v, err := NewFFmpegVideo(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer v.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	frame := Frame{Width: 64, Height: 48, Stride: 64 * 4, Pixels: make([]byte, 64*48*4)}
	for i := 0; i < len(frame.Pixels); i += 4 {
		frame.Pixels[i], frame.Pixels[i+1], frame.Pixels[i+2], frame.Pixels[i+3] = 180, 40, 60, 255
	}
	for _, codec := range []string{"h264", "hevc"} {
		t.Run(codec, func(t *testing.T) {
			for pass := 0; pass < 3; pass++ {
				start := time.Now()
				frame.Pixels[0] = byte(180 + pass*2)
				payload, err := v.Encode(ctx, frame, codec)
				if err != nil {
					t.Fatal(err)
				}
				cmd := exec.CommandContext(ctx, "ffmpeg", "-nostdin", "-v", "error", "-f", codec, "-i", "pipe:0", "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1")
				cmd.Stdin = bytes.NewReader(payload)
				out := &BoundedBuffer{Limit: len(frame.Pixels)}
				cmd.Stdout = out
				cmd.Stderr = os.Stderr
				if err := cmd.Run(); err != nil {
					t.Fatal(err)
				}
				if out.Len() != len(frame.Pixels) {
					t.Fatalf("decoded %d bytes", out.Len())
				}
				pixels := out.Bytes()
				if pixels[0] < 170 || pixels[0] > 190 || pixels[1] < 30 || pixels[1] > 50 || pixels[2] < 50 || pixels[2] > 70 {
					t.Fatalf("incorrect decoded color %v", pixels[:4])
				}
				t.Logf("%s round trip: %d encoded bytes, %s", codec, len(payload), time.Since(start))
			}

		})
	}
}

func TestPulseAudioLiveOutputMonitor(t *testing.T) {
	if os.Getenv("CRABFLEET_TEST_AUDIO") != "1" {
		t.Skip("opt-in isolated PulseAudio output monitor proof")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 12*time.Second)
	defer cancel()
	a, err := NewPulseAudio(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if a.monitor != "crabfleet_fixture.monitor" {
		t.Fatal("audio proof must use the isolated fixture sink")
	}
	packets, err := a.Subscribe(ctx)
	if err != nil {
		t.Fatal(err)
	}
	tone := exec.CommandContext(ctx, "ffmpeg", "-nostdin", "-v", "error", "-re", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-t", "5", "-ac", "2", "-f", "pulse", "-device", "crabfleet_fixture", "fixture-tone")
	tone.WaitDelay = time.Second
	tone.Stderr = &BoundedBuffer{Limit: 4096}
	if err := tone.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { cancel(); _ = tone.Wait() }()
	var adts []byte
	var last uint32
	for len(adts) < 10000 {
		select {
		case <-ctx.Done():
			t.Fatal("no monitor audio before deadline")
		case packet, ok := <-packets:
			if !ok {
				t.Fatal("audio capture stopped")
			}
			if packet.TimestampMS < last {
				t.Fatal("audio timestamps moved backwards")
			}
			last = packet.TimestampMS
			n := len(packet.Payload) + 7
			header := []byte{0xff, 0xf1, 0x4c, 0x80 | byte(n>>11), byte(n >> 3), byte((n&7)<<5) | 0x1f, 0xfc}
			adts = append(adts, header...)
			adts = append(adts, packet.Payload...)
		}
	}
	decode := exec.CommandContext(ctx, "ffmpeg", "-nostdin", "-v", "error", "-f", "aac", "-i", "pipe:0", "-f", "s16le", "pipe:1")
	decode.Stdin = bytes.NewReader(adts)
	out := &BoundedBuffer{Limit: 4 << 20}
	decode.Stdout, decode.Stderr = out, os.Stderr
	if err := decode.Run(); err != nil {
		t.Fatal(err)
	}
	var peak int16
	data := out.Bytes()
	for i := 0; i+1 < len(data); i += 2 {
		sample := int16(uint16(data[i]) | uint16(data[i+1])<<8)
		if sample > peak {
			peak = sample
		}
	}
	if peak < 500 {
		t.Fatalf("output monitor contained no tone: peak %d", peak)
	}
	cancel()
	for range packets {
	}
	t.Logf("decoded system output tone, peak %d, capture shut down cleanly", peak)
}
