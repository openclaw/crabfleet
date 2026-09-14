package main

import (
	"context"
	"crypto/rand"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"os"
	"os/signal"
	"runtime"
	"strconv"
	"strings"
	"syscall"

	"github.com/openclaw/crabfleet/internal/connect"
	"github.com/openclaw/crabfleet/internal/rfb"
)

var version = "dev"

type shareOptions struct {
	output            string
	viewOnly          bool
	session           rfb.SessionConfig
	publish           func(context.Context, *rfb.Server) error
	portalRestore     string
	savePortalRestore func(string) error
	clipboardEnabled  bool
	password          string
	quiet             bool
}

type featureOptions struct {
	clipboard, audio, fleet                         bool
	video, folder, configDirectory, advertise, name string
	folderWrite                                     bool
	port                                            int
}

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := run(ctx, os.Args[1:], os.Stdout, os.Stderr); err != nil {
		fmt.Fprintln(os.Stderr, "crabfleet-connect:", err)
		os.Exit(1)
	}
}

func run(ctx context.Context, arguments []string, stdout, stderr io.Writer) error {
	if len(arguments) > 0 && arguments[0] == "share" {
		arguments = arguments[1:]
	} else if len(arguments) > 0 && !strings.HasPrefix(arguments[0], "-") {
		return runPlatformCommand(ctx, arguments, stdout, stderr)
	}
	return runShare(ctx, arguments, stdout, stderr, false)
}

func runShare(ctx context.Context, arguments []string, stdout, stderr io.Writer, validateOnly bool) error {
	flags := flag.NewFlagSet("crabfleet-connect", flag.ContinueOnError)
	flags.SetOutput(stderr)
	flags.Usage = func() {
		fmt.Fprintln(stderr, "Usage: crabfleet-connect [share] [options]")
		fmt.Fprintln(stderr, "Linux commands: login, logout, status, password, doctor, service")
		flags.PrintDefaults()
	}
	display := flags.String("display", "", "X11 display to capture (defaults to DISPLAY)")
	backendName := flags.String("backend", "auto", "capture backend: auto, x11, wayland (wlroots), or portal (GNOME/KDE)")
	clipboard := flags.Bool("clipboard", true, "share text clipboard (use --clipboard=false to disable)")
	audio := flags.Bool("audio", false, "share system output audio (requires ffmpeg and pactl)")
	video := flags.String("video", "auto", "video encoder: auto, jpeg, h264, or hevc (ffmpeg)")
	folder := flags.String("shared-folder", "", "folder available to authenticated viewers")
	folderWrite := flags.Bool("shared-folder-write", false, "allow new files and folders inside the shared folder")
	fleet := flags.Bool("fleet", false, "register with Fleet and publish an authenticated browser relay")
	configDirectory := flags.String("config-dir", "", "connector configuration directory (defaults to XDG_CONFIG_HOME/crabfleet-connect)")
	advertise := flags.String("advertise", "", "Tailscale IPv4 address for native viewers (otherwise Fleet is relay only)")
	name := flags.String("name", "", "desktop name shown in Fleet")
	output := flags.String("output", "", "Wayland output to share, for example DP-1 (defaults to first output)")
	viewOnly := flags.Bool("view-only", false, "disable remote keyboard and pointer input")
	bind := flags.String("bind", "127.0.0.1", "listener address; use a private interface explicitly for remote access")
	port := flags.Int("port", 5900, "TCP port for the direct RFB listener")
	synthetic := flags.Bool("synthetic", false, "force the synthetic test-pattern backend")
	showVersion := flags.Bool("version", false, "print version and exit")
	quiet := flags.Bool("quiet", false, "omit the direct password from logs; retrieve it with the password command")
	if err := flags.Parse(arguments); err != nil {
		if errors.Is(err, flag.ErrHelp) && !validateOnly {
			return nil
		}
		return err
	}
	if flags.NArg() != 0 {
		return fmt.Errorf("unexpected arguments: %v", flags.Args())
	}
	if *showVersion {
		if validateOnly {
			return errors.New("--version cannot be used in a sharing service")
		}
		fmt.Fprintf(stdout, "crabfleet-connect %s\n", version)
		return nil
	}
	if *port < 1 || *port > 65_535 {
		return errors.New("port must be between 1 and 65535")
	}
	if strings.TrimSpace(*bind) == "" {
		return errors.New("bind address must not be empty")
	}
	if *advertise != "" && *bind != *advertise && *bind != "0.0.0.0" {
		return errors.New("--advertise requires --bind set to that Tailscale address or 0.0.0.0")
	}
	if *advertise != "" && !*fleet {
		return errors.New("--advertise requires --fleet")
	}
	if *folderWrite && *folder == "" {
		return errors.New("--shared-folder-write requires --shared-folder")
	}
	if *video != "auto" && *video != "jpeg" && *video != "h264" && *video != "hevc" {
		return errors.New("video must be auto, jpeg, h264, or hevc")
	}
	selected, err := resolveBackend(*backendName, *display, *output, *synthetic, runtime.GOOS, os.Getenv("WAYLAND_DISPLAY"), os.Getenv("XDG_SESSION_TYPE"))
	if err != nil {
		return err
	}
	if *backendName == "auto" {
		selected = platformBackendSelection(selected)
	}
	if selected == "portal" && *output != "" {
		return errors.New("choose the monitor in the portal dialog; --output selects a wayvnc output")
	}
	if validateOnly {
		return nil
	}
	options := shareOptions{output: *output, viewOnly: *viewOnly, quiet: *quiet}
	features := featureOptions{clipboard: *clipboard, audio: *audio, video: *video, folder: *folder, folderWrite: *folderWrite, fleet: *fleet, configDirectory: *configDirectory, advertise: *advertise, name: *name, port: *port}
	cleanup, err := configureFeatures(ctx, selected, &options, features, stderr)
	if err != nil {
		return err
	}
	defer cleanup()
	password, err := generateSharePassword()
	if err != nil {
		return err
	}
	if options.password != "" {
		password = options.password
	}
	hostname, err := os.Hostname()
	if err != nil || hostname == "" {
		hostname = runtime.GOOS
	}
	desktopName := "Crabfleet Connect (" + hostname + ")"
	if *name != "" {
		desktopName = *name
	}
	listener, err := net.Listen("tcp", net.JoinHostPort(*bind, strconv.Itoa(*port)))
	if err != nil {
		return fmt.Errorf("listen on port %d: %w", *port, err)
	}
	defer listener.Close()
	if selected == "wayland" {
		return serveWayland(ctx, listener, options, password, desktopName, stdout)
	}
	if selected == "portal" {
		return servePortal(ctx, listener, options, password, desktopName, stdout)
	}
	backend, description, err := selectBackend(selected == "synthetic", *display)
	if err != nil {
		return err
	}
	return serveBackend(ctx, listener, options, password, desktopName, stdout, backend, description)
}

