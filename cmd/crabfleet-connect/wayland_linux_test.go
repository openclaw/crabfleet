//go:build linux

package main

import (
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"io"
	"net"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/openclaw/crabfleet/internal/connect"
	"github.com/openclaw/crabfleet/internal/rfb"
)

func TestNativeFailureDoesNotShareSyntheticDesktop(t *testing.T) {
	backend, _, err := selectBackend(false, ":65534")
	if backend != nil || err == nil || !strings.Contains(err.Error(), "native capture unavailable") {
		t.Fatalf("native failure returned backend %T, error %v", backend, err)
	}
}

func TestWaylandConfigIsAnonymousSealedAndAuthenticated(t *testing.T) {
	t.Parallel()
	file, err := waylandConfig("fixture1")
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	config, err := io.ReadAll(file)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(config, []byte("enable_auth=true\n")) || !bytes.Contains(config, []byte("password=fixture1\n")) {
		t.Fatal("configuration did not require the share password")
	}
	if _, err := file.WriteAt([]byte("x"), 0); err == nil {
		t.Fatal("helper configuration was writable after sealing")
	}
	if _, err := os.Stat(file.Name()); !os.IsNotExist(err) {
		t.Fatal("configuration has a persistent filesystem path")
	}
	if file, err := waylandConfig("bad\npass"); err == nil {
		file.Close()
		t.Fatal("accepted configuration injection")
	}
}

func TestWaylandReadinessRequiresVNCAndRejectsNone(t *testing.T) {
	t.Parallel()
	for _, test := range []struct {
		name    string
		offer   []byte
		invalid bool
	}{
		{"VNC", []byte{1, 2}, false},
		{"VNC and ARD", []byte{2, 30, 2}, false},
		{"None", []byte{1, 1}, true},
		{"None and VNC", []byte{2, 1, 2}, true},
		{"no types", []byte{0}, true},
		{"no VNC", []byte{1, 30}, true},
	} {
		t.Run(test.name, func(t *testing.T) {
			helper, client := net.Pipe()
			defer client.Close()
			go func() {
				defer helper.Close()
				_, _ = helper.Write([]byte("RFB 003.008\n"))
				_, _ = io.ReadFull(helper, make([]byte, 12))
				_, _ = helper.Write(test.offer)
			}()
			if err := checkWaylandAuthentication(client); (err != nil) != test.invalid {
				t.Fatalf("readiness error=%v, want invalid=%v", err, test.invalid)
			}
		})
	}
}

func TestWaylandReadinessStopsWhenHelperExits(t *testing.T) {
	t.Parallel()
	exited := make(chan struct{})
	close(exited)
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := waitWaylandReady(ctx, exited, filepath.Join(t.TempDir(), "missing")); err == nil || errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("helper exit was not reported promptly: %v", err)
	}
}

func TestWaylandDiagnosticsAreBoundedAndRedacted(t *testing.T) {
	t.Parallel()
	log := &helperLog{}
	_, _ = log.Write([]byte("fixture1: bad config\n"))
	_, _ = log.Write(bytes.Repeat([]byte{'x'}, 32*1024))
	err := waylandFailure(errors.New("failed"), log, "fixture1")
	if len(err.Error()) > 17*1024 || strings.Contains(err.Error(), "fixture1") || !strings.Contains(err.Error(), "[redacted]") {
		t.Fatal("helper diagnostics were unbounded or revealed the share password")
	}
}

// The subprocess emulates only the installed helper boundary. The actual RFB
// session uses our independent synthetic server, including authentication.
func TestWayvncHelperProcess(t *testing.T) {
	mode := os.Getenv("CRABFLEET_TEST_HELPER_MODE")
	if mode == "" {
		return
	}
	config, err := os.ReadFile("/proc/self/fd/3")
	if err != nil || !bytes.Contains(config, []byte("enable_auth=true\n")) || !bytes.Contains(config, []byte("password=fixture1\n")) {
		t.Fatal("helper received an incorrect config FD")
	}
	if mode == "fail" {
		_, _ = os.Stderr.WriteString("fixture1: compositor unavailable")
		os.Exit(23)
	}
	var socket string
	for _, argument := range os.Args {
		if strings.Contains(argument, "fixture1") {
			t.Fatal("password leaked into helper arguments")
		}
		if strings.HasPrefix(argument, "unix:") {
			socket = strings.TrimPrefix(argument, "unix:")
		}
	}
	info, err := os.Stat(filepath.Dir(socket))
	if err != nil || info.Mode().Perm() != 0o700 {
		t.Fatal("helper socket is not in a private directory")
	}
	if err := os.WriteFile(os.Getenv("CRABFLEET_TEST_HELPER_SOCKET"), []byte(socket), 0o600); err != nil {
		t.Fatal(err)
	}
	listener, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	backend, err := connect.NewSynthetic(connect.SyntheticOptions{Width: 32, Height: 18})
	if err != nil {
		t.Fatal(err)
	}
	server, err := rfb.NewServer(rfb.ServerConfig{Session: rfb.SessionConfig{Backend: backend, Password: "fixture1"}})
	if err != nil {
		t.Fatal(err)
	}
	defer server.Close()
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM)
	defer stop()
	if err := server.Serve(ctx, listener); err != nil {
		t.Fatal(err)
	}
}

