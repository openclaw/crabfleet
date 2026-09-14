//go:build linux

package connect

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
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
	testFFmpegLiveVideo(t, "software")
}

func TestFFmpegLiveHardwareVideoCodecs(t *testing.T) {
	encoder := os.Getenv("CRABFLEET_TEST_VIDEO_ENCODER")
	if encoder == "" {
		t.Skip("set CRABFLEET_TEST_VIDEO_ENCODER=vaapi or nvenc for real hardware proof")
	}
	if encoder != "vaapi" && encoder != "nvenc" {
		t.Fatal("hardware proof requires vaapi or nvenc")
	}
	testFFmpegLiveVideo(t, encoder)
}

func testFFmpegLiveVideo(t *testing.T, encoder string) {
	t.Helper()
	runtime := t.TempDir()
	t.Setenv("XDG_RUNTIME_DIR", runtime)
	var reports []string
	v, err := NewFFmpegVideo(context.Background(), VideoOptions{Encoder: encoder, Device: os.Getenv("CRABFLEET_TEST_RENDER_DEVICE"), Report: func(message string) { reports = append(reports, message) }})
	if err != nil {
		t.Fatal(err)
	}
	defer v.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	for _, codec := range []string{"h264", "hevc"} {
		t.Run(codec, func(t *testing.T) {
			var previous *videoWorker
			sizes := [][2]int{{64, 48}, {64, 48}, {96, 64}, {1280, 720}, {1280, 720}, {64, 48}}
			if encoder != "software" {
				// Hardware encoders can have larger minimum dimensions (Intel
				// HEVC requires at least 128x128). Keep real proof portable.
				sizes = [][2]int{{256, 192}, {256, 192}, {320, 240}, {1280, 720}, {1280, 720}, {256, 192}}
			}
			for pass, size := range sizes {
				// Stride padding and changing the entire frame detect accidental
				// padding upload and delayed/stale access units, respectively.
				frame := solidVideoFrame(size[0], size[1], 16, byte(80+pass*20))
				start := time.Now()
				payload, err := v.Encode(ctx, frame, codec)
				if err != nil {
					t.Fatal(err)
				}
				elapsed := time.Since(start)
				worker := v.workers[codec+"/"+encoder]
				if worker == nil {
					t.Fatal("hardware proof silently fell back to another backend")
				}
				if previous != nil && previous != worker {
					if _, err := os.Stat(previous.directory); !os.IsNotExist(err) {
						t.Fatal("resize leaked the previous encoder directory")
					}
				}
				previous = worker
				assertIndependentVideoFrame(t, ctx, payload, frame, codec)
				t.Logf("%s %s %dx%d pass %d: %d encoded bytes in %s; independently decoded exact dimensions and color", encoder, codec, frame.Width, frame.Height, pass, len(payload), elapsed)
			}
		})
	}
	if len(reports) != 2 {
		t.Fatalf("expected one backend report per codec: %v", reports)
	}
	if err := v.Close(); err != nil {
		t.Fatal(err)
	}
	assertVideoDirectoriesEmpty(t, runtime)
}

func assertIndependentVideoFrame(t *testing.T, ctx context.Context, payload []byte, frame Frame, codec string) {
	t.Helper()
	probe := exec.CommandContext(ctx, "ffprobe", "-v", "error", "-f", codec, "-i", "pipe:0", "-show_entries", "stream=profile,width,height", "-of", "json")
	probe.Stdin = bytes.NewReader(payload)
	metadata, err := probe.Output()
	if err != nil {
		t.Fatal(err)
	}
	var info struct {
		Streams []struct {
			Profile string `json:"profile"`
			Width   int    `json:"width"`
			Height  int    `json:"height"`
		} `json:"streams"`
	}
	if err := json.Unmarshal(metadata, &info); err != nil || len(info.Streams) != 1 {
		t.Fatalf("invalid encoded frame metadata: %s, %v", metadata, err)
	}
	stream := info.Streams[0]
	if stream.Width != frame.Width || stream.Height != frame.Height || (codec == "hevc" && stream.Profile != "Main") {
		t.Fatalf("incompatible encoded dimensions/profile: %+v", stream)
	}
	cmd := exec.CommandContext(ctx, "ffmpeg", "-nostdin", "-v", "error", "-xerror", "-f", codec, "-i", "pipe:0", "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1")
	cmd.Stdin = bytes.NewReader(payload)
	expectedBytes := frame.Width * frame.Height * 4
	out := &BoundedBuffer{Limit: expectedBytes}
	cmd.Stdout = out
	cmd.Stderr = os.Stderr
	if err := cmd.Run(); err != nil {
		t.Fatal(err)
	}
	if out.Len() != expectedBytes {
		t.Fatalf("decoded %d bytes, expected %d", out.Len(), expectedBytes)
	}
	pixels := out.Bytes()
	for _, i := range []int{0, (frame.Height/2*frame.Width + frame.Width/2) * 4, len(pixels) - 4} {
		for c, expected := range []byte{frame.Pixels[0], 40, 60, 255} {
			if difference := int(pixels[i+c]) - int(expected); difference < -10 || difference > 10 {
				t.Fatalf("incorrect/stale decoded color at %d: %v, expected red %d", i, pixels[i:i+4], frame.Pixels[0])
			}
		}
	}
}

