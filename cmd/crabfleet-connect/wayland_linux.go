//go:build linux

package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/openclaw/crabfleet/internal/connect"
	"github.com/openclaw/crabfleet/internal/rfbclient"
	"golang.org/x/sys/unix"
)

const (
	waylandStartupTimeout = 10 * time.Second
	waylandStopTimeout    = 2 * time.Second
)

// Wayvnc stays behind a private Unix socket. The connector owns the public
// listener and helper lifetime; all viewers use the common Crabfleet server.
func serveWayland(ctx context.Context, listener net.Listener, options shareOptions, password, desktopName string, stdout io.Writer) error {
	helper, err := exec.LookPath("wayvnc")
	if err != nil {
		return errors.New("Wayland sharing requires wayvnc 0.10 or newer in PATH; install wayvnc and run inside a Hyprland or wlroots desktop session")
	}
	if os.Getenv("WAYLAND_DISPLAY") == "" {
		return errors.New("WAYLAND_DISPLAY is unset; run crabfleet-connect from a terminal inside your Wayland desktop session")
	}
	if err := ctx.Err(); err != nil {
		return nil
	}
	directory, err := os.MkdirTemp("", "crabfleet-connect-")
	if err != nil {
		return fmt.Errorf("create private Wayland runtime directory: %w", err)
	}
	defer os.RemoveAll(directory)
	// Pdeathsig belongs to the spawning thread. Keep it alive until every
	// helper has been stopped and reaped.
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	helperContext, stopHelpers := context.WithCancel(ctx)
	defer stopHelpers()
	var helpers []*waylandHelper
	defer func() {
		stopHelpers()
		for _, helper := range helpers {
			helper.close()
		}
	}()
	start := func(index int, output string) (*waylandHelper, error) {
		helperOptions := options
		helperOptions.output = output
		h, err := startWaylandHelper(helperContext, helper, directory, index, helperOptions, password, desktopName)
		if err != nil {
			return nil, err
		}
		helpers = append(helpers, h)
		return h, nil
	}
	first, err := start(0, options.output)
	if err != nil {
		if ctx.Err() != nil {
			return nil
		}
		return err
	}
	outputs := []waylandOutput{{Name: options.output}}
	if options.allMonitors {
		outputs, err = listWaylandOutputs(helperContext, first.control)
		if err != nil {
			return fmt.Errorf("enumerate Wayland outputs: %w", err)
		}
		// Enumeration has no public viewer. Restart with explicit output names so
		// every long-lived helper is assigned exactly one selected monitor.
		first.close()
		helpers = nil
	}
	var backends []connect.Backend
	defer func() {
		for _, backend := range backends {
			_ = backend.Close()
		}
	}()
	for index, output := range outputs {
		h := first
		if options.allMonitors {
			h, err = start(index+1, output.Name)
			if err != nil {
				return err
			}
		}
		go func(h *waylandHelper) {
			select {
			case <-h.exited:
				stopHelpers()
			case <-helperContext.Done():
			}
		}(h)
		var guard *waylandOutputGuard
		if options.allMonitors || output.Name != "" {
			guard = &waylandOutputGuard{output: output.Name, control: h.control, stop: stopHelpers, aggregate: options.allMonitors}
			if err := guard.check(helperContext); err != nil {
				return err
			}
		}
		upstream, err := (&net.Dialer{Timeout: time.Second}).DialContext(helperContext, "unix", h.socket)
		if err != nil {
			return err
		}
		backend, err := rfbclient.New(helperContext, upstream, password)
		if err != nil {
			return err
		}
		if guard != nil {
			guard.backend = backend
			backends = append(backends, guard)
		} else {
			backends = append(backends, backend)
		}
	}
	var backend connect.Backend = backends[0]
	if options.allMonitors {
		backend = newWaylandDesktop(backends, options.allowResize)
	}
	err = serveBackend(helperContext, listener, options, password, desktopName, stdout, backend, "Linux Wayland (wayvnc)")
	if ctx.Err() != nil {
		return nil
	}
	for _, backend := range backends {
		if guard, ok := backend.(*waylandOutputGuard); ok {
			if failure := guard.failure(); failure != nil {
				return failure
			}
		}
	}
	for _, h := range helpers {
		select {
		case <-h.exited:
			helperErr := h.err
			if helperErr == nil {
				helperErr = errors.New("helper stopped unexpectedly")
			}
			return waylandFailure(fmt.Errorf("wayvnc exited: %w", helperErr), h.logs, password)
		default:
		}
	}
	return err
}

