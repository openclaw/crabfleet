//go:build linux

package connect

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

type FFmpegVideo struct {
	ctx         context.Context
	executable  string
	mu          sync.Mutex
	workers     map[string]*videoWorker
	unavailable map[string]error
	failures    map[string][]videoSizeFailure
	reported    map[string]bool
	closed      bool
	options     VideoOptions
}

const maxVideoFailedSizes = 4

type videoSizeFailure struct {
	width, height int
	err           error
}

// VideoOptions selects the backend. Auto falls back to software; explicit
// hardware selection leaves codec fallback to the caller. Report runs after
// releasing the encoder lock and reports each codec/backend only once.
type VideoOptions struct {
	Encoder, Device string
	Report          func(string)
}
type videoWorker struct {
	cancel               context.CancelFunc
	stdin                io.WriteCloser
	directory            string
	done                 chan struct{}
	logs                 *BoundedBuffer
	width, height, index int
	closeOnce            sync.Once
}

func NewFFmpegVideo(ctx context.Context, options VideoOptions) (*FFmpegVideo, error) {
	if options.Encoder == "" {
		options.Encoder = "auto"
	}
	if options.Encoder != "auto" && options.Encoder != "software" && options.Encoder != "vaapi" && options.Encoder != "nvenc" {
		return nil, errors.New("encoder must be auto, software, vaapi, or nvenc")
	}
	if options.Device == "" {
		options.Device = "/dev/dri/renderD128"
	}
	p, err := exec.LookPath("ffmpeg")
	if err != nil {
		return nil, errors.New("video encoding requires ffmpeg")
	}
	return &FFmpegVideo{ctx: ctx, executable: p, workers: make(map[string]*videoWorker), unavailable: make(map[string]error), failures: make(map[string][]videoSizeFailure), reported: make(map[string]bool), options: options}, nil
}
func (v *FFmpegVideo) Encode(ctx context.Context, frame Frame, codec string) ([]byte, error) {
	if err := frame.Validate(); err != nil {
		return nil, err
	}
	if codec != "h264" && codec != "hevc" {
		return nil, errors.New("unknown codec")
	}
	// All backends produce 4:2:0 video. Reject unsupported sizes before an
	// encoder attempt, so one odd-sized capture cannot disable a healthy backend.
	if frame.Width%2 != 0 || frame.Height%2 != 0 {
		return nil, errors.New("video encoding requires even frame dimensions")
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	v.mu.Lock()
	var reports []string
	defer func() {
		v.mu.Unlock()
		if v.options.Report != nil {
			for _, report := range reports {
				v.options.Report(report)
			}
		}
	}()
	if v.closed || v.ctx.Err() != nil {
		return nil, ErrClosed
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	var lastErr error
	for _, encoder := range v.encoders() {
		key := codec + "/" + encoder
		if err := v.unavailable[key]; err != nil {
			lastErr = err
			continue
		}
		if err := v.failedSize(key, frame.Width, frame.Height); err != nil {
			lastErr = err
			continue
		}
		if err := v.checkDevice(encoder); err != nil {
			lastErr = fmt.Errorf("%s %s: %w", codec, encoder, err)
			v.unavailable[key] = lastErr
			if !v.reported[key+"/failure"] {
				v.reported[key+"/failure"] = true
				reports = append(reports, fmt.Sprintf("%s; trying the next supported encoder or codec.", lastErr))
			}
			continue
		}
		payload, err := v.encode(ctx, frame, codec, encoder, key)
		if err == nil {
			// A recovered hardware encoder replaces the software fallback;
			// keep only the selected worker for this codec alive.
			for other, worker := range v.workers {
				if other != key && strings.HasPrefix(other, codec+"/") {
					worker.close()
					delete(v.workers, other)
				}
			}
			if !v.reported[key] {
				v.reported[key] = true
				reports = append(reports, fmt.Sprintf("Video: %s (%s), %dx%d", codec, encoder, frame.Width, frame.Height))
			}
			return payload, nil
		}
		if ctx.Err() != nil || v.ctx.Err() != nil {
			return nil, err
		}
		lastErr = fmt.Errorf("%s %s at %dx%d: %w", codec, encoder, frame.Width, frame.Height, err)
		v.rememberFailedSize(key, frame.Width, frame.Height, lastErr)
		if !v.reported[key+"/failure"] {
			v.reported[key+"/failure"] = true
			reports = append(reports, fmt.Sprintf("%s; trying the next supported encoder or codec.", lastErr))
		}
	}
	return nil, fmt.Errorf("video encoder unavailable: %w", lastErr)
}

// Only filesystem evidence establishes device-wide unavailability. FFmpeg
// failures can depend on geometry; do not classify its driver-specific text.
func (v *FFmpegVideo) checkDevice(encoder string) error {
	var device string
	switch encoder {
	case "vaapi":
		device = v.options.Device
	case "nvenc":
		device = "/dev/nvidiactl"
	default:
		return nil
	}
	info, err := os.Stat(device)
	if err != nil {
		return fmt.Errorf("hardware device unavailable: %w", err)
	}
	if info.Mode()&os.ModeCharDevice == 0 {
		return errors.New("hardware device must be a character device")
	}
	return nil
}

func (v *FFmpegVideo) failedSize(key string, width, height int) error {
	for _, failure := range v.failures[key] {
		if failure.width == width && failure.height == height {
			return failure.err
		}
	}
	return nil
}

func (v *FFmpegVideo) rememberFailedSize(key string, width, height int, err error) {
	// Repeated bad sizes do not respawn FFmpeg. Bound the history even during
	// arbitrary resize sequences; a new geometry can still recover the backend.
	failures := v.failures[key]
	if len(failures) == maxVideoFailedSizes {
		copy(failures, failures[1:])
		failures = failures[:len(failures)-1]
	}
	v.failures[key] = append(failures, videoSizeFailure{width: width, height: height, err: err})
}

func (v *FFmpegVideo) encoders() []string {
	if v.options.Encoder != "auto" {
		return []string{v.options.Encoder}
	}
	var encoders []string
	if _, err := os.Stat("/dev/nvidiactl"); err == nil {
		encoders = append(encoders, "nvenc")
	}
	if _, err := os.Stat(v.options.Device); err == nil {
		encoders = append(encoders, "vaapi")
	}
	return append(encoders, "software")
}

func (v *FFmpegVideo) encode(ctx context.Context, frame Frame, codec, encoder, key string) ([]byte, error) {
	w := v.workers[key]
	if w != nil && (w.width != frame.Width || w.height != frame.Height) {
		w.close()
		delete(v.workers, key)
		w = nil
	}
	if w == nil {
		var err error
		w, err = v.start(frame.Width, frame.Height, codec, encoder)
		if err != nil {
			return nil, err
		}
		v.workers[key] = w
	}
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	stop := context.AfterFunc(ctx, w.close)
	defer stop()
	failed := func(cause error) ([]byte, error) {
		w.close()
		delete(v.workers, key)
		if err := ctx.Err(); err != nil {
			cause = err
		}
		if err := v.ctx.Err(); err != nil {
			cause = err
		}
		// Wait has drained stderr before it closes done, so this read cannot
		// race the subprocess writer. Quote the bounded diagnostic for terminals.
		detail := strings.TrimSpace(w.logs.String())
		if len(detail) > 1024 {
			detail = detail[:1024] + "..."
		}
		if detail != "" {
			return nil, fmt.Errorf("video encoding failed: %w; ffmpeg: %q", cause, detail)
		}
		return nil, fmt.Errorf("video encoding failed: %w", cause)
	}
	for y := 0; y < frame.Height; y++ {
		row := frame.Pixels[y*frame.Stride : y*frame.Stride+frame.Width*4]
		if _, err := w.stdin.Write(row); err != nil {
			return failed(err)
		}
	}
	file := filepath.Join(w.directory, fmt.Sprintf("frame-%09d.%s", w.index, codec))
	ticker := time.NewTicker(2 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return failed(ctx.Err())
		case <-w.done:
			return failed(errors.New("ffmpeg exited"))
		case <-ticker.C:
			f, err := os.Open(file)
			if os.IsNotExist(err) {
				continue
			}
			if err != nil {
				return failed(err)
			}
			payload, err := io.ReadAll(io.LimitReader(f, 16<<20))
			_ = f.Close()
			_ = os.Remove(file)
			if err != nil {
				return failed(err)
			}
			if len(payload) == 0 || len(payload) >= 16<<20 {
				return failed(errors.New("invalid encoded frame size"))
			}
			// Fence deadline cleanup before retaining this worker for the next
			// frame. An already-running callback must finish via failed/close.
			if !stop() || ctx.Err() != nil {
				return failed(ctx.Err())
			}
			w.index++
			return payload, nil
		}
	}
}
func (v *FFmpegVideo) start(width, height int, codec, encoder string) (*videoWorker, error) {
	directory, err := os.MkdirTemp(os.Getenv("XDG_RUNTIME_DIR"), "crabfleet-video-")
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithCancel(v.ctx)
	args := []string{"-nostdin", "-hide_banner", "-loglevel", "error"}
	if encoder == "vaapi" {
		args = append(args, "-init_hw_device", "vaapi=crabfleet:"+v.options.Device, "-filter_hw_device", "crabfleet")
	}
	args = append(args, "-f", "rawvideo", "-pixel_format", "rgba", "-video_size", fmt.Sprintf("%dx%d", width, height), "-framerate", "30", "-probesize", "32", "-analyzeduration", "0", "-i", "pipe:0", "-an")
	if encoder == "vaapi" {
		args = append(args, "-vf", "format=nv12,hwupload", "-c:v", codec+"_vaapi", "-profile:v", "main", "-g", "1", "-bf", "0", "-async_depth", "1")
	} else if encoder == "nvenc" {
		args = append(args, "-pix_fmt", "yuv420p", "-c:v", codec+"_nvenc", "-preset", "p1", "-tune", "ull", "-profile:v", "main", "-g", "1", "-bf", "0", "-delay", "0", "-rc-lookahead", "0", "-forced-idr", "1")
	} else if codec == "h264" {
		args = append(args, "-pix_fmt", "yuv420p")
		args = append(args, "-c:v", "libx264", "-preset", "ultrafast", "-tune", "zerolatency", "-x264-params", "keyint=1:repeat-headers=1:threads=1")
	} else {
		args = append(args, "-pix_fmt", "yuv420p")
		// keyint=1 selects Main Intra (Range Extensions), which browser HEVC
		// decoders may reject. Force every frame to a closed-GOP keyframe while
		// retaining Main profile and independently decodable access units.
		args = append(args, "-c:v", "libx265", "-preset", "ultrafast", "-tune", "zerolatency", "-profile:v", "main", "-force_key_frames", "expr:gte(t,0)", "-x265-params", "keyint=30:min-keyint=1:scenecut=0:repeat-headers=1:open-gop=0:pools=none:frame-threads=1:log-level=error")
	}
	// image2 atomically publishes each complete access unit. A single input is
	// outstanding, so at most one finished file and its temporary file can exist.
	args = append(args, "-f", "image2", "-atomic_writing", "1", "-start_number", "0", filepath.Join(directory, "frame-%09d."+codec))
	cmd := exec.CommandContext(ctx, v.executable, args...)
	cmd.WaitDelay = time.Second
	logs := &BoundedBuffer{Limit: 4096}
	cmd.Stderr = logs
	stdin, err := cmd.StdinPipe()
	if err != nil {
		cancel()
		_ = os.RemoveAll(directory)
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		cancel()
		_ = stdin.Close()
		_ = os.RemoveAll(directory)
		return nil, err
	}
	w := &videoWorker{cancel: cancel, stdin: stdin, directory: directory, done: make(chan struct{}), logs: logs, width: width, height: height}
	go func() {
		_ = cmd.Wait()
		close(w.done)
		// Parent cancellation also cleans an idle worker, without waiting for
		// another Encode call or the caller to invoke Close.
		w.close()
	}()
	return w, nil
}
func (w *videoWorker) close() {
	w.closeOnce.Do(func() { _ = w.stdin.Close(); w.cancel(); <-w.done; _ = os.RemoveAll(w.directory) })
}
func (v *FFmpegVideo) Close() error {
	v.mu.Lock()
	defer v.mu.Unlock()
	v.closed = true
	for codec, w := range v.workers {
		w.close()
		delete(v.workers, codec)
	}
	return nil
}
