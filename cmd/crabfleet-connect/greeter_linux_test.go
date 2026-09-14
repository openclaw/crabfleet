//go:build linux

package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"os"
	"os/exec"
	"os/signal"
	"os/user"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

func TestGreeterArguments(t *testing.T) {
	args := []string{"--config-dir", "/private/greeter", "--fleet", "--output", "DP-1", "--", "/usr/bin/start-hyprland", "--", "--config", "/path with spaces/greeter.lua", "$(literal)"}
	options, err := parseGreeterOptions(args, io.Discard)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(options.compositor, args[6:]) {
		t.Fatalf("compositor arguments changed: %q", options.compositor)
	}
	want := []string{"share", "--backend", "wayland", "--config-dir", "/private/greeter", "--bind", "127.0.0.1", "--port", "5901", "--quiet", "--clipboard=false", "--video", "jpeg", "--name", "Linux login screen", "--output", "DP-1", "--fleet"}
	if got := greeterShareArguments(options); !reflect.DeepEqual(got, want) {
		t.Fatalf("share arguments: %q", got)
	}
	if err := runShare(context.Background(), want[1:], io.Discard, io.Discard, true); err != nil {
		t.Fatalf("greeter invokes invalid sharing flags: %v", err)
	}
	for _, args := range [][]string{{}, {"--", "relative"}, {"--port", "invalid", "--", "/bin/true"}} {
		if _, err := parseGreeterOptions(args, io.Discard); err == nil {
			t.Fatalf("accepted invalid options %q", args)
		}
	}
}

func TestGreeterConfigurationValidation(t *testing.T) {
	account, err := user.Current()
	if err != nil {
		t.Fatal(err)
	}
	if os.Geteuid() == 0 {
		t.Skip("greeter intentionally rejects root")
	}
	directory := t.TempDir()
	if err := os.Chmod(directory, 0700); err != nil {
		t.Fatal(err)
	}
	helper := filepath.Join(t.TempDir(), "wayvnc")
	if err := os.WriteFile(helper, []byte("#!/bin/sh\nexit 0\n"), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", filepath.Dir(helper))
	options := greeterOptions{directory: directory, username: account.Username, compositor: []string{"/bin/true"}, port: 5901, timeout: time.Second}
	if err := validateGreeter(options); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(directory, "state.json")); !os.IsNotExist(err) {
		t.Fatal("validation created state")
	}
	options.fleet = true
	if err := validateGreeter(options); err == nil {
		t.Fatal("Fleet accepted absent authorization")
	}
	options.fleet = false
	statePath := filepath.Join(directory, "state.json")
	if err := os.WriteFile(statePath, []byte(`{"version":1,"hostId":"fixture-greeter"}`), 0600); err != nil {
		t.Fatal(err)
	}
	if err := validateGreeter(options); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(statePath, 0644); err != nil {
		t.Fatal(err)
	}
	if err := validateGreeter(options); err == nil {
		t.Fatal("accepted readable greeter state")
	}
	if err := os.Remove(statePath); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("/dev/null", statePath); err != nil {
		t.Fatal(err)
	}
	if err := validateGreeter(options); err == nil {
		t.Fatal("accepted symlink state")
	}
}

func TestGreeterCheckAndInvalidSharingPreserveCompositor(t *testing.T) {
	for _, invalid := range [][]string{
		{"--user", "crabfleet-no-such-greeter-fixture"},
		{"--port", "0"}, {"--port", "65536"},
		{"--socket-timeout", "0"}, {"--socket-timeout", "3m"},
	} {
		args := append(append([]string{}, invalid...), "--config-dir", t.TempDir(), "--", "/bin/sh", "-c", "printf compositor-ready")
		if err := runGreeter(context.Background(), append([]string{"--check"}, args...), io.Discard, io.Discard); err == nil {
			t.Fatalf("check accepted invalid configuration %q", invalid)
		}
		var stdout bytes.Buffer
		if err := runGreeter(context.Background(), args, &stdout, io.Discard); err != nil {
			t.Fatalf("invalid sharing configuration prevented original compositor: %v", err)
		}
		if stdout.String() != "compositor-ready" {
			t.Fatalf("original compositor did not run for %q", invalid)
		}
	}
}