type waylandHelper struct {
	socket, control string
	cancel          context.CancelFunc
	exited          chan struct{}
	err             error
	logs            *helperLog
}

func (h *waylandHelper) close() { h.cancel(); <-h.exited }

func waylandArguments(directory string, index int, options shareOptions, desktopName string) []string {
	arguments := []string{
		"--config=/proc/self/fd/3",
		"--socket=" + filepath.Join(directory, fmt.Sprintf("control-%d.sock", index)),
		"--name=" + desktopName, "--max-fps=30", "--log-level=error",
	}
	if !options.allowResize {
		arguments = append(arguments, "--disable-resizing")
	}
	if options.output != "" {
		arguments = append(arguments, "--output="+options.output)
	}
	if options.viewOnly {
		arguments = append(arguments, "--disable-input")
	}
	return append(arguments, "unix:"+filepath.Join(directory, fmt.Sprintf("vnc-%d.sock", index)))
}

func startWaylandHelper(ctx context.Context, executable, directory string, index int, options shareOptions, password, desktopName string) (*waylandHelper, error) {
	config, err := waylandConfig(password)
	if err != nil {
		return nil, err
	}
	defer config.Close()
	helperContext, cancel := context.WithCancel(ctx)
	h := &waylandHelper{socket: filepath.Join(directory, fmt.Sprintf("vnc-%d.sock", index)), control: filepath.Join(directory, fmt.Sprintf("control-%d.sock", index)), cancel: cancel, exited: make(chan struct{}), logs: &helperLog{}}
	command := exec.CommandContext(helperContext, executable, waylandArguments(directory, index, options, desktopName)...)
	command.ExtraFiles = []*os.File{config}
	command.WaitDelay = waylandStopTimeout
	command.Cancel = func() error { return command.Process.Signal(syscall.SIGTERM) }
	command.SysProcAttr = &syscall.SysProcAttr{Pdeathsig: syscall.SIGTERM}
	command.Stdout, command.Stderr = h.logs, h.logs
	if err := command.Start(); err != nil {
		cancel()
		return nil, fmt.Errorf("start wayvnc: %w", err)
	}
	go func() { h.err = command.Wait(); close(h.exited) }()
	startupContext, stopStartup := context.WithTimeout(ctx, waylandStartupTimeout)
	err = waitWaylandReady(startupContext, h.exited, h.socket)
	stopStartup()
	if err != nil {
		h.close()
		return nil, waylandFailure(fmt.Errorf("Wayland sharing did not start: %w", err), h.logs, password)
	}
	return h, nil
}

type waylandOutput struct {
	Name     string `json:"name"`
	Width    int    `json:"width"`
	Height   int    `json:"height"`
	Captured bool   `json:"captured"`
}

// wayvnc output-list does not expose compositor positions. Present monitors in
// stable name order, side by side, using their actual captured pixel sizes.
func listWaylandOutputs(ctx context.Context, socket string) ([]waylandOutput, error) {
	return readWaylandOutputs(ctx, socket, true)
}

func readWaylandOutputs(ctx context.Context, socket string, aggregate bool) ([]waylandOutput, error) {
	conn, err := (&net.Dialer{Timeout: time.Second}).DialContext(ctx, "unix", socket)
	if err != nil {
		return nil, err
	}
	defer conn.Close()
	deadline := time.Now().Add(2 * time.Second)
	if end, ok := ctx.Deadline(); ok && end.Before(deadline) {
		deadline = end
	}
	if err := conn.SetDeadline(deadline); err != nil {
		return nil, err
	}
	stop := context.AfterFunc(ctx, func() { _ = conn.Close() })
	defer stop()
	if _, err := io.WriteString(conn, `{ "method": "output-list", "id": 1 }`); err != nil {
		return nil, err
	}
	var response struct {
		Code *int            `json:"code"`
		ID   int             `json:"id"`
		Data []waylandOutput `json:"data"`
	}
	if err := json.NewDecoder(io.LimitReader(conn, 64*1024)).Decode(&response); err != nil {
		return nil, err
	}
	if response.Code == nil || *response.Code != 0 || response.ID != 1 {
		return nil, errors.New("wayvnc output-list failed")
	}
	if len(response.Data) < 1 || len(response.Data) > 16 {
		return nil, errors.New("Wayland sharing requires between 1 and 16 outputs")
	}
	seen := make(map[string]bool)
	width, height := 0, 0
	for _, output := range response.Data {
		if output.Name == "" || len(output.Name) > 256 || strings.ContainsAny(output.Name, "\x00\r\n") || seen[output.Name] || output.Width < 1 || output.Height < 1 || output.Width > connect.MaxDimension || output.Height > connect.MaxDimension {
			return nil, errors.New("wayvnc returned invalid output metadata")
		}
		seen[output.Name] = true
		width += output.Width
		height = max(height, output.Height)
		if aggregate && (width > connect.MaxDimension || int64(width)*int64(height)*4 > connect.MaxFrameBytes) {
			return nil, errors.New("combined Wayland desktop exceeds framebuffer limits")
		}
	}
	sort.Slice(response.Data, func(i, j int) bool { return response.Data[i].Name < response.Data[j].Name })
	return response.Data, nil
}

