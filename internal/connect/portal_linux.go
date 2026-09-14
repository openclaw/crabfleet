//go:build linux

package connect

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/godbus/dbus/v5"
	"golang.org/x/sys/unix"
)

const portalName = "org.freedesktop.portal.Desktop"
const portalPath = dbus.ObjectPath("/org/freedesktop/portal/desktop")
const remoteDesktop = "org.freedesktop.portal.RemoteDesktop"
const screenCast = "org.freedesktop.portal.ScreenCast"
const portalClipboard = "org.freedesktop.portal.Clipboard"

type PortalOptions struct {
	ViewOnly, Clipboard bool
	AllMonitors         bool
	RestoreToken        string
	SaveRestoreToken    func(string) error
}
type PortalBackend struct {
	bus                      *dbus.Conn
	object                   dbus.BusObject
	owner                    string
	session                  dbus.ObjectPath
	ctx                      context.Context
	cancel                   context.CancelFunc
	closeOnce                sync.Once
	mu, inputMu              sync.Mutex
	frame                    Frame
	devices                  uint32
	buttons                  byte
	clipboardEnabled         bool
	clipboard, selectionMIME string
	ownSelection             bool
	ready, done, signalsDone chan struct{}
	err                      error
}
type portalStream struct {
	Node       uint32
	Properties map[string]dbus.Variant
}

