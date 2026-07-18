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

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := run(ctx, os.Args[1:], os.Stdout, os.Stderr); err != nil {
		fmt.Fprintln(os.Stderr, "crabfleet-connect:", err)
		os.Exit(1)
	}
}

func run(ctx context.Context, arguments []string, stdout, stderr io.Writer) error {
	flags := flag.NewFlagSet("crabfleet-connect", flag.ContinueOnError)
	flags.SetOutput(stderr)
	display := flags.String("display", "", "X11 display to capture (defaults to DISPLAY)")
	bind := flags.String("bind", "127.0.0.1", "listener address; use a private interface explicitly for remote access")
	port := flags.Int("port", 5900, "TCP port for the direct RFB listener")
	synthetic := flags.Bool("synthetic", false, "force the synthetic test-pattern backend")
	showVersion := flags.Bool("version", false, "print version and exit")
	if err := flags.Parse(arguments); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return nil
		}
		return err
	}
	if flags.NArg() != 0 {
		return fmt.Errorf("unexpected arguments: %v", flags.Args())
	}
	if *showVersion {
		fmt.Fprintf(stdout, "crabfleet-connect %s\n", version)
		return nil
	}
	if *port < 1 || *port > 65_535 {
		return errors.New("port must be between 1 and 65535")
	}
	if strings.TrimSpace(*bind) == "" {
		return errors.New("bind address must not be empty")
	}

	backend, description, err := selectBackend(*synthetic, *display, stderr)
	if err != nil {
		return err
	}
	password, err := generateSharePassword()
	if err != nil {
		_ = backend.Close()
		return err
	}
	hostname, err := os.Hostname()
	if err != nil || hostname == "" {
		hostname = runtime.GOOS
	}
	server, err := rfb.NewServer(rfb.ServerConfig{Session: rfb.SessionConfig{
		Backend:     backend,
		Password:    password,
		DesktopName: "Crabfleet Connect (" + hostname + ")",
	}})
	if err != nil {
		_ = backend.Close()
		return err
	}
	listener, err := net.Listen("tcp", net.JoinHostPort(*bind, strconv.Itoa(*port)))
	if err != nil {
		_ = server.Close()
		return fmt.Errorf("listen on port %d: %w", *port, err)
	}
	fmt.Fprintf(stdout, "Crabfleet Connect %s\n", version)
	fmt.Fprintf(stdout, "Backend: %s\n", description)
	fmt.Fprintf(stdout, "Listening: %s\n", listener.Addr())
	fmt.Fprintf(stdout, "Share password: %s\n", password)
	return server.Serve(ctx, listener)
}

func selectBackend(forceSynthetic bool, display string, stderr io.Writer) (connect.Backend, string, error) {
	if !forceSynthetic {
		backend, err := connect.NewPlatformBackend(display)
		if err == nil {
			return backend, nativeBackendDescription(), nil
		}
		fmt.Fprintf(stderr, "Native capture unavailable (%v); using synthetic test pattern.\n", err)
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
