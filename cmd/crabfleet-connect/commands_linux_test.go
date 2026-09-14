//go:build linux

package main

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/openclaw/crabfleet/internal/connector"
)

func TestStatusRedactsCredentialsAndExpiredLogoutAllowsSignIn(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "config")
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(401) }))
	defer api.Close()
	store, err := connector.OpenStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	state, _ := store.Load()
	state.Server, state.AccessToken, state.OwnershipToken, state.PublicationID, state.DirectPassword = api.URL, "fixture-access-secret", "fixture-owner-secret", "fixture-pub", "fixture1"
	if err := store.Save(state); err != nil {
		t.Fatal(err)
	}
	_ = store.Close()
	var out, stderr bytes.Buffer
	if err := run(context.Background(), []string{"status", "--config-dir", dir}, &out, &stderr); err != nil {
		t.Fatal(err)
	}
	for _, secret := range []string{state.AccessToken, state.OwnershipToken, state.DirectPassword} {
		if strings.Contains(out.String(), secret) {
			t.Fatal("status exposed credentials")
		}
	}
	out.Reset()
	if err := run(context.Background(), []string{"logout", "--config-dir", dir}, &out, &stderr); err != nil {
		t.Fatal(err)
	}
	loaded, err := connector.ReadState(dir)
	if err != nil || loaded.AccessToken != "" || loaded.PublicationID != "" {
		t.Fatal("expired sign-in could not be cleared")
	}
}

func TestServiceEscapingAndManagedFiles(t *testing.T) {
	unit, entry, err := serviceFiles("/home/test user/bin/crabfleet-connect", []string{"--fleet", "--name", "$HOME %n \"quoted\""})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(unit, `"$$HOME %%n \"quoted\""`) || !strings.Contains(unit, "KillMode=control-group") || !strings.Contains(unit, "--quiet") {
		t.Fatalf("invalid service: %s", unit)
	}
	if !strings.Contains(entry, `Exec="/home/test user/bin/crabfleet-connect" service start`) {
		t.Fatal("invalid desktop entry")
	}
	if _, _, err := serviceFiles("/tmp/program", []string{"x\nExecStart=other"}); err == nil {
		t.Fatal("accepted unit injection")
	}
	for _, args := range [][]string{{"--port", "0"}, {"--video", "invalid"}, {"--shared-folder-write"}, {"--version"}, {"--help"}, {"--unknown"}} {
		if _, _, err := serviceFiles("/home/test/bin/crabfleet-connect", args); err == nil {
			t.Fatalf("installed invalid service options %v", args)
		}
	}
	unit, _, err = serviceFiles("/home/test/bin/crabfleet-connect", []string{"--quiet=false"})
	if err != nil || !strings.Contains(unit, "\"--quiet=false\" \"--quiet\"\n") {
		t.Fatal("service can print the direct password to the journal")
	}
	file := filepath.Join(t.TempDir(), "existing.service")
	if err := os.WriteFile(file, []byte("unrelated"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := checkManagedFile(file); err == nil {
		t.Fatal("accepted unrelated service file")
	}
}

func TestDesktopEnvironmentSelectsPortal(t *testing.T) {
	for _, desktop := range []string{"GNOME", "ubuntu:GNOME", "KDE"} {
		t.Setenv("XDG_CURRENT_DESKTOP", desktop)
		if got := platformBackendSelection("wayland"); got != "portal" {
			t.Fatalf("%s selected %s", desktop, got)
		}
		if got := platformBackendSelection("x11"); got != "x11" {
			t.Fatal("overrode X11")
		}
	}
	t.Setenv("XDG_CURRENT_DESKTOP", "sway")
	if got := platformBackendSelection("wayland"); got != "wayland" {
		t.Fatal("overrode wlroots")
	}
}
