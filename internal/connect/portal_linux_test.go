//go:build linux

package connect

import (
	"context"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/godbus/dbus/v5"
)

func TestPortalDBusContract(t *testing.T) {
	if _, err := exec.LookPath("dbus-run-session"); err != nil {
		t.Skip("dbus-run-session is unavailable")
	}
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "dbus-run-session", "--", executable, "-test.run=^TestPortalDBusChild$", "-test.v")
	cmd.Env = append(os.Environ(), "CRABFLEET_PORTAL_CONTRACT=1")
	output, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("portal contract failed: %v\n%s", err, output)
	}
}
func TestPortalCaptureHelper(t *testing.T) {
	if os.Getenv("CRABFLEET_PORTAL_HELPER") != "1" {
		return
	}
	pixels := make([]byte, 32*24*4)
	for i := 0; i < len(pixels); i += 4 {
		pixels[i], pixels[i+1], pixels[i+2], pixels[i+3] = 7, 9, 11, 255
	}
	for {
		if _, err := os.Stdout.Write(pixels); err != nil {
			os.Exit(0)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

type fixturePortal struct {
	bus             *dbus.Conn
	session         dbus.ObjectPath
	fd              *os.File
	requested       uint32
	clipboard       bool
	keys            chan int32
	buttons         chan int32
	closed          chan struct{}
	deny            atomic.Bool
	readFD, writeFD *os.File
	selectionDone   chan bool
}

func (f *fixturePortal) respond(options map[string]dbus.Variant, results map[string]dbus.Variant) (dbus.ObjectPath, *dbus.Error) {
	token, _ := options["handle_token"].Value().(string)
	path := dbus.ObjectPath("/org/freedesktop/portal/desktop/request/fixture/" + token)
	code := uint32(0)
	if f.deny.Load() {
		code = 1
	}
	go func() { _ = f.bus.Emit(path, "org.freedesktop.portal.Request.Response", code, results) }()
	return path, nil
}
func (f *fixturePortal) CreateSession(options map[string]dbus.Variant) (dbus.ObjectPath, *dbus.Error) {
	return f.respond(options, map[string]dbus.Variant{"session_handle": dbus.MakeVariant(string(f.session))})
}
func (f *fixturePortal) SelectDevices(_ dbus.ObjectPath, options map[string]dbus.Variant) (dbus.ObjectPath, *dbus.Error) {
	f.requested, _ = options["types"].Value().(uint32)
	return f.respond(options, nil)
}
func (f *fixturePortal) SelectSources(_ dbus.ObjectPath, options map[string]dbus.Variant) (dbus.ObjectPath, *dbus.Error) {
	if _, ok := options["persist_mode"]; ok {
		return "", dbus.NewError("org.example.BadPersistence", nil)
	}
	return f.respond(options, nil)
}
func (f *fixturePortal) Start(_ dbus.ObjectPath, _ string, options map[string]dbus.Variant) (dbus.ObjectPath, *dbus.Error) {
	return f.respond(options, map[string]dbus.Variant{"devices": dbus.MakeVariant(f.requested), "clipboard_enabled": dbus.MakeVariant(f.clipboard), "restore_token": dbus.MakeVariant("fixture-restore"), "streams": dbus.MakeVariant([]portalStream{{Node: 42, Properties: map[string]dbus.Variant{"size": dbus.MakeVariant(struct{ Width, Height int32 }{32, 24}), "pipewire-serial": dbus.MakeVariant(uint64(1234))}}})})
}
func (f *fixturePortal) OpenPipeWireRemote(dbus.ObjectPath, map[string]dbus.Variant) (dbus.UnixFD, *dbus.Error) {
	return dbus.UnixFD(f.fd.Fd()), nil
}
func (f *fixturePortal) RequestClipboard(dbus.ObjectPath, map[string]dbus.Variant) *dbus.Error {
	f.clipboard = true
	return nil
}

func (f *fixturePortal) SelectionRead(dbus.ObjectPath, string) (dbus.UnixFD, *dbus.Error) {
	return dbus.UnixFD(f.readFD.Fd()), nil
}
func (f *fixturePortal) SetSelection(dbus.ObjectPath, map[string]dbus.Variant) *dbus.Error {
	return nil
}
func (f *fixturePortal) SelectionWrite(dbus.ObjectPath, uint32) (dbus.UnixFD, *dbus.Error) {
	return dbus.UnixFD(f.writeFD.Fd()), nil
}
func (f *fixturePortal) SelectionWriteDone(_ dbus.ObjectPath, _ uint32, success bool) *dbus.Error {
	f.selectionDone <- success
	return nil
}
func (f *fixturePortal) NotifyKeyboardKeysym(_ dbus.ObjectPath, _ map[string]dbus.Variant, key int32, _ uint32) *dbus.Error {
	f.keys <- key
	return nil
}
func (f *fixturePortal) NotifyPointerMotionAbsolute(_ dbus.ObjectPath, _ map[string]dbus.Variant, node uint32, x, y float64) *dbus.Error {
	if node != 42 || x != 10 || y != 12 {
		return dbus.NewError("org.example.WrongCoordinates", nil)
	}
	return nil
}
func (f *fixturePortal) NotifyPointerButton(_ dbus.ObjectPath, _ map[string]dbus.Variant, button int32, _ uint32) *dbus.Error {
	f.buttons <- button
	return nil
}
func (f *fixturePortal) Close() *dbus.Error {
	select {
	case <-f.closed:
	default:
		close(f.closed)
	}
	return nil
}

func TestPortalDBusChild(t *testing.T) {
	if os.Getenv("CRABFLEET_PORTAL_CONTRACT") != "1" {
		t.Skip("run in a private D-Bus session")
	}
	bus, err := dbus.ConnectSessionBus()
	if err != nil {
		t.Fatal(err)
	}
	defer bus.Close()
	fd, err := os.CreateTemp(t.TempDir(), "pipewire")
	if err != nil {
		t.Fatal(err)
	}
	defer fd.Close()
	readFD, feed, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer readFD.Close()
	_, _ = feed.WriteString("local 🦞 clipboard")
	_ = feed.Close()
	receive, writeFD, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer receive.Close()
	defer writeFD.Close()
	f := &fixturePortal{bus: bus, session: "/org/freedesktop/portal/desktop/session/fixture/session", fd: fd, keys: make(chan int32, 4), buttons: make(chan int32, 4), closed: make(chan struct{}), readFD: readFD, writeFD: writeFD, selectionDone: make(chan bool, 1)}
	for _, iface := range []string{remoteDesktop, screenCast, portalClipboard} {
		if err := bus.Export(f, portalPath, iface); err != nil {
			t.Fatal(err)
		}
	}
	if err := bus.Export(f, f.session, "org.freedesktop.portal.Session"); err != nil {
		t.Fatal(err)
	}
	if reply, err := bus.RequestName(portalName, dbus.NameFlagDoNotQueue); err != nil || reply != dbus.RequestNameReplyPrimaryOwner {
		t.Fatal("could not own fixture portal")
	}
	executable, _ := os.Executable()
	bin := t.TempDir()
	script := fmt.Sprintf("#!/bin/sh\nexport CRABFLEET_PORTAL_HELPER=1\nexec '%s' -test.run=^TestPortalCaptureHelper$\n", strings.ReplaceAll(executable, "'", "'\\''"))
	if err := os.WriteFile(filepath.Join(bin, "gst-launch-1.0"), []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", bin+":"+os.Getenv("PATH"))
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	var restore string
	backend, err := NewPortal(ctx, PortalOptions{Clipboard: true, SaveRestoreToken: func(value string) error { restore = value; return nil }})
	if err != nil {
		t.Fatal(err)
	}
	defer backend.Close()
	frame, err := backend.Capture(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if frame.Width != 32 || frame.Height != 24 || frame.Pixels[0] != 7 || frame.Pixels[1] != 9 || frame.Pixels[2] != 11 || restore != "fixture-restore" {
		t.Fatal("portal frame or restore token was lost")
	}
	if err := backend.Key(ctx, KeyEvent{Keysym: 'a', Down: true}); err != nil {
		t.Fatal(err)
	}
	if key := <-f.keys; key != 'a' {
		t.Fatal("keysym changed")
	}
	if err := backend.Pointer(ctx, PointerEvent{X: 10, Y: 12, ButtonMask: 1}); err != nil {
		t.Fatal(err)
	}
	if button := <-f.buttons; button != 272 {
		t.Fatal("incorrect evdev button")
	}
	if err := bus.Emit(portalPath, portalClipboard+".SelectionOwnerChanged", f.session, map[string]dbus.Variant{"mime_types": dbus.MakeVariant([]string{"text/plain;charset=utf-8"}), "session_is_owner": dbus.MakeVariant(false)}); err != nil {
		t.Fatal(err)
	}
	for {
		text, err := backend.ReadClipboard(ctx)
		if err != nil {
			t.Fatal(err)
		}
		if text == "local 🦞 clipboard" {
			break
		}
		select {
		case <-ctx.Done():
			t.Fatal("clipboard owner signal was lost")
		case <-time.After(5 * time.Millisecond):
		}
	}
	const remoteText = "remote 🦞 clipboard"
	if err := backend.WriteClipboard(ctx, remoteText); err != nil {
		t.Fatal(err)
	}
	if err := bus.Emit(portalPath, portalClipboard+".SelectionTransfer", f.session, "text/plain;charset=utf-8", uint32(7)); err != nil {
		t.Fatal(err)
	}
	select {
	case success := <-f.selectionDone:
		if !success {
			t.Fatal("portal clipboard transfer failed")
		}
	case <-ctx.Done():
		t.Fatal("portal clipboard transfer stalled")
	}
	data := make([]byte, len(remoteText))
	if _, err := io.ReadFull(receive, data); err != nil || string(data) != remoteText {
		t.Fatal("portal clipboard FD did not receive UTF-8 text")
	}
	_ = f.Close()
	if err := bus.Emit(f.session, "org.freedesktop.portal.Session.Closed", map[string]dbus.Variant{}); err != nil {
		t.Fatal(err)
	}
	select {
	case <-backend.Done():
	case <-ctx.Done():
		t.Fatal("revocation did not stop capture")
	}
	if backend.Err() != nil {
		t.Fatal("permission revocation was treated as a capture failure")
	}
	if err := backend.Close(); err != nil {
		t.Fatal(err)
	}
	select {
	case <-f.closed:
	case <-ctx.Done():
		t.Fatal("portal session leaked")
	}
	if _, err := backend.Capture(ctx); err == nil {
		t.Fatal("captured after portal closed")
	}
	f.deny.Store(true)
	if denied, err := NewPortal(ctx, PortalOptions{}); err == nil {
		_ = denied.Close()
		t.Fatal("portal permission denial did not fail startup")
	}
}