func NewPortal(ctx context.Context, options PortalOptions) (_ *PortalBackend, err error) {
	helper, err := exec.LookPath("gst-launch-1.0")
	if err != nil {
		return nil, errors.New("GNOME/KDE sharing requires GStreamer with the PipeWire plugin (gst-launch-1.0 and pipewiresrc)")
	}
	ctx, cancel := context.WithCancel(ctx)
	bus, err := dbus.ConnectSessionBus(dbus.WithContext(ctx), dbus.WithSignalHandler(&boundedPortalSignals{channels: make(map[chan<- *dbus.Signal]struct{}), overflow: cancel}))
	if err != nil {
		cancel()
		return nil, errors.New("connect to desktop session bus: run inside the graphical session")
	}
	p := &PortalBackend{bus: bus, object: bus.Object(portalName, portalPath), ctx: ctx, cancel: cancel, ready: make(chan struct{}), done: make(chan struct{}), signalsDone: make(chan struct{})}
	started := false
	defer func() {
		if err != nil {
			p.closeSession()
			cancel()
			_ = bus.Close()
			if started {
				<-p.done
				<-p.signalsDone
			}
		}
	}()
	setup, stopSetup := context.WithTimeout(ctx, 2*time.Minute)
	defer stopSetup()
	if err = p.object.CallWithContext(setup, "org.freedesktop.DBus.Peer.Ping", 0).Err; err != nil {
		return nil, errors.New("desktop portal is unavailable; install xdg-desktop-portal and the GNOME or KDE backend")
	}
	if err = bus.BusObject().CallWithContext(setup, "org.freedesktop.DBus.GetNameOwner", 0, portalName).Store(&p.owner); err != nil {
		return nil, err
	}
	token, err := portalToken()
	if err != nil {
		return nil, err
	}
	results, err := p.request(setup, remoteDesktop+".CreateSession", nil, map[string]dbus.Variant{"session_handle_token": dbus.MakeVariant(token)})
	if err != nil {
		return nil, err
	}
	handle, ok := results["session_handle"].Value().(string)
	if !ok || !dbus.ObjectPath(handle).IsValid() || !strings.HasPrefix(handle, "/org/freedesktop/portal/desktop/session/") {
		return nil, errors.New("portal returned an invalid session")
	}
	p.session = dbus.ObjectPath(handle)
	devices := uint32(3)
	if options.ViewOnly {
		devices = 0
	}
	selection := map[string]dbus.Variant{"types": dbus.MakeVariant(devices)}
	var version dbus.Variant
	if p.object.CallWithContext(setup, "org.freedesktop.DBus.Properties.Get", 0, remoteDesktop, "version").Store(&version) == nil {
		if v, ok := version.Value().(uint32); ok && v >= 2 {
			selection["persist_mode"] = dbus.MakeVariant(uint32(2))
			if options.RestoreToken != "" {
				selection["restore_token"] = dbus.MakeVariant(options.RestoreToken)
			}
		}
	}
	if _, err = p.request(setup, remoteDesktop+".SelectDevices", []any{p.session}, selection); err != nil {
		return nil, err
	}
	if _, err = p.request(setup, screenCast+".SelectSources", []any{p.session}, map[string]dbus.Variant{"types": dbus.MakeVariant(uint32(1)), "multiple": dbus.MakeVariant(options.AllMonitors), "cursor_mode": dbus.MakeVariant(uint32(2))}); err != nil {
		return nil, err
	}
	if options.Clipboard {
		if err = p.object.CallWithContext(setup, portalClipboard+".RequestClipboard", 0, p.session, map[string]dbus.Variant{}).Err; err != nil {
			return nil, errors.New("this desktop portal does not support clipboard sharing; update the portal or disable clipboard")
		}
	}
	results, err = p.request(setup, remoteDesktop+".Start", []any{p.session, ""}, nil)
	if err != nil {
		return nil, err
	}
	p.devices, _ = results["devices"].Value().(uint32)
	if p.devices&devices != devices {
		return nil, errors.New("desktop control permission was not granted")
	}
	p.clipboardEnabled, _ = results["clipboard_enabled"].Value().(bool)
	if options.Clipboard && !p.clipboardEnabled {
		return nil, errors.New("clipboard permission was not granted")
	}
	var streams []portalStream
	if results["streams"].Value() == nil {
		return nil, errors.New("portal did not report monitor streams")
	}
	if err = dbus.Store([]any{results["streams"].Value()}, &streams); err != nil {
		return nil, errors.New("portal returned invalid monitor streams")
	}
	layout, err := portalLayout(streams, options.AllMonitors)
	if err != nil {
		return nil, err
	}
	p.frame = Frame{Width: layout.Width, Height: layout.Height, Stride: layout.Width * 4, Screens: layout.Screens, Pixels: make([]byte, layout.Width*layout.Height*4)}
	for i := 3; i < len(p.frame.Pixels); i += 4 {
		p.frame.Pixels[i] = 255
	}
	if token, ok := results["restore_token"].Value().(string); ok && token != "" && options.SaveRestoreToken != nil {
		if len(token) > 4096 {
			return nil, errors.New("invalid portal restore token")
		}
		if err = options.SaveRestoreToken(token); err != nil {
			return nil, err
		}
	}
	signals := make(chan *dbus.Signal, 32)
	bus.Signal(signals)
	if err = bus.AddMatchSignalContext(setup, dbus.WithMatchSender(p.owner), dbus.WithMatchInterface(portalClipboard)); err != nil {
		bus.RemoveSignal(signals)
		return nil, err
	}
	if err = bus.AddMatchSignalContext(setup, dbus.WithMatchSender(p.owner), dbus.WithMatchInterface("org.freedesktop.portal.Session"), dbus.WithMatchObjectPath(p.session)); err != nil {
		bus.RemoveSignal(signals)
		return nil, err
	}
	var captures []portalCapture
	for i, stream := range streams {
		capture, captureErr := p.startCapture(setup, helper, stream, layout.Screens[i])
		if captureErr != nil {
			cancel()
			for _, previous := range captures {
				_ = previous.pipe.Close()
				_ = previous.cmd.Wait()
			}
			bus.RemoveSignal(signals)
			return nil, captureErr
		}
		captures = append(captures, capture)
	}
	started = true
	go p.signalLoop(signals)
	go p.captureStreams(captures)
	select {
	case <-p.ready:
		return p, nil
	case <-p.done:
		return nil, errors.New("GStreamer could not capture the portal stream; check the PipeWire and video conversion plugins")
	case <-setup.Done():
		return nil, setup.Err()
	}
}
func portalLayout(streams []portalStream, multiple bool) (DesktopLayout, error) {
	if len(streams) < 1 || len(streams) > MaxScreens || (!multiple && len(streams) != 1) {
		return DesktopLayout{}, errors.New("invalid portal monitor count; selecting multiple monitors requires --all-monitors")
	}
	layout := DesktopLayout{Screens: make([]Screen, len(streams))}
	var minX, minY, maxX, maxY int64
	for i, stream := range streams {
		var size struct{ Width, Height int32 }
		if stream.Properties["size"].Value() == nil || dbus.Store([]any{stream.Properties["size"].Value()}, &size) != nil || size.Width < 1 || size.Height < 1 || size.Width > MaxDimension || size.Height > MaxDimension {
			return DesktopLayout{}, errors.New("portal did not report valid monitor dimensions")
		}
		var position struct{ X, Y int32 }
		if len(streams) > 1 && (stream.Properties["position"].Value() == nil || dbus.Store([]any{stream.Properties["position"].Value()}, &position) != nil) {
			return DesktopLayout{}, errors.New("portal did not report positions for all selected monitors")
		}
		x, y := int64(position.X), int64(position.Y)
		if i == 0 {
			minX, minY, maxX, maxY = x, y, x, y
		}
		minX, minY = min(minX, x), min(minY, y)
		maxX, maxY = max(maxX, x+int64(size.Width)), max(maxY, y+int64(size.Height))
		layout.Screens[i] = Screen{ID: stream.Node, X: int(position.X), Y: int(position.Y), Width: int(size.Width), Height: int(size.Height)}
	}
	if maxX-minX > MaxDimension || maxY-minY > MaxDimension || (maxX-minX)*(maxY-minY)*4 > MaxFrameBytes {
		return DesktopLayout{}, errors.New("selected portal monitors exceed desktop capture limits")
	}
	layout.Width, layout.Height = int(maxX-minX), int(maxY-minY)
	for i := range layout.Screens {
		screen := &layout.Screens[i]
		screen.X, screen.Y = int(int64(screen.X)-minX), int(int64(screen.Y)-minY)
		for _, other := range layout.Screens[:i] {
			if screen.X < other.X+other.Width && other.X < screen.X+screen.Width && screen.Y < other.Y+other.Height && other.Y < screen.Y+screen.Height {
				return DesktopLayout{}, errors.New("portal reported overlapping monitors")
			}
		}
	}
	return layout, layout.Validate()
}

