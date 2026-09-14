//go:build linux

package connect

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// Run a real child process so cancellation exercises blocked pipe writes,
// CommandContext termination, Wait, and temporary-directory cleanup together.
func TestFFmpegFixtureProcess(t *testing.T) {
	mode := os.Getenv("CRABFLEET_FFMPEG_FIXTURE")
	if mode == "" {
		return
	}
	var width, height int
	var encoder string
	for i, arg := range os.Args {
		if arg == "-video_size" && i+1 < len(os.Args) {
			_, _ = fmt.Sscanf(os.Args[i+1], "%dx%d", &width, &height)
		}
		if arg == "-c:v" && i+1 < len(os.Args) {
			encoder = os.Args[i+1]
		}
	}
	attempts, err := os.OpenFile(os.Getenv("CRABFLEET_FFMPEG_ATTEMPTS"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
	if err != nil {
		os.Exit(2)
	}
	_, _ = fmt.Fprintf(attempts, "attempt %s %dx%d\n", encoder, width, height)
	_ = attempts.Close()
	if mode == "fail" {
		_, _ = fmt.Fprintln(os.Stderr, "fixture device initialization failed")
		os.Exit(1)
	}
	if mode == "blocked" {
		time.Sleep(30 * time.Second)
		os.Exit(1)
	}
	if mode == "geometry" && strings.HasSuffix(encoder, "_vaapi") && width < 128 {
		_, _ = fmt.Fprintln(os.Stderr, "fixture unsupported frame geometry")
		os.Exit(1)
	}
	pixels := make([]byte, width*height*4)
	for index := 0; ; index++ {
		if _, err := io.ReadFull(os.Stdin, pixels); err != nil {
			os.Exit(0)
		}
		file := fmt.Sprintf(os.Args[len(os.Args)-1], index)
		var err error
		if mode == "oversized" {
			var f *os.File
			f, err = os.Create(file + ".tmp")
			if err == nil {
				err = f.Truncate(16 << 20)
				_ = f.Close()
			}
		} else {
			payload := []byte("fixture-frame")
			if mode == "empty" {
				payload = nil
			}
			err = os.WriteFile(file+".tmp", payload, 0600)
		}
		if err != nil || os.Rename(file+".tmp", file) != nil {
			os.Exit(2)
		}
	}
}

func fixtureVideo(t *testing.T, parent context.Context, mode string, options VideoOptions) (*FFmpegVideo, string, string) {
	t.Helper()
	directory := t.TempDir()
	runtime := t.TempDir()
	binary, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	script := "#!/bin/sh\nexec \"$CRABFLEET_TEST_BINARY\" -test.run='^TestFFmpegFixtureProcess$' -- \"$@\"\n"
	if err := os.WriteFile(filepath.Join(directory, "ffmpeg"), []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	attempts := filepath.Join(directory, "attempts")
	t.Setenv("PATH", directory)
	t.Setenv("XDG_RUNTIME_DIR", runtime)
	t.Setenv("CRABFLEET_TEST_BINARY", binary)
	t.Setenv("CRABFLEET_FFMPEG_FIXTURE", mode)
	t.Setenv("CRABFLEET_FFMPEG_ATTEMPTS", attempts)
	v, err := NewFFmpegVideo(parent, options)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = v.Close() })
	return v, runtime, attempts
}

func solidVideoFrame(width, height, padding int, red byte) Frame {
	stride := width*4 + padding
	frame := Frame{Width: width, Height: height, Stride: stride, Pixels: make([]byte, stride*height)}
	for y := 0; y < height; y++ {
		for x := 0; x < width; x++ {
			i := y*stride + x*4
			frame.Pixels[i], frame.Pixels[i+1], frame.Pixels[i+2], frame.Pixels[i+3] = red, 40, 60, 255
		}
	}
	return frame
}

func assertVideoDirectoriesEmpty(t *testing.T, directory string) {
	t.Helper()
	entries, err := os.ReadDir(directory)
	if err != nil || len(entries) != 0 {
		t.Fatalf("video files leaked: %v, %v", entries, err)
	}
}

func TestFFmpegVideoRejectsFramesWithoutDisablingEncoder(t *testing.T) {
	v, runtime, _ := fixtureVideo(t, context.Background(), "frame", VideoOptions{Encoder: "software"})
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := v.Encode(ctx, solidVideoFrame(64, 48, 0, 180), "h264"); !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled input: %v", err)
	}
	for _, frame := range []Frame{{}, solidVideoFrame(63, 48, 0, 180), solidVideoFrame(64, 47, 0, 180)} {
		if _, err := v.Encode(context.Background(), frame, "h264"); err == nil {
			t.Fatal("accepted invalid video frame")
		}
	}
	if _, err := v.Encode(context.Background(), solidVideoFrame(64, 48, 0, 180), "unknown"); err == nil {
		t.Fatal("accepted unknown codec")
	}
	if len(v.unavailable) != 0 || len(v.failures) != 0 || len(v.workers) != 0 {
		t.Fatal("invalid input attempted or disabled an encoder")
	}
	assertVideoDirectoriesEmpty(t, runtime)
	if _, err := v.Encode(context.Background(), solidVideoFrame(64, 48, 16, 180), "h264"); err != nil {
		t.Fatal(err)
	}
}