func installWaylandFixture(t *testing.T, mode string) string {
	t.Helper()
	directory := t.TempDir()
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	script := "#!/bin/sh\nexec '" + strings.ReplaceAll(executable, "'", "'\\''") + "' -test.run='^TestWayvncHelperProcess$' -- \"$@\"\n"
	if err := os.WriteFile(filepath.Join(directory, "wayvnc"), []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", directory)
	t.Setenv("WAYLAND_DISPLAY", "wayland-fixture")
	t.Setenv("CRABFLEET_TEST_HELPER_MODE", mode)
	socketRecord := filepath.Join(directory, "socket-path")
	t.Setenv("CRABFLEET_TEST_HELPER_SOCKET", socketRecord)
	return socketRecord
}

type readyOutput struct {
	bytes.Buffer
	ready chan struct{}
	once  sync.Once
}

func (output *readyOutput) Write(payload []byte) (int, error) {
	n, err := output.Buffer.Write(payload)
	if bytes.Contains(payload, []byte("Share password:")) {
		output.once.Do(func() { close(output.ready) })
	}
	return n, err
}

func TestWaylandHelperLifecycle(t *testing.T) {
	socketRecord := installWaylandFixture(t, "serve")
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	output := &readyOutput{ready: make(chan struct{})}
	done := make(chan error, 1)
	go func() { done <- serveWayland(ctx, listener, shareOptions{}, "fixture1", "Fixture", output) }()
	select {
	case <-output.ready:
	case err := <-done:
		t.Fatalf("helper startup failed: %v", err)
	case <-time.After(5 * time.Second):
		t.Fatal("helper startup did not complete")
	}
	client := authenticateWaylandViewer(t, listener.Addr().String(), "fixture1", true)
	defer client.Close()
	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("connector did not reap the helper")
	}
	socket, err := os.ReadFile(socketRecord)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Dir(string(socket))); !os.IsNotExist(err) {
		t.Fatal("connector retained its private runtime directory")
	}
	if _, err := client.Read(make([]byte, 1)); err == nil {
		t.Fatal("viewer survived helper shutdown")
	}
}

func TestWaylandHelperFailureDoesNotAnnounceShare(t *testing.T) {
	installWaylandFixture(t, "fail")
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	var output bytes.Buffer
	err = serveWayland(context.Background(), listener, shareOptions{}, "fixture1", "Fixture", &output)
	if err == nil || !strings.Contains(err.Error(), "compositor unavailable") || strings.Contains(err.Error(), "fixture1") || output.Len() != 0 {
		t.Fatal("failed helper announced a share or lost/redacted diagnostics incorrectly")
	}
}

func authenticateWaylandViewer(t *testing.T, address, password string, accepted bool) net.Conn {
	t.Helper()
	client, err := net.DialTimeout("tcp", address, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = client.Close() })
	_ = client.SetDeadline(time.Now().Add(5 * time.Second))
	read := func(size int) []byte {
		result := make([]byte, size)
		if _, err := io.ReadFull(client, result); err != nil {
			t.Fatal(err)
		}
		return result
	}
	if string(read(12)) != "RFB 003.008\n" {
		t.Fatal("unexpected RFB greeting")
	}
	_, _ = client.Write([]byte("RFB 003.008\n"))
	security := read(int(read(1)[0]))
	if bytes.Contains(security, []byte{1}) || !bytes.Contains(security, []byte{2}) {
		t.Fatal("public listener did not require VNC authentication")
	}
	_, _ = client.Write([]byte{2})
	response, err := rfb.VNCChallengeResponse(read(16), password)
	if err != nil {
		t.Fatal(err)
	}
	_, _ = client.Write(response)
	if (binary.BigEndian.Uint32(read(4)) == 0) != accepted {
		t.Fatal("unexpected VNC authentication result")
	}
	return client
}