type portalCapture struct {
	cmd    *exec.Cmd
	pipe   io.ReadCloser
	screen Screen
}

func (p *PortalBackend) startCapture(ctx context.Context, helper string, stream portalStream, screen Screen) (portalCapture, error) {
	// Each PipeWire client needs its own connection, not a duplicated socket.
	var fd dbus.UnixFD
	if err := p.object.CallWithContext(ctx, screenCast+".OpenPipeWireRemote", 0, p.session, map[string]dbus.Variant{}).Store(&fd); err != nil {
		return portalCapture{}, err
	}
	remote := os.NewFile(uintptr(fd), "portal-pipewire")
	defer remote.Close()
	args := []string{"-q", "pipewiresrc", "fd=3", "do-timestamp=true"}
	if serial, ok := stream.Properties["pipewire-serial"].Value().(uint64); ok && serial != 0 {
		args = append(args, "target-object="+strconv.FormatUint(serial, 10))
	} else {
		args = append(args, "path="+strconv.FormatUint(uint64(stream.Node), 10))
	}
	args = append(args, "!", "queue", "max-size-buffers=2", "max-size-bytes=0", "max-size-time=0", "leaky=downstream", "!", "videoconvert", "!", "videoscale", "!", fmt.Sprintf("video/x-raw,format=RGBA,width=%d,height=%d", screen.Width, screen.Height), "!", "fdsink", "fd=1", "sync=false")
	cmd := exec.CommandContext(p.ctx, helper, args...)
	cmd.ExtraFiles = []*os.File{remote}
	cmd.WaitDelay = time.Second
	cmd.Stderr = &BoundedBuffer{Limit: 16 << 10}
	pipe, err := cmd.StdoutPipe()
	if err != nil {
		return portalCapture{}, err
	}
	if err := cmd.Start(); err != nil {
		_ = pipe.Close()
		return portalCapture{}, err
	}
	return portalCapture{cmd: cmd, pipe: pipe, screen: screen}, nil
}