func TestGreeterPrivateDirectoryAndSocketSelection(t *testing.T) {
	directory := t.TempDir()
	if err := os.Chmod(directory, 0700); err != nil {
		t.Fatal(err)
	}
	uid := os.Geteuid()
	if err := greeterPrivateDirectory(directory, uid+1); err == nil {
		t.Fatal("accepted another owner's directory")
	}
	symlink := filepath.Join(t.TempDir(), "runtime")
	if err := os.Symlink(directory, symlink); err != nil {
		t.Fatal(err)
	}
	if err := greeterPrivateDirectory(symlink, uid); err == nil {
		t.Fatal("accepted symlink runtime")
	}
	old, err := net.Listen("unix", filepath.Join(directory, "wayland-old"))
	if err != nil {
		t.Fatal(err)
	}
	defer old.Close()
	existing, err := greeterSockets(directory, uid)
	if err != nil {
		t.Fatal(err)
	}
	if name, err := newGreeterSocket(directory, existing, uid); err != nil || name != "" {
		t.Fatalf("selected existing desktop %q: %v", name, err)
	}
	if err := os.Symlink(filepath.Join(directory, "wayland-old"), filepath.Join(directory, "wayland-link")); err != nil {
		t.Fatal(err)
	}
	if name, err := newGreeterSocket(directory, existing, uid); err != nil || name != "" {
		t.Fatalf("selected socket symlink %q: %v", name, err)
	}
	first, err := net.Listen("unix", filepath.Join(directory, "wayland-new"))
	if err != nil {
		t.Fatal(err)
	}
	defer first.Close()
	if name, err := newGreeterSocket(directory, existing, uid); err != nil || name != "wayland-new" {
		t.Fatalf("new socket %q: %v", name, err)
	}
	second, err := net.Listen("unix", filepath.Join(directory, "wayland-second"))
	if err != nil {
		t.Fatal(err)
	}
	defer second.Close()
	if _, err := newGreeterSocket(directory, existing, uid); err == nil {
		t.Fatal("accepted ambiguous sockets")
	}
	if err := os.Chmod(directory, 0755); err != nil {
		t.Fatal(err)
	}
	if _, err := greeterSockets(directory, uid); err == nil {
		t.Fatal("accepted public runtime")
	}
}

func TestGreeterOwnershipRejectsUIDTruncation(t *testing.T) {
	info, err := os.Stat(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	uid := os.Geteuid()
	if !greeterOwned(info, uid) {
		t.Fatal("rejected the directory's actual owner")
	}
	if greeterOwned(info, -1) {
		t.Fatal("accepted a negative UID")
	}
	if strconv.IntSize == 64 {
		wrappedUID := int(int64(uid) + 1<<32)
		if greeterOwned(info, wrappedUID) {
			t.Fatal("accepted an oversized UID that truncates to the actual owner")
		}
	}
}

type greeterFixtureRecord struct {
	PID, ChildPID int
	Arguments     []string
	Socket        string
	Display       string
}

func TestGreeterFixture(t *testing.T) {
	role := os.Getenv("CRABFLEET_GREETER_FIXTURE_ROLE")
	if role == "" {
		return
	}
	directory := os.Getenv("CRABFLEET_GREETER_FIXTURE_DIR")
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, syscall.SIGTERM, os.Interrupt)
	defer signal.Stop(signals)
	if role == "descendant" {
		<-signals
		return
	}
	child := exec.Command(os.Args[0], "-test.run=^TestGreeterFixture$")
	child.Env = append(os.Environ(), "CRABFLEET_GREETER_FIXTURE_ROLE=descendant")
	if err := child.Start(); err != nil {
		t.Fatal(err)
	}
	var args []string
	for i, value := range os.Args {
		if value == "--" {
			args = os.Args[i+1:]
			break
		}
	}
	record := greeterFixtureRecord{PID: os.Getpid(), ChildPID: child.Process.Pid, Arguments: args, Socket: os.Getenv("WAYLAND_DISPLAY"), Display: os.Getenv("DISPLAY")}
	data, _ := json.Marshal(record)
	if err := os.WriteFile(filepath.Join(directory, role+".json"), data, 0600); err != nil {
		t.Fatal(err)
	}
	if role == "compositor" && os.Getenv("CRABFLEET_GREETER_FIXTURE_NO_SOCKET") == "" {
		listener, err := net.Listen("unix", filepath.Join(os.Getenv("XDG_RUNTIME_DIR"), "wayland-greeter"))
		if err != nil {
			t.Fatal(err)
		}
		defer listener.Close()
	}
	if role == "helper" && os.Getenv("CRABFLEET_GREETER_FIXTURE_FAIL_HELPER") == "1" {
		os.Exit(23)
	}
	for {
		select {
		case <-signals:
			_ = child.Process.Signal(syscall.SIGTERM)
			_ = child.Wait()
			return
		case <-time.After(20 * time.Millisecond):
			if _, err := os.Stat(filepath.Join(directory, role+".exit")); err == nil {
				// Leave a descendant behind to exercise wrapper group cleanup.
				return
			}
		}
	}
}