func TestFFmpegVideoFailureIsCachedAndDiagnosed(t *testing.T) {
	var reports []string
	v, runtime, attempts := fixtureVideo(t, context.Background(), "fail", VideoOptions{Encoder: "vaapi", Device: "/dev/null", Report: func(message string) { reports = append(reports, message) }})
	for _, codec := range []string{"h264", "hevc"} {
		for _, width := range []int{64, 96, 64} {
			_, err := v.Encode(context.Background(), solidVideoFrame(width, 48, 0, 180), codec)
			if err == nil || !strings.Contains(err.Error(), "fixture device initialization failed") {
				t.Fatalf("missing backend diagnosis: %v", err)
			}
		}
	}
	data, err := os.ReadFile(attempts)
	if err != nil || strings.Count(string(data), "attempt") != 4 || len(reports) != 2 {
		t.Fatalf("retried a cached failed size or repeated diagnostics: attempts=%q reports=%v err=%v", data, reports, err)
	}
	if len(v.workers) != 0 {
		t.Fatal("failed workers retained")
	}
	assertVideoDirectoriesEmpty(t, runtime)
}

func TestFFmpegVideoPayloadBounds(t *testing.T) {
	for _, mode := range []string{"empty", "oversized"} {
		t.Run(mode, func(t *testing.T) {
			v, runtime, _ := fixtureVideo(t, context.Background(), mode, VideoOptions{Encoder: "software"})
			if _, err := v.Encode(context.Background(), solidVideoFrame(64, 48, 0, 180), "h264"); err == nil || !strings.Contains(err.Error(), "invalid encoded frame size") {
				t.Fatalf("accepted %s payload: %v", mode, err)
			}
			assertVideoDirectoriesEmpty(t, runtime)
		})
	}
}

func TestFFmpegVideoCancellationAndTimeout(t *testing.T) {
	for _, timeout := range []time.Duration{150 * time.Millisecond, 5 * time.Second} {
		t.Run(timeout.String(), func(t *testing.T) {
			v, runtime, _ := fixtureVideo(t, context.Background(), "blocked", VideoOptions{Encoder: "software"})
			ctx, cancel := context.WithTimeout(context.Background(), timeout)
			defer cancel()
			start := time.Now()
			_, err := v.Encode(ctx, solidVideoFrame(512, 512, 0, 180), "h264")
			if !errors.Is(err, context.DeadlineExceeded) || time.Since(start) > 4*time.Second {
				t.Fatalf("blocked writer did not stop within its deadline: %v, %s", err, time.Since(start))
			}
			if timeout < time.Second && (len(v.unavailable) != 0 || len(v.failures) != 0) {
				t.Fatal("caller cancellation disabled the backend")
			}
			if len(v.workers) != 0 {
				t.Fatal("canceled worker retained")
			}
			assertVideoDirectoriesEmpty(t, runtime)
		})
	}
}

func TestFFmpegVideoResizeAndIdleCancellation(t *testing.T) {
	parent, cancel := context.WithCancel(context.Background())
	defer cancel()
	var reports []string
	v, runtime, _ := fixtureVideo(t, parent, "frame", VideoOptions{Encoder: "software", Report: func(message string) { reports = append(reports, message) }})
	var previous *videoWorker
	for _, width := range []int{64, 64, 96, 64} {
		if _, err := v.Encode(context.Background(), solidVideoFrame(width, 48, 16, 180), "h264"); err != nil {
			t.Fatal(err)
		}
		worker := v.workers["h264/software"]
		if previous != nil {
			if previous.width == width && previous != worker {
				t.Fatal("restarted a healthy encoder for an unchanged size")
			}
			if previous.width != width {
				if _, err := os.Stat(previous.directory); !os.IsNotExist(err) {
					t.Fatal("resize retained old worker directory")
				}
			}
		}
		entries, err := os.ReadDir(worker.directory)
		if err != nil || len(entries) != 0 || len(v.workers) != 1 {
			t.Fatalf("unbounded worker state: files=%v workers=%d err=%v", entries, len(v.workers), err)
		}
		previous = worker
	}
	if len(reports) != 1 {
		t.Fatalf("resize spammed reports: %v", reports)
	}
	cancel()
	select {
	case <-previous.done:
	case <-time.After(2 * time.Second):
		t.Fatal("idle encoder survived parent cancellation")
	}
	// Join the idempotent cleanup without requiring another Encode or Close.
	previous.close()
	assertVideoDirectoriesEmpty(t, runtime)
	if _, err := v.Encode(context.Background(), solidVideoFrame(64, 48, 0, 180), "h264"); !errors.Is(err, ErrClosed) {
		t.Fatalf("parent cancellation accepted another frame: %v", err)
	}
	if err := v.Close(); err != nil {
		t.Fatal(err)
	}
	if err := v.Close(); err != nil {
		t.Fatal(err)
	}
}