func (p *PortalBackend) captureStreams(captures []portalCapture) {
	defer close(p.done)
	var workers sync.WaitGroup
	remaining := len(captures)
	for _, capture := range captures {
		workers.Go(func() {
			stopPipe := context.AfterFunc(p.ctx, func() { _ = capture.pipe.Close() })
			defer stopPipe()
			defer capture.pipe.Close()
			defer capture.cmd.Wait()
			pixels := make([]byte, capture.screen.Width*capture.screen.Height*4)
			first := true
			for {
				if _, err := io.ReadFull(capture.pipe, pixels); err != nil {
					p.mu.Lock()
					if p.ctx.Err() == nil {
						p.err = errors.New("portal capture stopped unexpectedly")
					}
					p.mu.Unlock()
					p.cancel()
					return
				}
				p.mu.Lock()
				for y := 0; y < capture.screen.Height; y++ {
					dst := (capture.screen.Y+y)*p.frame.Stride + capture.screen.X*4
					src := y * capture.screen.Width * 4
					copy(p.frame.Pixels[dst:dst+capture.screen.Width*4], pixels[src:src+capture.screen.Width*4])
				}
				p.frame.Sequence++
				if first {
					first = false
					remaining--
					if remaining == 0 {
						close(p.ready)
					}
				}
				p.mu.Unlock()
			}
		})
	}
	workers.Wait()
}

func portalPointer(screens []Screen, event PointerEvent) (uint32, float64, float64, bool) {
	x, y := int(event.X), int(event.Y)
	for _, screen := range screens {
		if x >= screen.X && y >= screen.Y && x < screen.X+screen.Width && y < screen.Y+screen.Height {
			return screen.ID, float64(x - screen.X), float64(y - screen.Y), true
		}
	}
	return 0, 0, 0, false
}