func greeterFixture(t *testing.T) (greeterOptions, string, string) {
	t.Helper()
	directory := t.TempDir()
	runtimeDirectory := filepath.Join(directory, "runtime")
	if err := os.Mkdir(runtimeDirectory, 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CRABFLEET_GREETER_FIXTURE_DIR", directory)
	t.Setenv("CRABFLEET_GREETER_FIXTURE_ROLE", "compositor")
	t.Setenv("CRABFLEET_GREETER_FIXTURE_BINARY", os.Args[0])
	t.Setenv("XDG_RUNTIME_DIR", runtimeDirectory)
	t.Setenv("WAYLAND_DISPLAY", "wayland-user-must-not-be-shared")
	t.Setenv("DISPLAY", ":never-use")
	helper := filepath.Join(directory, "helper")
	if err := os.WriteFile(helper, []byte("#!/bin/sh\nexport CRABFLEET_GREETER_FIXTURE_ROLE=helper\nexec \"$CRABFLEET_GREETER_FIXTURE_BINARY\" -test.run='^TestGreeterFixture$' -- \"$@\"\n"), 0700); err != nil {
		t.Fatal(err)
	}
	options := greeterOptions{directory: filepath.Join(directory, "state"), name: "Fixture login screen", port: 5901, timeout: 5 * time.Second,
		compositor: []string{os.Args[0], "-test.run=^TestGreeterFixture$", "--", "--config", "literal config with spaces", "$(literal)"}}
	return options, runtimeDirectory, helper
}

func readGreeterFixture(t *testing.T, role string) greeterFixtureRecord {
	t.Helper()
	var record greeterFixtureRecord
	greeterEventually(t, func() bool {
		data, err := os.ReadFile(filepath.Join(os.Getenv("CRABFLEET_GREETER_FIXTURE_DIR"), role+".json"))
		return err == nil && json.Unmarshal(data, &record) == nil
	})
	return record
}

func greeterEventually(t *testing.T, condition func() bool) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if condition() {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("timed out waiting for greeter fixture")
}

func assertGreeterStopped(t *testing.T, record greeterFixtureRecord) {
	t.Helper()
	for _, pid := range []int{record.PID, record.ChildPID} {
		greeterEventually(t, func() bool {
			data, err := os.ReadFile(filepath.Join("/proc", strconv.Itoa(pid), "stat"))
			return os.IsNotExist(err) || (err == nil && strings.Contains(string(data), ") Z "))
		})
	}
}

func TestGreeterCompositorExitCleansHelperAndDescendants(t *testing.T) {
	options, directory, executable := greeterFixture(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	result := make(chan error, 1)
	go func() {
		result <- superviseGreeter(ctx, options, directory, nil, true, executable, io.Discard, io.Discard)
	}()
	compositor := readGreeterFixture(t, "compositor")
	helper := readGreeterFixture(t, "helper")
	if !reflect.DeepEqual(compositor.Arguments, options.compositor[3:]) || compositor.Socket != "wayland-user-must-not-be-shared" {
		t.Fatalf("original compositor invocation changed: %+v", compositor)
	}
	if helper.Socket != "wayland-greeter" || helper.Display != "" || !reflect.DeepEqual(helper.Arguments, greeterShareArguments(options)) {
		t.Fatalf("wrong sharing invocation: %+v", helper)
	}
	if err := os.WriteFile(filepath.Join(os.Getenv("CRABFLEET_GREETER_FIXTURE_DIR"), "compositor.exit"), nil, 0600); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-result:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("wrapper did not stop after compositor exit")
	}
	assertGreeterStopped(t, compositor)
	assertGreeterStopped(t, helper)
}

func TestGreeterSharingFailureKeepsLoginAvailable(t *testing.T) {
	for _, scenario := range []string{"helper failure", "socket timeout", "sharing disabled"} {
		t.Run(scenario, func(t *testing.T) {
			options, directory, executable := greeterFixture(t)
			options.timeout = 100 * time.Millisecond
			if scenario == "socket timeout" {
				t.Setenv("CRABFLEET_GREETER_FIXTURE_NO_SOCKET", "1")
			}
			if scenario == "helper failure" {
				options.timeout = 5 * time.Second
				t.Setenv("CRABFLEET_GREETER_FIXTURE_FAIL_HELPER", "1")
			}
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			logs := &helperLog{}
			result := make(chan error, 1)
			go func() {
				result <- superviseGreeter(ctx, options, directory, nil, scenario != "sharing disabled", executable, io.Discard, logs)
			}()
			compositor := readGreeterFixture(t, "compositor")
			var helper greeterFixtureRecord
			if scenario == "helper failure" {
				helper = readGreeterFixture(t, "helper")
				assertGreeterStopped(t, helper)
			} else if scenario == "socket timeout" {
				greeterEventually(t, func() bool {
					logs.mutex.Lock()
					defer logs.mutex.Unlock()
					return strings.Contains(string(logs.data), "timed out")
				})
			}
			select {
			case err := <-result:
				t.Fatalf("sharing failure stopped compositor: %v", err)
			default:
			}
			if err := syscall.Kill(compositor.PID, 0); err != nil {
				t.Fatalf("compositor no longer running: %v", err)
			}
			cancel()
			select {
			case err := <-result:
				if err != nil {
					t.Fatal(err)
				}
			case <-time.After(10 * time.Second):
				t.Fatal("wrapper ignored cancellation")
			}
			assertGreeterStopped(t, compositor)
		})
	}
}

func TestGreeterCompositorFailureAndCancelledStart(t *testing.T) {
	options := greeterOptions{compositor: []string{"/bin/sh", "-c", "exit 42"}, timeout: time.Second}
	err := superviseGreeter(context.Background(), options, "", nil, false, "", io.Discard, io.Discard)
	var exit *exec.ExitError
	if !errors.As(err, &exit) || exit.ExitCode() != 42 {
		t.Fatalf("lost original compositor failure: %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := superviseGreeter(ctx, options, "", nil, false, "", io.Discard, io.Discard); err != nil {
		t.Fatal(err)
	}
}