func TestFFmpegVideoRecoversAfterUnsupportedSize(t *testing.T) {
	for _, selection := range []string{"auto", "vaapi"} {
		t.Run(selection, func(t *testing.T) {
			var reports []string
			v, runtime, attempts := fixtureVideo(t, context.Background(), "geometry", VideoOptions{Encoder: selection, Device: "/dev/null", Report: func(message string) { reports = append(reports, message) }})
			v.unavailable["hevc/nvenc"] = errors.New("NVIDIA excluded from VAAPI recovery fixture")
			for _, width := range []int{256, 64, 64, 256, 64, 320} {
				_, err := v.Encode(context.Background(), solidVideoFrame(width, 192, 0, 180), "hevc")
				if selection == "vaapi" && width == 64 {
					if err == nil || !strings.Contains(err.Error(), "unsupported frame geometry") {
						t.Fatalf("explicit hardware did not reject unsupported size: %v", err)
					}
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
					t.Fatalf("resize did not select %s or retained old backend: %v", backend, v.workers)
				}
			}
			data, err := os.ReadFile(attempts)
			if err != nil || strings.Count(string(data), "hevc_vaapi 64x192") != 1 || strings.Count(string(data), "hevc_vaapi 256x192") != 2 {
				t.Fatalf("failed geometry was retried or working geometry did not recover: %s, %v", data, err)
			}
			wantReports := 2
			if selection == "auto" {
				wantReports++
			}
			if len(reports) != wantReports {
				t.Fatalf("recovery repeated backend diagnostics: %v", reports)
			}
			_ = v.Close()
			assertVideoDirectoriesEmpty(t, runtime)
		})
	}
}

func TestFFmpegVideoFailedGeometryHistoryIsBounded(t *testing.T) {
	v, runtime, attempts := fixtureVideo(t, context.Background(), "fail", VideoOptions{Encoder: "vaapi", Device: "/dev/null"})
	for width := 64; width <= 84; width += 2 {
		for repeat := 0; repeat < 2; repeat++ {
			if _, err := v.Encode(context.Background(), solidVideoFrame(width, 48, 0, 180), "hevc"); err == nil {
				t.Fatal("failed fixture unexpectedly encoded")
			}
		}
		if len(v.failures["hevc/vaapi"]) > maxVideoFailedSizes {
			t.Fatal("failure history grew without bound")
		}
	}
	data, err := os.ReadFile(attempts)
	if err != nil || strings.Count(string(data), "attempt") != 11 {
		t.Fatalf("repeated bad sizes launched extra workers: %s, %v", data, err)
	}
	assertVideoDirectoriesEmpty(t, runtime)
}

func TestFFmpegVideoMissingDeviceNeverLaunchesWorker(t *testing.T) {
	for _, device := range []string{"missing", "regular-file"} {
		t.Run(device, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "renderD128")
			if device == "regular-file" {
				if err := os.WriteFile(path, nil, 0600); err != nil {
					t.Fatal(err)
				}
			}
			v, runtime, attempts := fixtureVideo(t, context.Background(), "frame", VideoOptions{Encoder: "vaapi", Device: path})
			for _, width := range []int{64, 256, 320, 64} {
				if _, err := v.Encode(context.Background(), solidVideoFrame(width, 192, 0, 180), "hevc"); err == nil {
					t.Fatal("invalid render device accepted")
				}
			}
			if _, err := os.Stat(attempts); !os.IsNotExist(err) {
				t.Fatal("missing/non-device render path launched a worker")
			}
			if v.unavailable["hevc/vaapi"] == nil || len(v.failures) != 0 {
				t.Fatal("device-wide failure was classified as a geometry failure")
			}
			assertVideoDirectoriesEmpty(t, runtime)
		})
	}
}
