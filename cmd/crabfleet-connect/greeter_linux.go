//go:build linux

package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"math"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/openclaw/crabfleet/internal/connector"
)

type greeterOptions struct {
	directory, username, name, output string
	fleet, check                      bool
	port                              int
	timeout                           time.Duration
	compositor                        []string
}

func parseGreeterOptions(args []string, stderr io.Writer) (greeterOptions, error) {
	var options greeterOptions
	flags := flag.NewFlagSet("greeter", flag.ContinueOnError)
	flags.SetOutput(stderr)
	flags.Usage = func() {
		fmt.Fprintln(stderr, "Usage: crabfleet-connect greeter [options] -- /absolute/compositor [original arguments]")
		flags.PrintDefaults()
	}
	flags.StringVar(&options.directory, "config-dir", "", "required separate private greeter configuration directory")
	flags.StringVar(&options.username, "user", "sddm", "non-root account that runs the display manager greeter")
	flags.StringVar(&options.name, "name", "Linux login screen", "greeter name shown to viewers")
	flags.StringVar(&options.output, "output", "", "Wayland output to share (defaults to first output)")
	flags.BoolVar(&options.fleet, "fleet", false, "publish using the greeter's separately approved Fleet account state")
	flags.BoolVar(&options.check, "check", false, "validate account, configuration, and executables without starting anything")
	flags.IntVar(&options.port, "port", 5901, "authenticated loopback VNC port")
	flags.DurationVar(&options.timeout, "socket-timeout", 15*time.Second, "maximum wait for the greeter's new Wayland socket")
	if err := flags.Parse(args); err != nil {
		return options, err
	}
	options.compositor = flags.Args()
	if len(options.compositor) == 0 || !filepath.IsAbs(options.compositor[0]) {
		return options, errors.New("greeter requires an absolute compositor executable after --")
	}
	return options, nil
}

func runGreeter(ctx context.Context, args []string, stdout, stderr io.Writer) error {
	options, err := parseGreeterOptions(args, stderr)
	if errors.Is(err, flag.ErrHelp) {
		return nil
	}
	if err != nil {
		return err
	}
	validation := validateGreeter(options)
	if options.check {
		if validation != nil {
			return validation
		}
		fmt.Fprintln(stdout, "Greeter account, private configuration, and executables validated. Runtime socket and compositor compatibility are checked at startup.")
		return nil
	}
	runtimeDirectory := os.Getenv("XDG_RUNTIME_DIR")
	var existing map[string]os.FileInfo
	if validation == nil {
		existing, validation = greeterSockets(runtimeDirectory, os.Geteuid())
	}
	if validation != nil {
		fmt.Fprintf(stderr, "Greeter sharing disabled: %v. Starting the original compositor.\n", validation)
	}
	executable, err := os.Executable()
	if err != nil {
		return err
	}
	return superviseGreeter(ctx, options, runtimeDirectory, existing, validation == nil, executable, stdout, stderr)
}

func validateGreeter(options greeterOptions) error {
	if options.port < 1 || options.port > 65535 {
		return errors.New("greeter port must be between 1 and 65535")
	}
	if options.timeout < time.Millisecond || options.timeout > 2*time.Minute {
		return errors.New("socket-timeout must be between 1ms and 2m")
	}
	account, err := user.Lookup(options.username)
	if err != nil {
		return errors.New("configured greeter account does not exist")
	}
	accountUID, err := strconv.ParseUint(account.Uid, 10, 32)
	uid := os.Geteuid()
	if err != nil || accountUID == 0 || accountUID != uint64(uid) || os.Getuid() != uid {
		return errors.New("run as the configured non-root greeter account, without setuid")
	}
	if err := greeterPrivateDirectory(options.directory, uid); err != nil {
		return fmt.Errorf("greeter config-dir: %w", err)
	}
	statePath := filepath.Join(options.directory, "state.json")
	info, err := os.Lstat(statePath)
	if err != nil && !os.IsNotExist(err) {
		return errors.New("cannot inspect greeter state")
	}
	if err == nil {
		if !info.Mode().IsRegular() || info.Mode().Perm()&0077 != 0 || !greeterOwned(info, uid) {
			return errors.New("greeter state must be a private regular file owned by the greeter")
		}
		state, err := connector.ReadState(options.directory)
		if err != nil {
			return errors.New("greeter state is invalid")
		}
		if options.fleet && (state.Server == "" || state.AccessToken == "") {
			return errors.New("approve a separate Fleet login in the greeter config-dir first")
		}
	} else if options.fleet {
		return errors.New("approve a separate Fleet login in the greeter config-dir first")
	}
	if _, err := exec.LookPath(options.compositor[0]); err != nil {
		return errors.New("configured compositor executable is unavailable")
	}
	if _, err := exec.LookPath("wayvnc"); err != nil {
		return errors.New("greeter sharing requires wayvnc 0.10 or newer")
	}
	return nil
}

