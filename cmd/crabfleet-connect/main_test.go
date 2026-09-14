package main

import (
	"bytes"
	"context"
	"strings"
	"testing"
)

func TestVersion(t *testing.T) {
	t.Parallel()
	var stdout, stderr bytes.Buffer
	if err := run(context.Background(), []string{"--version"}, &stdout, &stderr); err != nil {
		t.Fatal(err)
	}
	if stdout.String() != "crabfleet-connect dev\n" || stderr.Len() != 0 {
		t.Fatalf("stdout=%q stderr=%q", stdout.String(), stderr.String())
	}
}

func TestHelpIsSuccessful(t *testing.T) {
	t.Parallel()
	var stdout, stderr bytes.Buffer
	if err := run(context.Background(), []string{"--help"}, &stdout, &stderr); err != nil {
		t.Fatal(err)
	}
	if stdout.Len() != 0 || !strings.Contains(stderr.String(), "Usage: crabfleet-connect [share]") {
		t.Fatalf("stdout=%q stderr=%q", stdout.String(), stderr.String())
	}
}

func TestGenerateSharePassword(t *testing.T) {
	t.Parallel()
	first, err := generateSharePassword()
	if err != nil {
		t.Fatal(err)
	}
	second, err := generateSharePassword()
	if err != nil {
		t.Fatal(err)
	}
	const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789"
	if len(first) != 8 || strings.Trim(first, alphabet) != "" || first == second {
		t.Fatalf("generated passwords %q and %q", first, second)
	}
}

func TestRejectsInvalidPort(t *testing.T) {
	t.Parallel()
	var stdout, stderr bytes.Buffer
	if err := run(context.Background(), []string{"--port", "0"}, &stdout, &stderr); err == nil {
		t.Fatal("accepted invalid port")
	}
}

func TestRejectsEmptyBindAddress(t *testing.T) {
	t.Parallel()
	var stdout, stderr bytes.Buffer
	if err := run(context.Background(), []string{"--bind="}, &stdout, &stderr); err == nil {
		t.Fatal("accepted empty bind address")
	}
}

func TestBackendSelection(t *testing.T) {
	t.Parallel()
	for _, test := range []struct {
		name, requested, display, output, goos, wayland, session, want string
		synthetic, invalid                                             bool
	}{
		{name: "Wayland beats XWayland", requested: "auto", goos: "linux", wayland: "wayland-1", want: "wayland"},
		{name: "Wayland without socket fails in Wayland startup", requested: "auto", goos: "linux", session: "wayland", want: "wayland"},
		{name: "X11 session", requested: "auto", goos: "linux", session: "x11", want: "x11"},
		{name: "explicit X11 display", requested: "auto", goos: "linux", display: ":2", wayland: "wayland-1", want: "x11"},
		{name: "explicit X11 backend", requested: "x11", goos: "linux", wayland: "wayland-1", want: "x11"},
		{name: "Wayland output", requested: "wayland", goos: "linux", output: "DP-1", want: "wayland"},
		{name: "Windows", requested: "auto", goos: "windows", want: "native"},
		{name: "test pattern", requested: "auto", goos: "linux", synthetic: true, want: "synthetic"},
		{name: "portal", requested: "portal", goos: "linux", want: "portal"},
		{name: "unknown", requested: "unknown", goos: "linux", invalid: true},
		{name: "conflicting display", requested: "wayland", goos: "linux", display: ":0", invalid: true},
		{name: "X11 output", requested: "x11", goos: "linux", output: "DP-1", invalid: true},
		{name: "synthetic output", requested: "auto", goos: "linux", output: "DP-1", synthetic: true, invalid: true},
		{name: "synthetic backend", requested: "x11", goos: "linux", synthetic: true, invalid: true},
		{name: "Linux options on Windows", requested: "wayland", goos: "windows", invalid: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			got, err := resolveBackend(test.requested, test.display, test.output, test.synthetic, test.goos, test.wayland, test.session)
			if (err != nil) != test.invalid || got != test.want {
				t.Fatalf("backend=%q, error=%v; want %q, invalid=%v", got, err, test.want, test.invalid)
			}
		})
	}
}