func portalToken() (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	return "crabfleet_" + hex.EncodeToString(b[:]), nil
}
func (p *PortalBackend) request(ctx context.Context, method string, args []any, options map[string]dbus.Variant) (map[string]dbus.Variant, error) {
	if options == nil {
		options = make(map[string]dbus.Variant)
	}
	token, err := portalToken()
	if err != nil {
		return nil, err
	}
	options["handle_token"] = dbus.MakeVariant(token)
	signals := make(chan *dbus.Signal, 16)
	p.bus.Signal(signals)
	defer p.bus.RemoveSignal(signals)
	match := []dbus.MatchOption{dbus.WithMatchSender(p.owner), dbus.WithMatchInterface("org.freedesktop.portal.Request"), dbus.WithMatchMember("Response")}
	if err := p.bus.AddMatchSignalContext(ctx, match...); err != nil {
		return nil, err
	}
	defer func() {
		cleanup, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		_ = p.bus.RemoveMatchSignalContext(cleanup, match...)
	}()
	var handle dbus.ObjectPath
	if err := p.object.CallWithContext(ctx, method, 0, append(args, options)...).Store(&handle); err != nil {
		return nil, fmt.Errorf("desktop portal %s failed: %w", method, err)
	}
	for {
		select {
		case <-ctx.Done():
			cleanup, cancel := context.WithTimeout(context.Background(), time.Second)
			defer cancel()
			_ = p.bus.Object(portalName, handle).CallWithContext(cleanup, "org.freedesktop.portal.Request.Close", 0).Err
			return nil, ctx.Err()
		case signal := <-signals:
			if signal == nil {
				return nil, ErrClosed
			}
			if signal.Sender != p.owner || signal.Path != handle || signal.Name != "org.freedesktop.portal.Request.Response" {
				continue
			}
			var code uint32
			var results map[string]dbus.Variant
			if err := dbus.Store(signal.Body, &code, &results); err != nil {
				return nil, errors.New("invalid portal response")
			}
			if code != 0 {
				return nil, errors.New("desktop sharing was cancelled or denied")
			}
			return results, nil
		}
	}
}
func (p *PortalBackend) Capture(ctx context.Context) (Frame, error) {
	if err := ctx.Err(); err != nil {
		return Frame{}, err
	}
	if p.ctx.Err() != nil {
		return Frame{}, ErrClosed
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.err != nil {
		return Frame{}, p.err
	}
	f := p.frame
	f.Pixels = bytes.Clone(f.Pixels)
	f.Screens = append([]Screen(nil), f.Screens...)
	return f, nil
}
func (p *PortalBackend) notify(ctx context.Context, method string, args ...any) error {
	ctx, cancel := context.WithTimeout(ctx, time.Second)
	defer cancel()
	return p.object.CallWithContext(ctx, remoteDesktop+"."+method, 0, append([]any{p.session, map[string]dbus.Variant{}}, args...)...).Err
}
func (p *PortalBackend) Key(ctx context.Context, event KeyEvent) error {
	if p.devices&1 == 0 {
		return errors.New("keyboard control was not granted")
	}
	state := uint32(0)
	if event.Down {
		state = 1
	}
	return p.notify(ctx, "NotifyKeyboardKeysym", int32(event.Keysym), state)
}
func (p *PortalBackend) Pointer(ctx context.Context, event PointerEvent) error {
	if p.devices&2 == 0 {
		return errors.New("pointer control was not granted")
	}
	p.inputMu.Lock()
	defer p.inputMu.Unlock()
	node, x, y, inside := portalPointer(p.frame.Screens, event)
	if inside {
		if err := p.notify(ctx, "NotifyPointerMotionAbsolute", node, x, y); err != nil {
			return err
		}
	} else {
		// Gaps have no target stream, but a release must still end a drag.
		event.ButtonMask &= p.buttons & 7
	}
	for index, button := range []int32{272, 274, 273} {
		mask := byte(1 << index)
		if (event.ButtonMask^p.buttons)&mask == 0 {
			continue
		}
		state := uint32(0)
		if event.ButtonMask&mask != 0 {
			state = 1
		}
		if err := p.notify(ctx, "NotifyPointerButton", button, state); err != nil {
			return err
		}
		p.buttons = (p.buttons &^ mask) | (event.ButtonMask & mask)
	}
	for _, scroll := range []struct {
		mask  byte
		axis  uint32
		steps int32
	}{{8, 0, -1}, {16, 0, 1}, {32, 1, -1}, {64, 1, 1}} {
		if event.ButtonMask&scroll.mask != 0 {
			if err := p.notify(ctx, "NotifyPointerAxisDiscrete", scroll.axis, scroll.steps); err != nil {
				return err
			}
		}
	}
	return nil
}
func (p *PortalBackend) closeSession() {
	if p.session != "" {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		_ = p.bus.Object(portalName, p.session).CallWithContext(ctx, "org.freedesktop.portal.Session.Close", 0).Err
	}
}
func (p *PortalBackend) Close() error {
	p.closeOnce.Do(func() { p.closeSession(); p.cancel(); _ = p.bus.Close(); <-p.done; <-p.signalsDone })
	return nil
}

func (p *PortalBackend) Done() <-chan struct{} { return p.done }

func (p *PortalBackend) Err() error {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.err
}

func (p *PortalBackend) signalLoop(signals chan *dbus.Signal) {
	defer close(p.signalsDone)
	defer p.bus.RemoveSignal(signals)
	for {
		select {
		case <-p.ctx.Done():
			return
		case signal := <-signals:
			if signal == nil {
				return
			}
			if signal.Sender != p.owner {
				continue
			}
			if signal.Name == "org.freedesktop.portal.Session.Closed" && signal.Path == p.session {
				p.cancel()
				return
			}
			if signal.Path != portalPath || len(signal.Body) == 0 || signal.Body[0] != p.session {
				continue
			}
			switch signal.Name {
			case portalClipboard + ".SelectionOwnerChanged":
				var session dbus.ObjectPath
				var options map[string]dbus.Variant
				if dbus.Store(signal.Body, &session, &options) != nil {
					continue
				}
				owner, _ := options["session_is_owner"].Value().(bool)
				types, _ := options["mime_types"].Value().([]string)
				mime := ""
				for _, t := range types {
					if t == "text/plain;charset=utf-8" || t == "text/plain" {
						mime = t
						if strings.Contains(t, "charset") {
							break
						}
					}
				}
				p.mu.Lock()
				p.ownSelection = owner
				p.selectionMIME = mime
				p.mu.Unlock()
			case portalClipboard + ".SelectionTransfer":
				var session dbus.ObjectPath
				var mime string
				var serial uint32
				if dbus.Store(signal.Body, &session, &mime, &serial) != nil {
					continue
				}
				p.transferClipboard(mime, serial)
			}
		}
	}
}
func (p *PortalBackend) WriteClipboard(ctx context.Context, text string) error {
	if !p.clipboardEnabled {
		return errors.New("clipboard permission was not granted")
	}
	if len(text) >= MaxClipboardBytes || !utf8.ValidString(text) || strings.ContainsRune(text, 0) {
		return errors.New("invalid clipboard text")
	}
	p.mu.Lock()
	p.clipboard = text
	p.mu.Unlock()
	ctx, cancel := context.WithTimeout(ctx, time.Second)
	defer cancel()
	return p.object.CallWithContext(ctx, portalClipboard+".SetSelection", 0, p.session, map[string]dbus.Variant{"mime_types": dbus.MakeVariant([]string{"text/plain;charset=utf-8", "text/plain"})}).Err
}
func (p *PortalBackend) ReadClipboard(ctx context.Context) (string, error) {
	if !p.clipboardEnabled {
		return "", errors.New("clipboard unavailable")
	}
	p.mu.Lock()
	owner, text, mime := p.ownSelection, p.clipboard, p.selectionMIME
	p.mu.Unlock()
	if owner {
		return text, nil
	}
	if mime == "" {
		return "", nil
	}
	ctx, cancel := context.WithTimeout(ctx, time.Second)
	defer cancel()
	var fd dbus.UnixFD
	if err := p.object.CallWithContext(ctx, portalClipboard+".SelectionRead", 0, p.session, mime).Store(&fd); err != nil {
		return "", err
	}
	f, err := portalClipboardFile(fd)
	if err != nil {
		return "", err
	}
	defer f.Close()
	stop := context.AfterFunc(ctx, func() { _ = f.Close() })
	defer stop()
	data, err := io.ReadAll(io.LimitReader(f, MaxClipboardBytes+1))
	if err != nil {
		return "", err
	}
	if len(data) > MaxClipboardBytes || !utf8.Valid(data) {
		return "", errors.New("invalid clipboard data")
	}
	return string(data), nil
}
func (p *PortalBackend) transferClipboard(mime string, serial uint32) {
	ctx, cancel := context.WithTimeout(p.ctx, time.Second)
	defer cancel()
	success := false
	defer func() {
		cleanup, stop := context.WithTimeout(p.ctx, time.Second)
		defer stop()
		_ = p.object.CallWithContext(cleanup, portalClipboard+".SelectionWriteDone", 0, p.session, serial, success).Err
	}()
	if mime != "text/plain;charset=utf-8" && mime != "text/plain" {
		return
	}
	p.mu.Lock()
	text := p.clipboard
	p.mu.Unlock()
	var fd dbus.UnixFD
	if p.object.CallWithContext(ctx, portalClipboard+".SelectionWrite", 0, p.session, serial).Store(&fd) != nil {
		return
	}
	f, err := portalClipboardFile(fd)
	if err != nil {
		return
	}
	defer f.Close()
	stop := context.AfterFunc(ctx, func() { _ = f.Close() })
	defer stop()
	_, err = io.Copy(f, strings.NewReader(text))
	success = err == nil
}

func portalClipboardFile(fd dbus.UnixFD) (*os.File, error) {
	if err := unix.SetNonblock(int(fd), true); err != nil {
		_ = unix.Close(int(fd))
		return nil, err
	}
	return os.NewFile(uintptr(fd), "portal-clipboard"), nil
}

// D-Bus's default signal handler can spawn unbounded delivery goroutines.
// Portal control messages cannot be dropped safely, so overflow ends the session.
type boundedPortalSignals struct {
	mu       sync.Mutex
	channels map[chan<- *dbus.Signal]struct{}
	overflow func()
	closed   bool
}

func (s *boundedPortalSignals) DeliverSignal(_ string, _ string, signal *dbus.Signal) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for ch := range s.channels {
		select {
		case ch <- signal:
		default:
			s.overflow()
		}
	}
}
func (s *boundedPortalSignals) AddSignal(ch chan<- *dbus.Signal) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		close(ch)
		return
	}
	s.channels[ch] = struct{}{}
}
func (s *boundedPortalSignals) RemoveSignal(ch chan<- *dbus.Signal) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.channels, ch)
}
func (s *boundedPortalSignals) Terminate() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.closed = true
	for ch := range s.channels {
		close(ch)
		delete(s.channels, ch)
	}
}
