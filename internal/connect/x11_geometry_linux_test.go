//go:build linux

package connect

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"testing"
	"time"

	"github.com/jezek/xgb/randr"
	"github.com/jezek/xgb/xproto"
)

func TestX11BufferSize(t *testing.T) {
	for _, test := range []struct {
		name                                         string
		width, height, bytesPixel, pad, stride, size int
	}{
		{"RGB padding", 3, 2, 3, 32, 12, 24},
		{"RGB unpadded", 3, 2, 3, 8, 9, 18},
		{"16 bit padding", 3, 2, 2, 32, 8, 16},
		{"RGBA", 800, 600, 4, 32, 3200, 1920000},
	} {
		t.Run(test.name, func(t *testing.T) {
			stride, size, err := x11BufferSize(test.width, test.height, test.bytesPixel, test.pad)
			if err != nil || stride != test.stride || size != test.size {
				t.Fatalf("got stride=%d size=%d err=%v", stride, size, err)
			}
		})
	}
	for _, test := range [][4]int{
		{0, 1, 4, 32}, {1, -1, 4, 32}, {65536, 1, 4, 32},
		{65535, 65535, 4, 32}, {16384, 8192, 2, 32},
		{1, 1, 4, 0}, {1, 1, 4, 24}, {1, 1, 1, 32},
		{int(^uint(0) >> 1), 1, 4, 32},
	} {
		if _, _, err := x11BufferSize(test[0], test[1], test[2], test[3]); err == nil {
			t.Fatalf("accepted invalid dimensions/format %v", test)
		}
	}
}

func TestX11ResizeMode(t *testing.T) {
	info := &randr.GetScreenInfoReply{
		Rotation: randr.RotationRotate0, Rate: 60,
		Sizes: []randr.ScreenSize{{Width: 800, Height: 600}, {Width: 1024, Height: 768}},
		Rates: []randr.RefreshRates{{Rates: []uint16{60}}, {Rates: []uint16{75}}},
	}
	layout := DesktopLayout{Width: 1024, Height: 768, Screens: []Screen{{ID: 7, Width: 1024, Height: 768}}}
	mode, rate, err := x11ResizeMode(info, layout)
	if err != nil || mode != 1 || rate != 0 {
		t.Fatalf("mode=%d rate=%d err=%v", mode, rate, err)
	}
	info.Rates[1].Rates = append(info.Rates[1].Rates, 60)
	_, rate, err = x11ResizeMode(info, layout)
	if err != nil || rate != 60 {
		t.Fatalf("did not preserve supported refresh rate: %d %v", rate, err)
	}
	info.Rotation = randr.RotationRotate90
	if _, _, err := x11ResizeMode(info, layout); !errors.Is(err, ErrResizeUnsupported) {
		t.Fatalf("accepted unrotated dimensions: %v", err)
	}
	layout.Width, layout.Height = 768, 1024
	layout.Screens[0].Width, layout.Screens[0].Height = 768, 1024
	if mode, _, err := x11ResizeMode(info, layout); err != nil || mode != 1 {
		t.Fatalf("rotated mode=%d err=%v", mode, err)
	}
	layout.Screens[0].X = 1
	if _, _, err := x11ResizeMode(info, layout); !errors.Is(err, ErrResizeUnsupported) {
		t.Fatalf("accepted monitor position: %v", err)
	}
	layout.Screens[0].X = 0
	layout.Screens = append(layout.Screens, layout.Screens[0])
	if _, _, err := x11ResizeMode(info, layout); !errors.Is(err, ErrResizeUnsupported) {
		t.Fatalf("accepted multi-monitor request: %v", err)
	}
	if _, _, err := x11ResizeMode(nil, layout); !errors.Is(err, ErrResizeUnsupported) {
		t.Fatalf("accepted missing mode list: %v", err)
	}
}

// This fixture always starts a private server. It never reads the caller's DISPLAY.
func startX11GeometryFixture(t *testing.T) *LinuxX11 {
	t.Helper()
	binary := os.Getenv("CRABFLEET_TEST_XVFB")
	if binary == "" {
		t.Skip("set CRABFLEET_TEST_XVFB to run isolated X11 geometry proof")
	}
	t.Setenv("XAUTHORITY", filepath.Join(t.TempDir(), "fixture.Xauthority"))
	reader, writer, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	log, err := os.Create(filepath.Join(t.TempDir(), "xvfb.log"))
	if err != nil {
		t.Fatal(err)
	}
	defer log.Close()
	cmd := exec.Command(binary, "-displayfd", "3", "-screen", "0", "800x600x24", "-nolisten", "tcp", "-ac", "-noreset")
	cmd.ExtraFiles = []*os.File{writer}
	cmd.Stdout, cmd.Stderr = log, log
	if err := cmd.Start(); err != nil {
		writer.Close()
		t.Fatal(err)
	}
	writer.Close()
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	t.Cleanup(func() {
		_ = cmd.Process.Kill()
		<-done
	})
	line := make(chan string, 1)
	go func() {
		scanner := bufio.NewScanner(reader)
		if scanner.Scan() {
			line <- scanner.Text()
		} else {
			line <- ""
		}
	}()
	var display string
	select {
	case display = <-line:
	case <-time.After(10 * time.Second):
		t.Fatal("private Xvfb startup timed out")
	}
	if _, err := strconv.Atoi(display); err != nil {
		t.Fatalf("private Xvfb returned invalid display %q", display)
	}
	backend, err := NewLinuxX11(":" + display)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = backend.Close() })
	return backend
}