// Opt in only in a disposable compositor, never the operator's active desktop.
func TestWaylandLiveCapture(t *testing.T) {
	if os.Getenv("CRABFLEET_TEST_WAYLAND") != "1" {
		t.Skip("requires a disposable Wayland compositor and wayvnc 0.10+")
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	output := &readyOutput{ready: make(chan struct{})}
	done := make(chan error, 1)
	go func() {
		done <- serveWayland(ctx, listener, shareOptions{output: "HEADLESS-1", viewOnly: true}, "fixture1", "Crabfleet Linux proof", output)
	}()
	select {
	case <-output.ready:
	case err := <-done:
		t.Fatal(err)
	case <-time.After(12 * time.Second):
		t.Fatal("Wayland connector did not become ready")
	}
	badClient := authenticateWaylandViewer(t, listener.Addr().String(), "wrongone", false)
	_ = badClient.Close()
	client := authenticateWaylandViewer(t, listener.Addr().String(), "fixture1", true)
	_, _ = client.Write([]byte{1})
	init := make([]byte, 24)
	if _, err := io.ReadFull(client, init); err != nil {
		t.Fatal(err)
	}
	width, height := binary.BigEndian.Uint16(init), binary.BigEndian.Uint16(init[2:])
	if width != 640 || height != 480 || init[4] != 32 {
		t.Fatalf("unexpected fixture framebuffer: %dx%d, %d bpp", width, height, init[4])
	}
	nameLength := binary.BigEndian.Uint32(init[20:])
	if nameLength > 1024 {
		t.Fatal("invalid desktop name length")
	}
	_, err = io.CopyN(io.Discard, client, int64(nameLength))
	if err != nil {
		t.Fatal(err)
	}
	// Ask for raw pixels so this verifies real compositor capture independently
	// of the helper's codec choices and our Go synthetic JPEG implementation.
	_, _ = client.Write([]byte{2, 0, 0, 1, 0, 0, 0, 0})
	request := []byte{3, 0, 0, 0, 0, 0, 0, 0, 0, 0}
	binary.BigEndian.PutUint16(request[6:], width)
	binary.BigEndian.PutUint16(request[8:], height)
	_, _ = client.Write(request)
	header := make([]byte, 16)
	if _, err := io.ReadFull(client, header); err != nil {
		t.Fatal(err)
	}
	if header[0] != 0 || binary.BigEndian.Uint16(header[2:]) != 1 || binary.BigEndian.Uint32(header[12:]) != 0 {
		t.Fatal("expected one raw framebuffer rectangle")
	}
	if _, err := io.CopyN(io.Discard, client, int64(width)*int64(height)*4); err != nil {
		t.Fatalf("read real Wayland frame: %v", err)
	}
	t.Logf("captured %dx%d real Wayland pixels; correct password accepted and wrong password rejected", width, height)
	_ = client.Close()
	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Wayland connector did not stop")
	}
}

func TestWaylandLiveInput(t *testing.T) {
	if os.Getenv("CRABFLEET_TEST_WAYLAND") != "1" {
		t.Skip("requires a disposable Wayland compositor, wayvnc 0.10+, and wev")
	}
	wev, err := exec.LookPath("wev")
	if err != nil {
		t.Fatal("install wev for the live Wayland input test")
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	events := &helperLog{}
	probe := exec.CommandContext(ctx, "stdbuf", "-oL", wev)
	probe.Stdout, probe.Stderr = events, events
	probe.WaitDelay = time.Second
	if err := probe.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { cancel(); _ = probe.Wait() }()
	waitEvent := func(fragment string) {
		t.Helper()
		ticker := time.NewTicker(10 * time.Millisecond)
		defer ticker.Stop()
		timeout := time.NewTimer(5 * time.Second)
		defer timeout.Stop()
		for {
			events.mutex.Lock()
			found := bytes.Contains(events.data, []byte(fragment))
			events.mutex.Unlock()
			if found {
				return
			}
			select {
			case <-ticker.C:
			case <-timeout.C:
				t.Fatalf("Wayland event probe did not receive %q", fragment)
			}
		}
	}
	waitEvent("activated")
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	output := &readyOutput{ready: make(chan struct{})}
	done := make(chan error, 1)
	go func() {
		done <- serveWayland(ctx, listener, shareOptions{output: "HEADLESS-1"}, "fixture1", "Crabfleet Linux input proof", output)
	}()
	defer func() {
		cancel()
		select {
		case err := <-done:
			if err != nil {
				t.Error(err)
			}
		case <-time.After(5 * time.Second):
			t.Error("Wayland input connector did not stop")
		}
	}()
	select {
	case <-output.ready:
	case <-time.After(12 * time.Second):
		t.Fatal("Wayland connector did not become ready")
	}
	client := authenticateWaylandViewer(t, listener.Addr().String(), "fixture1", true)
	_, _ = client.Write([]byte{1})
	init := make([]byte, 24)
	if _, err := io.ReadFull(client, init); err != nil {
		t.Fatal(err)
	}
	nameLength := binary.BigEndian.Uint32(init[20:])
	if nameLength > 1024 {
		t.Fatal("invalid desktop name length")
	}
	if _, err := io.CopyN(io.Discard, client, int64(nameLength)); err != nil {
		t.Fatal(err)
	}
	// Move into the focused probe, click, then type one key through the actual
	// RFB connection. Wev observes compositor events, independently of our host.
	for _, payload := range [][]byte{
		{5, 0, 0, 100, 0, 100},
		{5, 1, 0, 100, 0, 100},
		{5, 0, 0, 100, 0, 100},
		{4, 1, 0, 0, 0, 0, 0, 'a'},
		{4, 0, 0, 0, 0, 0, 0, 'a'},
	} {
		if _, err := client.Write(payload); err != nil {
			t.Fatal(err)
		}
	}
	waitEvent("sym: a")
	waitEvent("button: 272")
	t.Log("independent Wayland client observed the remote key and mouse button")
}
