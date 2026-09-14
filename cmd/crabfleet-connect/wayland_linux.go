//go:build linux

package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"time"

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
	socket := filepath.Join(directory, "vnc.sock")
	config, err := waylandConfig(password)
	if err != nil {
		return err
	}
	defer config.Close()

	helperContext, stopHelper := context.WithCancel(ctx)
	defer stopHelper()
	arguments := []string{
		"--config=/proc/self/fd/3",
		"--socket=" + filepath.Join(directory, "control.sock"),
		"--name=" + desktopName,
		"--max-fps=30",
		"--disable-resizing",
		"--log-level=error",
	}
	if options.output != "" {
		arguments = append(arguments, "--output="+options.output)
	}
	if options.viewOnly {
		arguments = append(arguments, "--disable-input")
	}
	arguments = append(arguments, "unix:"+socket)
	command := exec.CommandContext(helperContext, helper, arguments...)
	command.ExtraFiles = []*os.File{config}
	command.WaitDelay = waylandStopTimeout
	command.Cancel = func() error { return command.Process.Signal(syscall.SIGTERM) }
	command.SysProcAttr = &syscall.SysProcAttr{Pdeathsig: syscall.SIGTERM}
	logs := &helperLog{}
	command.Stdout, command.Stderr = logs, logs
	// Pdeathsig is tied to the creating OS thread. Keep that thread alive until
	// Wait has reaped the helper, including during ordinary Go thread retirement.
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	if err := command.Start(); err != nil {
		return fmt.Errorf("start wayvnc: %w", err)
	}
	_ = config.Close()
	exited := make(chan struct{})
	var helperErr error
	go func() {
		helperErr = command.Wait()
		close(exited)
	}()
	defer func() {
		stopHelper()
		<-exited
	}()

	startupContext, stopStartup := context.WithTimeout(ctx, waylandStartupTimeout)
	err = waitWaylandReady(startupContext, exited, socket)
	stopStartup()
	if err != nil {
		stopHelper()
		<-exited
		if ctx.Err() != nil {
			return nil
		}
		return waylandFailure(fmt.Errorf("Wayland sharing did not start: %w", err), logs, password)
	}
	if ctx.Err() != nil {
		return nil
	}
	proxyContext, stopProxy := context.WithCancel(ctx)
	defer stopProxy()
	go func() {
		select {
		case <-exited:
			stopProxy()
		case <-proxyContext.Done():
		}
	}()
	upstream, err := (&net.Dialer{Timeout: time.Second}).DialContext(proxyContext, "unix", socket)
	if err != nil {
		return err
	}
	backend, err := rfbclient.New(proxyContext, upstream, password)
	if err != nil {
		return err
	}
	err = serveBackend(proxyContext, listener, options, password, desktopName, stdout, backend, "Linux Wayland (wayvnc)")
	if ctx.Err() != nil {
		return nil
	}
	select {
	case <-exited:
		if helperErr == nil {
			helperErr = errors.New("helper stopped unexpectedly")
		}
		return waylandFailure(fmt.Errorf("wayvnc exited: %w", helperErr), logs, password)
	default:
		return err
	}
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
