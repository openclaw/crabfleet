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
	unavailable map[string]bool
	closed      bool
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

func NewFFmpegVideo(ctx context.Context) (*FFmpegVideo, error) {
	p, err := exec.LookPath("ffmpeg")
	if err != nil {
		return nil, errors.New("video encoding requires ffmpeg")
	}
	return &FFmpegVideo{ctx: ctx, executable: p, workers: make(map[string]*videoWorker), unavailable: make(map[string]bool)}, nil
}
func (v *FFmpegVideo) Encode(ctx context.Context, frame Frame, codec string) ([]byte, error) {
	if err := frame.Validate(); err != nil {
		return nil, err
	}
	if codec != "h264" && codec != "hevc" {
		return nil, errors.New("unknown codec")
	}
	v.mu.Lock()
	defer v.mu.Unlock()
	if v.closed || v.ctx.Err() != nil {
		return nil, ErrClosed
	}
	if v.unavailable[codec] {
		return nil, errors.New("video encoder unavailable")
	}
	w := v.workers[codec]
	if w != nil && (w.width != frame.Width || w.height != frame.Height) {
		w.close()
		delete(v.workers, codec)
		w = nil
	}
	if w == nil {
		var err error
		w, err = v.start(frame.Width, frame.Height, codec)
		if err != nil {
			return nil, err
		}
		v.workers[codec] = w
	}
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	stop := context.AfterFunc(ctx, w.close)
	defer stop()
	failed := func() ([]byte, error) {
		w.close()
		delete(v.workers, codec)
		if strings.Contains(w.logs.String(), "Unknown encoder") {
			v.unavailable[codec] = true
		}
		return nil, errors.New("video encoding failed")
	}
	for y := 0; y < frame.Height; y++ {
		row := frame.Pixels[y*frame.Stride : y*frame.Stride+frame.Width*4]
		if _, err := w.stdin.Write(row); err != nil {
			return failed()
		}
	}
	file := filepath.Join(w.directory, fmt.Sprintf("frame-%09d.%s", w.index, codec))
	ticker := time.NewTicker(2 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return failed()
		case <-w.done:
			return failed()
		case <-ticker.C:
			f, err := os.Open(file)
			if os.IsNotExist(err) {
				continue
			}
			if err != nil {
				return failed()
			}
			payload, err := io.ReadAll(io.LimitReader(f, 16<<20))
			_ = f.Close()
			_ = os.Remove(file)
			if err != nil || len(payload) == 0 || len(payload) >= 16<<20 {
				return failed()
			}
			w.index++
			return payload, nil
		}
	}
}
func (v *FFmpegVideo) start(width, height int, codec string) (*videoWorker, error) {
	directory, err := os.MkdirTemp(os.Getenv("XDG_RUNTIME_DIR"), "crabfleet-video-")
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithCancel(v.ctx)
	args := []string{"-nostdin", "-hide_banner", "-loglevel", "error", "-f", "rawvideo", "-pixel_format", "rgba", "-video_size", fmt.Sprintf("%dx%d", width, height), "-framerate", "30", "-probesize", "32", "-analyzeduration", "0", "-i", "pipe:0", "-an", "-pix_fmt", "yuv420p"}
	if codec == "h264" {
		args = append(args, "-c:v", "libx264", "-preset", "ultrafast", "-tune", "zerolatency", "-x264-params", "keyint=1:repeat-headers=1:threads=1")
	} else {
		args = append(args, "-c:v", "libx265", "-preset", "ultrafast", "-tune", "zerolatency", "-x265-params", "keyint=1:repeat-headers=1:pools=none:frame-threads=1:log-level=error")
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
	go func() { _ = cmd.Wait(); close(w.done) }()
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