func TestFFmpegLiveAutoVideoFallback(t *testing.T) {
	if os.Getenv("CRABFLEET_TEST_MEDIA") != "1" {
		t.Skip("opt-in real FFmpeg fallback proof")
	}
	for _, device := range []string{"missing", "invalid"} {
		t.Run(device, func(t *testing.T) {
			runtime := t.TempDir()
			t.Setenv("XDG_RUNTIME_DIR", runtime)
			renderDevice := filepath.Join(t.TempDir(), "renderD128")
			if device == "invalid" {
				if err := os.WriteFile(renderDevice, nil, 0600); err != nil {
					t.Fatal(err)
				}
			}
			var reports []string
			v, err := NewFFmpegVideo(context.Background(), VideoOptions{Device: renderDevice, Report: func(message string) { reports = append(reports, message) }})
			if err != nil {
				t.Fatal(err)
			}
			defer v.Close()
			ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
			defer cancel()
			for _, codec := range []string{"h264", "hevc"} {
				// Keep this fixture deterministic on NVIDIA hosts, where auto
				// would otherwise select the working GPU before the fake VAAPI node.
				v.unavailable[codec+"/nvenc"] = errors.New("NVIDIA excluded from VAAPI fallback fixture")
				for _, width := range []int{64, 96} {
					frame := solidVideoFrame(width, 48, 16, 180)
					payload, err := v.Encode(ctx, frame, codec)
					if err != nil {
						t.Fatal(err)
					}
					assertIndependentVideoFrame(t, ctx, payload, frame, codec)
					if v.workers[codec+"/software"] == nil {
						t.Fatal("auto did not fall back to software")
					}
				}
			}
			wantReports := 2
			if device == "invalid" {
				wantReports = 4
				for _, codec := range []string{"h264", "hevc"} {
					if v.unavailable[codec+"/vaapi"] == nil {
						t.Fatal("failed device was not cached")
					}
				}
			}
			if len(reports) != wantReports {
				t.Fatalf("unexpected repeated fallback reports: %v", reports)
			}
			_ = v.Close()
			assertVideoDirectoriesEmpty(t, runtime)
			t.Logf("%s GPU: H.264 and HEVC independently decoded via software across resize; %d bounded reports", device, len(reports))
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

func TestFFmpegLiveIntelHEVCResizeRecovery(t *testing.T) {
	if os.Getenv("CRABFLEET_TEST_VIDEO_ENCODER") != "vaapi" {
		t.Skip("opt-in Intel VAAPI HEVC geometry recovery proof")
	}
	device := os.Getenv("CRABFLEET_TEST_RENDER_DEVICE")
	if device == "" {
		device = "/dev/dri/renderD128"
	}
	vendor, err := os.ReadFile(filepath.Join("/sys/class/drm", filepath.Base(device), "device/vendor"))
	if err != nil || string(bytes.TrimSpace(vendor)) != "0x8086" {
		t.Skip("this minimum-size fixture requires an Intel render device")
	}
	for _, selection := range []string{"auto", "vaapi"} {
		t.Run(selection, func(t *testing.T) {
			runtime := t.TempDir()
			t.Setenv("XDG_RUNTIME_DIR", runtime)
			var reports []string
			v, err := NewFFmpegVideo(context.Background(), VideoOptions{Encoder: selection, Device: device, Report: func(message string) { reports = append(reports, message) }})
			if err != nil {
				t.Fatal(err)
			}
			defer v.Close()
			v.unavailable["hevc/nvenc"] = errors.New("NVIDIA excluded from Intel recovery fixture")
			ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			defer cancel()
			for pass, width := range []int{256, 64, 64, 256, 64, 320} {
				frame := solidVideoFrame(width, 192, 16, byte(80+pass*20))
				start := time.Now()
				payload, err := v.Encode(ctx, frame, "hevc")
				elapsed := time.Since(start)
				if selection == "vaapi" && width == 64 {
					if err == nil {
						t.Fatal("Intel fixture unexpectedly accepted width below its minimum")
					}
					t.Logf("explicit VAAPI rejected width 64 in %s; failure remains geometry-specific", elapsed)
					continue
				}
				if err != nil {
					t.Fatal(err)
				}
				backend := "vaapi"
				if width == 64 {
					backend = "software"
				}
				if len(v.workers) != 1 || v.workers["hevc/"+backend] == nil {
					t.Fatalf("expected recovered %s backend with no idle fallback worker", backend)
				}
				assertIndependentVideoFrame(t, ctx, payload, frame, "hevc")
				t.Logf("%s pass %d: %dx192 independently decoded HEVC Main via %s in %s", selection, pass, width, backend, elapsed)
			}
			if v.unavailable["hevc/vaapi"] != nil || len(v.failures["hevc/vaapi"]) != 1 {
				t.Fatal("unsupported size disabled the device or duplicated failure history")
			}
			wantReports := 2
			if selection == "auto" {
				wantReports++
			}
			if len(reports) != wantReports {
				t.Fatalf("resize recovery spammed reports: %v", reports)
			}
			_ = v.Close()
			assertVideoDirectoriesEmpty(t, runtime)
		})
	}
}