func TestX11LiveGeometry(t *testing.T) {
	backend := startX11GeometryFixture(t)
	ctx := context.Background()
	initial, err := backend.Capture(ctx)
	if err != nil || initial.Width != 800 || initial.Height != 600 || len(initial.Screens) == 0 {
		t.Fatalf("initial capture: %dx%d screens=%v err=%v", initial.Width, initial.Height, initial.Screens, err)
	}
	if backend.DesktopResizeSupported() {
		t.Fatal("fixed-mode Xvfb must not advertise remote resize")
	}
	if err := backend.ResizeDesktop(ctx, initial.DesktopLayout()); err != nil {
		t.Fatalf("apply current server-advertised mode: %v", err)
	}
	layout := DesktopLayout{Width: 640, Height: 480, Screens: []Screen{{ID: initial.Screens[0].ID, Width: 640, Height: 480}}}
	if err := backend.ResizeDesktop(ctx, layout); !errors.Is(err, ErrResizeUnsupported) {
		t.Fatalf("unsupported physical mode: %v", err)
	}
	// Xvfb has a fixed root size. A private drawable exercises the identical
	// geometry/GetImage/SHM path through grow and shrink without host changes.
	connection := backend.connection
	window, err := xproto.NewWindowId(connection)
	if err != nil {
		t.Fatal(err)
	}
	if err := xproto.CreateWindowChecked(connection, 24, window, backend.root, 0, 0, 320, 240, 0, xproto.WindowClassInputOutput, 0, xproto.CwBackPixel, []uint32{0x2468ac}).Check(); err != nil {
		t.Fatal(err)
	}
	if err := xproto.MapWindowChecked(connection, window).Check(); err != nil {
		t.Fatal(err)
	}
	backend.root, backend.randrVersion = window, 0
	for _, size := range [][2]int{{320, 240}, {640, 480}, {160, 120}, {640, 480}} {
		oldSegment := backend.segment
		if err := xproto.ConfigureWindowChecked(connection, window, xproto.ConfigWindowWidth|xproto.ConfigWindowHeight, []uint32{uint32(size[0]), uint32(size[1])}).Check(); err != nil {
			t.Fatal(err)
		}
		if err := xproto.ClearAreaChecked(connection, false, window, 0, 0, 0, 0).Check(); err != nil {
			t.Fatal(err)
		}
		frame, err := backend.Capture(ctx)
		if err != nil {
			t.Fatal(err)
		}
		if err := frame.Validate(); err != nil {
			t.Fatal(err)
		}
		if frame.Width != size[0] || frame.Height != size[1] || len(frame.Pixels) != size[0]*size[1]*4 || backend.segment == oldSegment {
			t.Fatalf("geometry or SHM not replaced: %dx%d length=%d segment=%d", frame.Width, frame.Height, len(frame.Pixels), backend.segment)
		}
		if !bytes.Equal(frame.Pixels[:4], []byte{0x24, 0x68, 0xac, 0xff}) {
			t.Fatalf("wrong captured pixel: %x", frame.Pixels[:4])
		}
		if len(frame.Screens) != 1 || frame.Screens[0].Width != size[0] || frame.Screens[0].Height != size[1] {
			t.Fatalf("stale monitor geometry: %v", frame.Screens)
		}
	}
	if err := backend.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := backend.Capture(ctx); !errors.Is(err, ErrClosed) || len(backend.shmBytes) != 0 {
		t.Fatalf("capture after close or leaked SHM: %v", err)
	}
}

func TestX11LiveMonitorLayout(t *testing.T) {
	backend := startX11GeometryFixture(t)
	if backend.randrVersion < 5 {
		t.Skip("fixture requires RandR 1.5")
	}
	backend.randrVersion = 2
	fallback, err := backend.Capture(context.Background())
	if err != nil || len(fallback.Screens) != 1 || fallback.Screens[0].Width != 800 {
		t.Fatalf("RandR CRTC fallback: %v %v", fallback.Screens, err)
	}
	backend.randrVersion = 5
	connection := backend.connection
	initial, err := randr.GetMonitors(connection, backend.root, true).Reply()
	if err != nil || initial == nil || len(initial.Monitors) != 1 {
		t.Fatalf("initial RandR monitors: %v %v", initial, err)
	}
	for index, name := range []string{"crabfleet-left", "crabfleet-right"} {
		atom, err := xproto.InternAtom(connection, false, uint16(len(name)), name).Reply()
		if err != nil {
			t.Fatal(err)
		}
		monitor := randr.MonitorInfo{Name: atom.Atom, X: int16(index * 400), Width: 400, Height: 600, WidthInMillimeters: 100, HeightInMillimeters: 150}
		if index == 0 {
			monitor.Outputs = initial.Monitors[0].Outputs
			monitor.NOutput = uint16(len(monitor.Outputs))
		}
		if err := randr.SetMonitorChecked(connection, backend.root, monitor).Check(); err != nil {
			t.Fatal(err)
		}
	}
	frame, err := backend.Capture(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if frame.Width != 800 || frame.Height != 600 || len(frame.Screens) != 2 || frame.Screens[0].Width != 400 || frame.Screens[1].X != 400 {
		t.Fatalf("did not capture real RandR layout: dimensions=%dx%d screens=%v", frame.Width, frame.Height, frame.Screens)
	}
	if backend.DesktopResizeSupported() {
		t.Fatal("multi-monitor fixture must not advertise resize")
	}
	frame.Screens[0].Width = 1
	next, err := backend.Capture(context.Background())
	if err != nil || next.Screens[0].Width != 400 {
		t.Fatalf("caller mutated backend layout: %v %v", next.Screens, err)
	}
}