func serveBackend(ctx context.Context, listener net.Listener, options shareOptions, password, desktopName string, stdout io.Writer, backend connect.Backend, description string) error {
	config := options.session
	config.Backend, config.Password, config.DesktopName, config.ViewOnly = backend, password, desktopName, options.viewOnly
	server, err := rfb.NewServer(rfb.ServerConfig{Session: config})
	if err != nil {
		_ = backend.Close()
		return err
	}
	defer server.Close()
	if options.quiet {
		fmt.Fprintf(stdout, "Backend: %s\nListening: %s\n", description, listener.Addr())
	} else {
		printShare(stdout, description, listener.Addr(), password, options.viewOnly)
	}
	if options.publish != nil {
		ctx, cancel := context.WithCancel(ctx)
		defer cancel()
		published := make(chan error, 1)
		go func() { published <- options.publish(ctx, server); cancel() }()
		err := server.Serve(ctx, listener)
		cancel()
		publishErr := <-published
		if publishErr != nil {
			return publishErr
		}
		return err
	}
	return server.Serve(ctx, listener)
}

func printShare(stdout io.Writer, description string, address net.Addr, password string, viewOnly bool) {
	fmt.Fprintf(stdout, "Crabfleet Connect %s\n", version)
	fmt.Fprintf(stdout, "Backend: %s\n", description)
	fmt.Fprintf(stdout, "Listening: %s\n", address)
	if viewOnly {
		fmt.Fprintln(stdout, "Remote input: disabled (view only)")
	}
	fmt.Fprintf(stdout, "Share password: %s\n", password)
}

func resolveBackend(requested, display, output string, synthetic bool, goos, waylandDisplay, sessionType string) (string, error) {
	if requested != "auto" && requested != "x11" && requested != "wayland" && requested != "portal" {
		return "", errors.New("backend must be auto, x11, wayland, or portal")
	}
	if synthetic {
		if requested != "auto" || display != "" || output != "" {
			return "", errors.New("--synthetic cannot be combined with --backend, --display, or --output")
		}
		return "synthetic", nil
	}
	if goos != "linux" {
		if requested != "auto" || display != "" || output != "" {
			return "", errors.New("--backend, --display, and --output are Linux options")
		}
		return "native", nil
	}
	selected := requested
	if selected == "auto" {
		switch {
		case display != "":
			selected = "x11"
		case waylandDisplay != "" || strings.EqualFold(sessionType, "wayland"):
			selected = "wayland"
		default:
			selected = "x11"
		}
	}
	if (selected == "wayland" || selected == "portal") && display != "" {
		return "", errors.New("--display selects X11; use WAYLAND_DISPLAY to select a Wayland session")
	}
	if selected != "wayland" && output != "" {
		return "", errors.New("--output requires the Wayland backend")
	}
	return selected, nil
}

func selectBackend(forceSynthetic bool, display string) (connect.Backend, string, error) {
	if !forceSynthetic {
		backend, err := connect.NewPlatformBackend(display)
		if err == nil {
			return backend, nativeBackendDescription(), nil
		}
		return nil, "", fmt.Errorf("native capture unavailable: %w (run inside your desktop session; use --synthetic only for a test pattern)", err)
	}
	backend, err := connect.NewSynthetic(connect.SyntheticOptions{})
	if err != nil {
		return nil, "", fmt.Errorf("create synthetic backend: %w", err)
	}
	return backend, "synthetic test pattern", nil
}

func nativeBackendDescription() string {
	switch runtime.GOOS {
	case "linux":
		return "Linux X11 (MIT-SHM capture + XTest input)"
	case "windows":
		return "Windows GDI BitBlt capture + SendInput"
	default:
		return "native capture + input"
	}
}

func generateSharePassword() (string, error) {
	const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789"
	const length = 8
	result := make([]byte, 0, length)
	limit := byte(256 - (256 % len(alphabet)))
	buffer := make([]byte, 32)
	for len(result) < length {
		if _, err := io.ReadFull(rand.Reader, buffer); err != nil {
			return "", fmt.Errorf("generate share password: %w", err)
		}
		for _, value := range buffer {
			if value >= limit {
				continue
			}
			result = append(result, alphabet[int(value)%len(alphabet)])
			if len(result) == length {
				break
			}
		}
	}
	return string(result), nil
}