func greeterOwned(info os.FileInfo, uid int) bool {
	if uid < 0 || uint64(uid) > math.MaxUint32 {
		return false
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	return ok && stat.Uid == uint32(uid)
}

func greeterPrivateDirectory(directory string, uid int) error {
	if !filepath.IsAbs(directory) {
		return errors.New("directory must be absolute")
	}
	info, err := os.Lstat(directory)
	if err != nil || !info.IsDir() || info.Mode().Perm()&0077 != 0 || !greeterOwned(info, uid) {
		return errors.New("directory must exist, be owned by the greeter, and have mode 0700")
	}
	return nil
}

func greeterSockets(directory string, uid int) (map[string]os.FileInfo, error) {
	if err := greeterPrivateDirectory(directory, uid); err != nil {
		return nil, fmt.Errorf("XDG_RUNTIME_DIR: %w", err)
	}
	entries, err := os.ReadDir(directory)
	if err != nil {
		return nil, errors.New("cannot inspect greeter runtime directory")
	}
	sockets := make(map[string]os.FileInfo)
	for _, entry := range entries {
		if !strings.HasPrefix(entry.Name(), "wayland-") {
			continue
		}
		info, err := entry.Info()
		if err == nil && info.Mode()&os.ModeSocket != 0 && greeterOwned(info, uid) {
			sockets[entry.Name()] = info
		}
	}
	return sockets, nil
}

func newGreeterSocket(directory string, existing map[string]os.FileInfo, uid int) (string, error) {
	sockets, err := greeterSockets(directory, uid)
	if err != nil {
		return "", err
	}
	var selected string
	for name, info := range sockets {
		if previous, ok := existing[name]; ok && os.SameFile(previous, info) {
			continue
		}
		if selected != "" {
			return "", errors.New("multiple new Wayland sockets; refusing ambiguous greeter capture")
		}
		selected = name
	}
	return selected, nil
}

func greeterShareArguments(options greeterOptions) []string {
	args := []string{"share", "--backend", "wayland", "--config-dir", options.directory,
		"--bind", "127.0.0.1", "--port", strconv.Itoa(options.port), "--quiet", "--clipboard=false", "--video", "jpeg", "--name", options.name}
	if options.output != "" {
		args = append(args, "--output", options.output)
	}
	if options.fleet {
		args = append(args, "--fleet")
	}
	return args
}

func greeterShareEnvironment(socket string) []string {
	environment := []string{}
	for _, value := range os.Environ() {
		key, _, _ := strings.Cut(value, "=")
		switch key {
		case "WAYLAND_DISPLAY", "DISPLAY", "XAUTHORITY", "XDG_SESSION_TYPE":
			continue
		}
		environment = append(environment, value)
	}
	return append(environment, "WAYLAND_DISPLAY="+socket, "XDG_SESSION_TYPE=wayland")
}

type greeterProcess struct {
	command *exec.Cmd
	done    chan struct{}
	err     error
}

func startGreeterProcess(command *exec.Cmd) (*greeterProcess, error) {
	process := &greeterProcess{command: command, done: make(chan struct{})}
	started := make(chan error, 1)
	command.SysProcAttr = &syscall.SysProcAttr{Setpgid: true, Pdeathsig: syscall.SIGTERM}
	command.WaitDelay = time.Second
	go func() {
		// Linux parent-death signals belong to the creating thread, which must
		// remain alive until this child has been reaped.
		runtime.LockOSThread()
		defer runtime.UnlockOSThread()
		err := command.Start()
		started <- err
		if err == nil {
			process.err = command.Wait()
		}
		close(process.done)
	}()
	if err := <-started; err != nil {
		return nil, err
	}
	return process, nil
}

func (process *greeterProcess) stop() {
	_ = syscall.Kill(-process.command.Process.Pid, syscall.SIGTERM)
	select {
	case <-process.done:
	case <-time.After(5 * time.Second):
	}
	// Also remove descendants after a launcher or connector leader exits.
	_ = syscall.Kill(-process.command.Process.Pid, syscall.SIGKILL)
	<-process.done
}

func superviseGreeter(ctx context.Context, options greeterOptions, directory string, existing map[string]os.FileInfo, sharing bool, executable string, stdout, stderr io.Writer) error {
	if ctx.Err() != nil {
		return nil
	}
	command := exec.Command(options.compositor[0], options.compositor[1:]...)
	command.Stdin, command.Stdout, command.Stderr = os.Stdin, stdout, stderr
	compositor, err := startGreeterProcess(command)
	if err != nil {
		return fmt.Errorf("start greeter compositor: %w", err)
	}
	defer compositor.stop()
	var helper *greeterProcess
	defer func() {
		if helper != nil {
			helper.stop()
		}
	}()
	var helperDone <-chan struct{}
	ticker := time.NewTicker(50 * time.Millisecond)
	defer ticker.Stop()
	timeout := time.NewTimer(options.timeout)
	defer timeout.Stop()
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-compositor.done:
			return compositor.err
		case <-helperDone:
			helper.stop()
			helper, helperDone = nil, nil
			fmt.Fprintln(stderr, "Greeter sharing stopped; the OS login screen remains available.")
		case <-timeout.C:
			if sharing {
				sharing = false
				fmt.Fprintln(stderr, "Greeter sharing disabled: timed out waiting for a new Wayland socket. The OS login screen remains available.")
			}
		case <-ticker.C:
			if !sharing {
				continue
			}
			socket, err := newGreeterSocket(directory, existing, os.Geteuid())
			if err != nil {
				sharing = false
				fmt.Fprintf(stderr, "Greeter sharing disabled: %v. The OS login screen remains available.\n", err)
				continue
			}
			if socket == "" {
				continue
			}
			sharing = false
			command := exec.Command(executable, greeterShareArguments(options)...)
			command.Env = greeterShareEnvironment(socket)
			// Greeter credentials and helper diagnostics never enter SDDM logs.
			command.Stdout, command.Stderr = io.Discard, io.Discard
			helper, err = startGreeterProcess(command)
			if err != nil {
				fmt.Fprintln(stderr, "Greeter sharing could not start; the OS login screen remains available.")
				continue
			}
			helperDone = helper.done
			fmt.Fprintln(stderr, "Greeter sharing connector started with authenticated loopback VNC; Fleet publication requires its own authorization.")
		}
	}
}
