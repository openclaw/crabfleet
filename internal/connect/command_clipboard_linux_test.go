//go:build linux

package connect

import (
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// This helper owns only a temporary text file, never the desktop clipboard.
func TestCommandClipboardFixtureProcess(t *testing.T) {
	path := os.Getenv("CRABFLEET_CLIPBOARD_FIXTURE")
	if path == "" {
		return
	}
	for _, arg := range os.Args {
		if arg == "-out" {
			data, err := os.ReadFile(path)
			if err != nil {
				os.Exit(1)
			}
			_, _ = os.Stdout.Write(data)
			os.Exit(0)
		}
	}
	data, err := io.ReadAll(os.Stdin)
	if err != nil || os.WriteFile(path, data, 0600) != nil {
		os.Exit(1)
	}
	time.Sleep(30 * time.Second)
	os.Exit(1)
}

func fixtureClipboard(t *testing.T, parent context.Context) *CommandClipboard {
	t.Helper()
	directory := t.TempDir()
	binary, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	script := "#!/bin/sh\nexec \"$CRABFLEET_CLIPBOARD_BINARY\" -test.run='^TestCommandClipboardFixtureProcess$' -- \"$@\"\n"
	if err := os.WriteFile(filepath.Join(directory, "xclip"), []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", directory)
	t.Setenv("CRABFLEET_CLIPBOARD_BINARY", binary)
	t.Setenv("CRABFLEET_CLIPBOARD_FIXTURE", filepath.Join(directory, "text"))
	// Read helpers must exit inside the production one-second command deadline.
	t.Setenv("GORACE", os.Getenv("GORACE")+" atexit_sleep_ms=0")
	clipboard, err := NewCommandClipboard(parent, false)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = clipboard.Close() })
	return clipboard
}

func TestCommandClipboardOwnershipLifecycle(t *testing.T) {
	clipboard := fixtureClipboard(t, context.Background())
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := clipboard.WriteClipboard(ctx, "first"); err != nil {
		t.Fatal(err)
	}
	firstOwner := clipboard.done
	canceled, stop := context.WithCancel(ctx)
	stop()
	if err := clipboard.WriteClipboard(canceled, "discarded"); !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled write: %v", err)
	}
	if clipboard.done != firstOwner || clipboard.stop == nil {
		t.Fatal("canceled write terminated the existing clipboard owner")
	}
	if text, err := clipboard.ReadClipboard(ctx); err != nil || text != "first" {
		t.Fatalf("canceled write replaced clipboard: %q, %v", text, err)
	}
	if err := clipboard.WriteClipboard(ctx, "second"); err != nil {
		t.Fatal(err)
	}
	if clipboard.done == firstOwner {
		t.Fatal("replacement retained the old clipboard owner")
	}
	for range 2 {
		if err := clipboard.Close(); err != nil {
			t.Fatal(err)
		}
	}
	if clipboard.stop != nil || clipboard.done != nil {
		t.Fatal("closed clipboard retained helper state")
	}
	if err := clipboard.WriteClipboard(ctx, "after close"); !errors.Is(err, ErrClosed) {
		t.Fatalf("write after close: %v", err)
	}
	if _, err := clipboard.ReadClipboard(ctx); !errors.Is(err, ErrClosed) {
		t.Fatalf("read after close: %v", err)
	}
}

func TestCommandClipboardParentCancellation(t *testing.T) {
	parent, cancel := context.WithCancel(context.Background())
	defer cancel()
	clipboard := fixtureClipboard(t, parent)
	if err := clipboard.WriteClipboard(context.Background(), "owned"); err != nil {
		t.Fatal(err)
	}
	cancel()
	if err := clipboard.WriteClipboard(context.Background(), "after cancellation"); !errors.Is(err, ErrClosed) {
		t.Fatalf("write after parent cancellation: %v", err)
	}
	if _, err := clipboard.ReadClipboard(context.Background()); !errors.Is(err, ErrClosed) {
		t.Fatalf("read after parent cancellation: %v", err)
	}
	if err := clipboard.Close(); err != nil {
		t.Fatal(err)
	}
}