func waylandConfig(password string) (*os.File, error) {
	if len(password) != 8 || strings.IndexFunc(password, func(r rune) bool {
		return !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9')
	}) >= 0 {
		return nil, errors.New("invalid Wayland share password")
	}
	fd, err := unix.MemfdCreate("crabfleet-wayvnc", unix.MFD_CLOEXEC|unix.MFD_ALLOW_SEALING)
	if err != nil {
		return nil, fmt.Errorf("create anonymous Wayland configuration: %w", err)
	}
	file := os.NewFile(uintptr(fd), "crabfleet-wayvnc")
	// VNC-DES matches the native connector's direct-listener contract. It is
	// authenticated but unencrypted, so the external listener defaults to loopback.
	_, err = fmt.Fprintf(file, "enable_auth=true\nrelax_encryption=true\nallow_broken_crypto=true\npassword=%s\n", password)
	if err == nil {
		_, err = file.Seek(0, io.SeekStart)
	}
	if err == nil {
		_, err = unix.FcntlInt(file.Fd(), unix.F_ADD_SEALS, unix.F_SEAL_SHRINK|unix.F_SEAL_GROW|unix.F_SEAL_WRITE|unix.F_SEAL_SEAL)
	}
	if err != nil {
		_ = file.Close()
		return nil, fmt.Errorf("prepare Wayland configuration: %w", err)
	}
	return file, nil
}

func waitWaylandReady(ctx context.Context, exited <-chan struct{}, socket string) error {
	ticker := time.NewTicker(25 * time.Millisecond)
	defer ticker.Stop()
	for {
		connection, err := (&net.Dialer{Timeout: 200 * time.Millisecond}).DialContext(ctx, "unix", socket)
		if err == nil {
			err = checkWaylandAuthentication(connection)
			_ = connection.Close()
			return err
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-exited:
			return errors.New("helper exited before becoming ready (wayvnc 0.10+ and a supported Wayland compositor are required)")
		case <-ticker.C:
		}
	}
}

// Validate the helper's actual security offer before admitting any TCP viewer.
// A distro build without working VNC authentication must never open a share.
func checkWaylandAuthentication(connection net.Conn) error {
	if err := connection.SetDeadline(time.Now().Add(time.Second)); err != nil {
		return err
	}
	banner := make([]byte, 12)
	if _, err := io.ReadFull(connection, banner); err != nil {
		return fmt.Errorf("read helper RFB greeting: %w", err)
	}
	if string(banner) != "RFB 003.008\n" {
		return errors.New("wayvnc did not offer RFB 3.8")
	}
	if _, err := io.Copy(connection, bytes.NewReader(banner)); err != nil {
		return err
	}
	count := []byte{0}
	if _, err := io.ReadFull(connection, count); err != nil {
		return err
	}
	securityTypes := make([]byte, int(count[0]))
	if _, err := io.ReadFull(connection, securityTypes); err != nil {
		return err
	}
	if bytes.Contains(securityTypes, []byte{1}) || !bytes.Contains(securityTypes, []byte{2}) {
		return errors.New("wayvnc must require authentication and offer VNC password security")
	}
	return nil
}

type helperLog struct {
	mutex sync.Mutex
	data  []byte
}

func (log *helperLog) Write(payload []byte) (int, error) {
	log.mutex.Lock()
	defer log.mutex.Unlock()
	remaining := 16*1024 - len(log.data)
	log.data = append(log.data, payload[:min(len(payload), remaining)]...)
	return len(payload), nil
}

func waylandFailure(err error, log *helperLog, password string) error {
	log.mutex.Lock()
	defer log.mutex.Unlock()
	detail := strings.TrimSpace(strings.ReplaceAll(string(log.data), password, "[redacted]"))
	if detail == "" {
		return err
	}
	return fmt.Errorf("%w: %s", err, detail)
}
