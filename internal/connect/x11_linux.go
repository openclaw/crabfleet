//go:build linux

package connect

import (
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"math"
	"math/bits"
	"slices"
	"sync"
	"sync/atomic"
	"time"

	"github.com/jezek/xgb"
	"github.com/jezek/xgb/randr"
	"github.com/jezek/xgb/shm"
	"github.com/jezek/xgb/xfixes"
	"github.com/jezek/xgb/xproto"
	"github.com/jezek/xgb/xtest"
	"golang.org/x/sys/unix"
)

// LinuxX11 captures the default X11 screen with MIT-SHM and injects input
// through XTest. It intentionally has no Wayland fallback.
type LinuxX11 struct {
	mu        sync.Mutex
	stateMu   sync.Mutex
	closeOnce sync.Once
	closed    atomic.Bool

	connection         *xgb.Conn
	root               xproto.Window
	width              int
	height             int
	scanlinePad        int
	randrVersion       uint32
	screens            []Screen
	stride             int
	bytesPixel         int
	byteOrder          byte
	redMask            uint32
	greenMask          uint32
	blueMask           uint32
	segment            shm.Seg
	shmBytes           []byte
	keymap             x11Keymap
	heldKeys           map[byte]struct{}
	heldKeyStates      map[uint32]x11HeldKeyState
	syntheticModifiers []byte
	modifierShift      bool
	modifierMode       bool
	buttonMask         byte
	sequence           uint64
}

func NewLinuxX11(display string) (_ *LinuxX11, resultErr error) {
	connection, err := xgb.NewConnDisplay(display)
	if err != nil {
		return nil, fmt.Errorf("connect to X11 display: %w", err)
	}
	backend := &LinuxX11{connection: connection}
	defer func() {
		if resultErr != nil {
			_ = backend.closeLocked()
		}
	}()
	if err := shm.Init(connection); err != nil {
		return nil, fmt.Errorf("initialize X11 MIT-SHM: %w", err)
	}
	if _, err := shm.QueryVersion(connection).Reply(); err != nil {
		return nil, fmt.Errorf("query X11 MIT-SHM: %w", err)
	}
	if err := xtest.Init(connection); err != nil {
		return nil, fmt.Errorf("initialize X11 XTest: %w", err)
	}
	if err := xfixes.Init(connection); err != nil {
		return nil, fmt.Errorf("initialize X11 XFixes: %w", err)
	}
	xfixesVersion, err := xfixes.QueryVersion(connection, 1, 0).Reply()
	if err != nil {
		return nil, fmt.Errorf("negotiate X11 XFixes 1.0: %w", err)
	}
	if xfixesVersion == nil || xfixesVersion.MajorVersion < 1 {
		return nil, errors.New("X11 XFixes 1.0 is unavailable")
	}

	setup := xproto.Setup(connection)
	screen := setup.DefaultScreen(connection)
	if screen == nil || screen.WidthInPixels == 0 || screen.HeightInPixels == 0 {
		return nil, errors.New("X11 default screen is unavailable")
	}
	format, ok := pixmapFormat(setup, screen.RootDepth)
	if !ok || (format.BitsPerPixel != 16 && format.BitsPerPixel != 24 && format.BitsPerPixel != 32) {
		return nil, fmt.Errorf("unsupported X11 root depth %d", screen.RootDepth)
	}
	visual, ok := rootVisual(screen)
	if !ok || visual.Class != xproto.VisualClassTrueColor ||
		visual.RedMask == 0 || visual.GreenMask == 0 || visual.BlueMask == 0 {
		return nil, errors.New("X11 root visual is not TrueColor")
	}
	backend.root = screen.Root
	backend.bytesPixel = int(format.BitsPerPixel) / 8
	backend.scanlinePad = int(format.ScanlinePad)
	// RandR is optional: older servers still provide live root geometry.
	if err := randr.Init(connection); err == nil {
		if version, err := randr.QueryVersion(connection, 1, 5).Reply(); err == nil && version != nil && version.MajorVersion == 1 {
			backend.randrVersion = version.MinorVersion
		}
	}
	if err := backend.refreshGeometryLocked(); err != nil {
		return nil, err
	}

	keymap, err := loadKeymap(connection, setup)
	if err != nil {
		return nil, err
	}
	backend.byteOrder = setup.ImageByteOrder
	backend.redMask = visual.RedMask
	backend.greenMask = visual.GreenMask
	backend.blueMask = visual.BlueMask
	backend.keymap = keymap
	backend.heldKeys = make(map[byte]struct{})
	backend.heldKeyStates = make(map[uint32]x11HeldKeyState)
	return backend, nil
}

func (backend *LinuxX11) Capture(ctx context.Context) (Frame, error) {
	if err := ctx.Err(); err != nil {
		return Frame{}, err
	}
	backend.mu.Lock()
	defer backend.mu.Unlock()
	if backend.closed.Load() {
		return Frame{}, ErrClosed
	}
	// A mode switch can race the root query or GetImage. Retry a bounded number
	// of times so no frame advertises dimensions from a different capture.
	captured := false
	for attempt := 0; attempt < 3; attempt++ {
		if err := ctx.Err(); err != nil {
			return Frame{}, err
		}
		if err := backend.refreshGeometryLocked(); err != nil {
			return Frame{}, err
		}
		reply, captureErr := shm.GetImage(
			backend.connection, xproto.Drawable(backend.root), 0, 0,
			uint16(backend.width), uint16(backend.height), math.MaxUint32,
			xproto.ImageFormatZPixmap, backend.segment, 0,
		).Reply()
		geometry, err := xproto.GetGeometry(backend.connection, xproto.Drawable(backend.root)).Reply()
		if err != nil || geometry == nil {
			return Frame{}, fmt.Errorf("query X11 root after capture: %v", err)
		}
		if int(geometry.Width) != backend.width || int(geometry.Height) != backend.height {
			continue
		}
		if captureErr != nil {
			return Frame{}, fmt.Errorf("XShmGetImage: %w", captureErr)
		}
		if reply == nil || int(reply.Size) > len(backend.shmBytes) || int(reply.Size) < backend.stride*backend.height {
			return Frame{}, errors.New("XShmGetImage returned an invalid size")
		}
		captured = true
		break
	}
	if !captured {
		return Frame{}, errors.New("X11 geometry changed repeatedly during capture")
	}
	pixels := make([]byte, backend.width*backend.height*4)
	for y := 0; y < backend.height; y++ {
		for x := 0; x < backend.width; x++ {
			source := y*backend.stride + x*backend.bytesPixel
			pixel := backend.readPixel(backend.shmBytes[source : source+backend.bytesPixel])
			target := (y*backend.width + x) * 4
			pixels[target] = scaleMasked(pixel, backend.redMask)
			pixels[target+1] = scaleMasked(pixel, backend.greenMask)
			pixels[target+2] = scaleMasked(pixel, backend.blueMask)
			pixels[target+3] = 0xff
		}
	}
	backend.sequence++
	return Frame{
		Width:      backend.width,
		Height:     backend.height,
		Stride:     backend.width * 4,
		Pixels:     pixels,
		DirtyRects: []Rect{{Width: backend.width, Height: backend.height}},
		Sequence:   backend.sequence,
		Screens:    slices.Clone(backend.screens),
	}, nil
}

func (backend *LinuxX11) Pointer(ctx context.Context, event PointerEvent) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	backend.mu.Lock()
	defer backend.mu.Unlock()
	if backend.closed.Load() {
		return ErrClosed
	}
	backend.stateMu.Lock()
	defer backend.stateMu.Unlock()
	if backend.closed.Load() {
		return ErrClosed
	}
	x := int16(min(int(event.X), math.MaxInt16))
	y := int16(min(int(event.Y), math.MaxInt16))
	xtest.FakeInput(backend.connection, xproto.MotionNotify, 0, 0, backend.root, x, y, 0)
	for bit := 0; bit < 8; bit++ {
		button := byte(1 << bit)
		wasDown := backend.buttonMask&button != 0
		isDown := event.ButtonMask&button != 0
		if wasDown == isDown {
			continue
		}
		eventType := byte(xproto.ButtonRelease)
		if isDown {
			eventType = xproto.ButtonPress
		}
		xtest.FakeInput(backend.connection, eventType, byte(bit+1), 0, 0, 0, 0, 0)
		if isDown {
			backend.buttonMask |= button
		} else {
			backend.buttonMask &^= button
		}
	}
	return nil
}

func (backend *LinuxX11) Key(ctx context.Context, event KeyEvent) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	backend.mu.Lock()
	defer backend.mu.Unlock()
	if backend.closed.Load() {
		return ErrClosed
	}
	binding, ok := backend.keymap.bindings[event.Keysym]
	if !ok {
		return fmt.Errorf("X11 keymap has no keycode for keysym %#x", event.Keysym)
	}
	var modifierState x11ModifierState
	modifierAlreadyDown := false
	if event.Down && backend.isModifier(binding.keycode) {
		var err error
		modifierAlreadyDown, err = backend.queryKeycodeDown(binding.keycode)
		if err != nil {
			return fmt.Errorf("query X11 modifier key: %w", err)
		}
	}
	if event.Down && !backend.isModifier(binding.keycode) {
		var err error
		modifierState, err = backend.queryModifierState()
		if err != nil {
			return fmt.Errorf("query X11 modifier state: %w", err)
		}
	}
	backend.stateMu.Lock()
	defer backend.stateMu.Unlock()
	if backend.closed.Load() {
		return ErrClosed
	}
	if backend.isModifier(binding.keycode) {
		eventType := byte(xproto.KeyRelease)
		if event.Down {
			if modifierAlreadyDown {
				return errors.New("X11 modifier key is already physically down")
			}
			eventType = xproto.KeyPress
		} else if _, owned := backend.heldKeys[binding.keycode]; !owned {
			return nil
		}
		backend.sendKey(eventType, binding.keycode)
		if event.Down {
			backend.heldKeys[binding.keycode] = struct{}{}
		} else {
			delete(backend.heldKeys, binding.keycode)
		}
		return nil
	}
	if event.Down {
		if held, exists := backend.heldKeyStates[event.Keysym]; exists {
			backend.sendKey(xproto.KeyPress, held.keycode)
			return nil
		}
		lockActive := modifierState.mask&xproto.ModMaskLock != 0
		ownedModifiers := uint16(0)
		for keycode := range backend.heldKeys {
			ownedModifiers |= backend.keymap.modifierMasks[keycode]
		}
		for _, keycode := range backend.syntheticModifiers {
			ownedModifiers |= backend.keymap.modifierMasks[keycode]
		}
		const actionableModifiers = uint16(
			xproto.ModMaskShift | xproto.ModMaskControl |
				xproto.ModMask1 | xproto.ModMask2 | xproto.ModMask3 |
				xproto.ModMask4 | xproto.ModMask5,
		)
		unownedModifiers := modifierState.mask & actionableModifiers &^ ownedModifiers &^
			backend.keymap.numLockMask
		if unownedModifiers != 0 {
			return fmt.Errorf("unowned X11 modifier mask %#x is active", unownedModifiers)
		}
		requiredShift := requiredX11PhysicalShift(
			binding,
			lockActive,
			backend.keymap.lockMode,
			modifierState.mask&backend.keymap.numLockMask != 0,
		)
		if !binding.shiftSensitive && modifierState.mask&ownedModifiers&xproto.ModMaskShift != 0 {
			requiredShift = true
		}
		requiredMode := binding.mode
		if len(backend.heldKeyStates) > 0 {
			if requiredShift != backend.modifierShift || requiredMode != backend.modifierMode {
				return errors.New("simultaneous X11 keys require conflicting modifier levels")
			}
		} else {
			pressed, err := backend.applyRequiredModifiers(requiredShift, requiredMode, modifierState)
			if err != nil {
				return fmt.Errorf("XTest key %#x: %w", event.Keysym, err)
			}
			backend.syntheticModifiers = pressed
			backend.modifierShift = requiredShift
			backend.modifierMode = requiredMode
		}
		backend.sendKey(xproto.KeyPress, binding.keycode)
		backend.heldKeyStates[event.Keysym] = x11HeldKeyState{keycode: binding.keycode}
		backend.heldKeys[binding.keycode] = struct{}{}
		return nil
	}
	held, exists := backend.heldKeyStates[event.Keysym]
	if !exists {
		return nil
	}
	backend.sendKey(xproto.KeyRelease, held.keycode)
	delete(backend.heldKeyStates, event.Keysym)
	if !backend.keycodeHeldByNonModifier(held.keycode) {
		delete(backend.heldKeys, held.keycode)
	}
	if len(backend.heldKeyStates) == 0 {
		backend.releaseSyntheticModifiers(backend.syntheticModifiers)
		backend.syntheticModifiers = nil
	}
	return nil
}

func (backend *LinuxX11) Cursor(ctx context.Context) (Cursor, error) {
	if err := ctx.Err(); err != nil {
		return Cursor{}, err
	}
	backend.mu.Lock()
	defer backend.mu.Unlock()
	if backend.closed.Load() {
		return Cursor{}, ErrClosed
	}
	reply, err := xfixes.GetCursorImage(backend.connection).Reply()
	if err != nil {
		return Cursor{}, fmt.Errorf("get X11 cursor image: %w", err)
	}
	if reply == nil || reply.Width == 0 || reply.Height == 0 {
		return Cursor{}, errors.New("XFixes returned an empty cursor image")
	}
	return cursorFromXFixes(
		int(reply.X), int(reply.Y), int(reply.Width), int(reply.Height),
		int(reply.Xhot), int(reply.Yhot), reply.CursorImage, backend.width, backend.height,
	)
}

func (backend *LinuxX11) Close() error {
	backend.closeOnce.Do(func() {
		backend.closed.Store(true)
		backend.releaseInputBeforeClose()
		// Closing the X connection interrupts a pending Reply before teardown
		// waits for the operation lock.
		if backend.connection != nil {
			backend.connection.Close()
		}
		backend.mu.Lock()
		defer backend.mu.Unlock()
		backend.cleanupLocked()
	})
	return nil
}

func (backend *LinuxX11) closeLocked() error {
	if backend.closed.Swap(true) {
		return nil
	}
	if backend.connection != nil {
		backend.connection.Close()
	}
	backend.cleanupLocked()
	return nil
}

func (backend *LinuxX11) cleanupLocked() {
	if backend.connection != nil {
		// Connection close releases server-side input state and SHM attachment.
		backend.connection = nil
	}
	if len(backend.shmBytes) > 0 {
		_ = unix.SysvShmDetach(backend.shmBytes)
		backend.shmBytes = nil
	}
}

func (backend *LinuxX11) sendKey(eventType, keycode byte) {
	xtest.FakeInput(
		backend.connection, eventType, keycode, 0, 0, 0, 0, 0,
	)
}

func (backend *LinuxX11) isModifier(keycode byte) bool {
	_, modifier := backend.keymap.modifierKeys[keycode]
	return modifier
}

type x11HeldKeyState struct {
	keycode byte
}

type x11ModifierState struct {
	mask uint16
}

func (backend *LinuxX11) queryModifierState() (x11ModifierState, error) {
	pointer, err := xproto.QueryPointer(backend.connection, backend.root).Reply()
	if err != nil {
		return x11ModifierState{}, fmt.Errorf("query pointer: %w", err)
	}
	if pointer == nil {
		return x11ModifierState{}, errors.New("query pointer returned no reply")
	}
	return x11ModifierState{mask: pointer.Mask}, nil
}

func (backend *LinuxX11) queryKeycodeDown(keycode byte) (bool, error) {
	keys, err := xproto.QueryKeymap(backend.connection).Reply()
	if err != nil {
		return false, err
	}
	if keys == nil || len(keys.Keys) != 32 {
		return false, errors.New("query keymap returned invalid data")
	}
	return keys.Keys[int(keycode)/8]&(1<<uint(keycode%8)) != 0, nil
}

func (backend *LinuxX11) applyRequiredModifiers(
	requiredShift, requiredMode bool,
	state x11ModifierState,
) ([]byte, error) {
	var pressed []byte
	adjust := func(preferred byte, active, required bool) error {
		if active && !required {
			return errors.New("active unowned X11 modifier conflicts with requested keysym")
		}
		if required && !active {
			if preferred == 0 {
				return errors.New("required X11 modifier is unavailable")
			}
			backend.sendKey(xproto.KeyPress, preferred)
			pressed = append(pressed, preferred)
		}
		return nil
	}
	if err := adjust(
		backend.keymap.preferredShift,
		state.mask&xproto.ModMaskShift != 0,
		requiredShift,
	); err != nil {
		backend.releaseSyntheticModifiers(pressed)
		return nil, err
	}
	if err := adjust(
		backend.keymap.preferredMode,
		state.mask&backend.keymap.modeMask != 0,
		requiredMode,
	); err != nil {
		backend.releaseSyntheticModifiers(pressed)
		return nil, err
	}
	return pressed, nil
}

func (backend *LinuxX11) releaseSyntheticModifiers(pressed []byte) {
	for index := len(pressed) - 1; index >= 0; index-- {
		backend.sendKey(xproto.KeyRelease, pressed[index])
	}
}

func (backend *LinuxX11) keycodeHeldByNonModifier(keycode byte) bool {
	for _, held := range backend.heldKeyStates {
		if held.keycode == keycode {
			return true
		}
	}
	return false
}

func (backend *LinuxX11) releaseInputBeforeClose() {
	backend.stateMu.Lock()
	defer backend.stateMu.Unlock()
	if backend.connection == nil {
		return
	}
	for keycode := range backend.heldKeys {
		xtest.FakeInput(backend.connection, xproto.KeyRelease, keycode, 0, 0, 0, 0, 0)
	}
	backend.releaseSyntheticModifiers(backend.syntheticModifiers)
	for bit := 0; bit < 8; bit++ {
		if backend.buttonMask&(1<<bit) != 0 {
			xtest.FakeInput(backend.connection, xproto.ButtonRelease, byte(bit+1), 0, 0, 0, 0, 0)
		}
	}
	backend.heldKeys = make(map[byte]struct{})
	backend.heldKeyStates = make(map[uint32]x11HeldKeyState)
	backend.syntheticModifiers = nil
	backend.buttonMask = 0
	connection := backend.connection
	synced := make(chan struct{})
	go func() {
		connection.Sync()
		close(synced)
	}()
	select {
	case <-synced:
	case <-time.After(100 * time.Millisecond):
	}
}

func (backend *LinuxX11) readPixel(source []byte) uint32 {
	if backend.byteOrder == xproto.ImageOrderMSBFirst {
		switch len(source) {
		case 2:
			return uint32(binary.BigEndian.Uint16(source))
		case 3:
			return uint32(source[0])<<16 | uint32(source[1])<<8 | uint32(source[2])
		case 4:
			return binary.BigEndian.Uint32(source)
		}
	}
	switch len(source) {
	case 2:
		return uint32(binary.LittleEndian.Uint16(source))
	case 3:
		return uint32(source[0]) | uint32(source[1])<<8 | uint32(source[2])<<16
	case 4:
		return binary.LittleEndian.Uint32(source)
	default:
		return 0
	}
}

func pixmapFormat(setup *xproto.SetupInfo, depth byte) (xproto.Format, bool) {
	for _, format := range setup.PixmapFormats {
		if format.Depth == depth {
			return format, true
		}
	}
	return xproto.Format{}, false
}

func rootVisual(screen *xproto.ScreenInfo) (xproto.VisualInfo, bool) {
	for _, depth := range screen.AllowedDepths {
		for _, visual := range depth.Visuals {
			if visual.VisualId == screen.RootVisual {
				return visual, true
			}
		}
	}
	return xproto.VisualInfo{}, false
}

func loadKeymap(connection *xgb.Conn, setup *xproto.SetupInfo) (x11Keymap, error) {
	count := int(setup.MaxKeycode) - int(setup.MinKeycode) + 1
	if count < 1 || count > math.MaxUint8 {
		return x11Keymap{}, errors.New("invalid X11 keycode range")
	}
	reply, err := xproto.GetKeyboardMapping(connection, setup.MinKeycode, byte(count)).Reply()
	if err != nil {
		return x11Keymap{}, fmt.Errorf("read X11 keymap: %w", err)
	}
	if reply == nil || reply.KeysymsPerKeycode == 0 {
		return x11Keymap{}, errors.New("X11 keymap is empty")
	}
	modifierReply, err := xproto.GetModifierMapping(connection).Reply()
	if err != nil {
		return x11Keymap{}, fmt.Errorf("read X11 modifier map: %w", err)
	}
	if modifierReply == nil || modifierReply.KeycodesPerModifier == 0 {
		return x11Keymap{}, errors.New("X11 modifier map is empty")
	}
	perModifier := int(modifierReply.KeycodesPerModifier)
	if len(modifierReply.Keycodes) != perModifier*8 {
		return x11Keymap{}, errors.New("X11 modifier map has invalid dimensions")
	}
	var modifiers x11ModifierMap
	for modifier := range modifiers {
		for _, keycode := range modifierReply.Keycodes[modifier*perModifier : (modifier+1)*perModifier] {
			modifiers[modifier] = append(modifiers[modifier], byte(keycode))
		}
	}
	keysyms := make([]uint32, len(reply.Keysyms))
	for index, keysym := range reply.Keysyms {
		keysyms[index] = uint32(keysym)
	}
	return buildX11Keymap(keysyms, byte(setup.MinKeycode), count, int(reply.KeysymsPerKeycode), modifiers)
}

func scaleMasked(pixel, mask uint32) byte {
	shift := bits.TrailingZeros32(mask)
	maximum := mask >> shift
	value := (pixel & mask) >> shift
	return byte((uint64(value)*255 + uint64(maximum)/2) / uint64(maximum))
}

func x11BufferSize(width, height, bytesPixel, pad int) (stride, size int, err error) {
	if width < 1 || width > MaxDimension || height < 1 || height > MaxDimension ||
		bytesPixel < 2 || bytesPixel > 4 || (pad != 8 && pad != 16 && pad != 32) {
		return 0, 0, errors.New("invalid X11 framebuffer geometry or format")
	}
	stride = ((width*bytesPixel*8 + pad - 1) / pad) * (pad / 8)
	size, ok := checkedMul(stride, height)
	rgbaSize, rgbaOK := checkedMul(width*4, height)
	if !ok || !rgbaOK || size > MaxFrameBytes || rgbaSize > MaxFrameBytes {
		return 0, 0, errors.New("X11 framebuffer exceeds capture memory limit")
	}
	return stride, size, nil
}

func (backend *LinuxX11) refreshGeometryLocked() error {
	var width, height, stride, size int
	var screens []Screen
	for attempt := 0; ; attempt++ {
		geometry, err := xproto.GetGeometry(backend.connection, xproto.Drawable(backend.root)).Reply()
		if err != nil || geometry == nil {
			return fmt.Errorf("query X11 root geometry: %v", err)
		}
		width, height = int(geometry.Width), int(geometry.Height)
		stride, size, err = x11BufferSize(width, height, backend.bytesPixel, backend.scanlinePad)
		if err != nil {
			return err
		}
		var layoutErr error
		screens, layoutErr = backend.monitorLayoutLocked(width, height)
		after, err := xproto.GetGeometry(backend.connection, xproto.Drawable(backend.root)).Reply()
		if err != nil || after == nil {
			return fmt.Errorf("confirm X11 root geometry: %v", err)
		}
		if after.Width != geometry.Width || after.Height != geometry.Height {
			if attempt < 2 {
				continue
			}
			return errors.New("X11 geometry changed repeatedly during layout query")
		}
		if layoutErr != nil {
			return layoutErr
		}
		break
	}
	if backend.width != width || backend.height != height || len(backend.shmBytes) == 0 {
		if err := backend.replaceSHMLocked(size); err != nil {
			return err
		}
		backend.width, backend.height, backend.stride = width, height, stride
	}
	backend.screens = screens
	return nil
}

func (backend *LinuxX11) replaceSHMLocked(size int) error {
	if backend.segment != 0 {
		if err := shm.DetachChecked(backend.connection, backend.segment).Check(); err != nil {
			return fmt.Errorf("detach previous X11 shared memory: %w", err)
		}
		backend.segment = 0
	}
	if len(backend.shmBytes) != 0 {
		if err := unix.SysvShmDetach(backend.shmBytes); err != nil {
			return fmt.Errorf("detach previous local X11 shared memory: %w", err)
		}
		backend.shmBytes = nil
	}
	shmID, err := unix.SysvShmGet(unix.IPC_PRIVATE, size, unix.IPC_CREAT|0o600)
	if err != nil {
		return fmt.Errorf("allocate X11 shared memory: %w", err)
	}
	defer func() { _, _ = unix.SysvShmCtl(shmID, unix.IPC_RMID, nil) }()
	data, err := unix.SysvShmAttach(shmID, 0, 0)
	if err != nil {
		return fmt.Errorf("attach X11 shared memory locally: %w", err)
	}
	segmentID, err := backend.connection.NewId()
	if err != nil {
		_ = unix.SysvShmDetach(data)
		return fmt.Errorf("allocate X11 shared segment id: %w", err)
	}
	segment := shm.Seg(segmentID)
	if err := shm.AttachChecked(backend.connection, segment, uint32(shmID), false).Check(); err != nil {
		_ = unix.SysvShmDetach(data)
		return fmt.Errorf("attach X11 shared memory to server: %w", err)
	}
	if _, err := unix.SysvShmCtl(shmID, unix.IPC_RMID, nil); err != nil {
		_ = shm.DetachChecked(backend.connection, segment).Check()
		_ = unix.SysvShmDetach(data)
		return fmt.Errorf("mark X11 shared memory for removal: %w", err)
	}
	backend.segment, backend.shmBytes = segment, data
	return nil
}

func (backend *LinuxX11) monitorLayoutLocked(width, height int) ([]Screen, error) {
	var screens []Screen
	if backend.randrVersion >= 5 {
		reply, err := randr.GetMonitors(backend.connection, backend.root, true).Reply()
		if err != nil || reply == nil {
			return nil, fmt.Errorf("query X11 RandR monitors: %v", err)
		}
		if len(reply.Monitors) > MaxScreens {
			return nil, errors.New("X11 RandR exceeds 16 monitors")
		}
		for _, monitor := range reply.Monitors {
			screens = append(screens, Screen{ID: uint32(monitor.Name), X: int(monitor.X), Y: int(monitor.Y), Width: int(monitor.Width), Height: int(monitor.Height)})
		}
	} else if backend.randrVersion >= 2 {
		resources, err := randr.GetScreenResources(backend.connection, backend.root).Reply()
		if err != nil || resources == nil {
			return nil, fmt.Errorf("query X11 RandR resources: %v", err)
		}
		if len(resources.Crtcs) > MaxScreens {
			return nil, errors.New("X11 RandR exceeds 16 CRTCs")
		}
		for _, crtc := range resources.Crtcs {
			info, err := randr.GetCrtcInfo(backend.connection, crtc, resources.ConfigTimestamp).Reply()
			if err != nil || info == nil || info.Status != randr.SetConfigSuccess {
				return nil, fmt.Errorf("query X11 RandR CRTC: %v", err)
			}
			if info.Mode != 0 && info.Width != 0 && info.Height != 0 {
				screens = append(screens, Screen{ID: uint32(crtc), X: int(info.X), Y: int(info.Y), Width: int(info.Width), Height: int(info.Height)})
			}
		}
	}
	if len(screens) == 0 {
		screens = []Screen{{ID: uint32(backend.root), Width: width, Height: height}}
	}
	slices.SortFunc(screens, func(a, b Screen) int {
		if a.ID < b.ID {
			return -1
		}
		if a.ID > b.ID {
			return 1
		}
		return 0
	})
	if err := (DesktopLayout{Width: width, Height: height, Screens: screens}).Validate(); err != nil {
		return nil, fmt.Errorf("invalid X11 RandR layout: %w", err)
	}
	return screens, nil
}

// DesktopResizeSupported reports modes this backend can apply atomically using
// RandR's legacy single-screen request. Multi-monitor topology edits are excluded.
func (backend *LinuxX11) DesktopResizeSupported() bool {
	backend.mu.Lock()
	defer backend.mu.Unlock()
	if backend.closed.Load() || backend.randrVersion < 2 {
		return false
	}
	if err := backend.refreshGeometryLocked(); err != nil || !x11SingleScreen(backend.screens, backend.width, backend.height) {
		return false
	}
	info, err := randr.GetScreenInfo(backend.connection, backend.root).Reply()
	if err != nil || info == nil {
		return false
	}
	for _, size := range info.Sizes {
		width, height := x11RotatedSize(size, info.Rotation)
		if _, _, err := x11BufferSize(width, height, backend.bytesPixel, backend.scanlinePad); err == nil &&
			(width != backend.width || height != backend.height) {
			return true
		}
	}
	return false
}

func x11SingleScreen(screens []Screen, width, height int) bool {
	return len(screens) == 1 && screens[0].X == 0 && screens[0].Y == 0 &&
		screens[0].Width == width && screens[0].Height == height && screens[0].Flags == 0
}

func x11RotatedSize(size randr.ScreenSize, rotation uint16) (int, int) {
	if rotation&(randr.RotationRotate90|randr.RotationRotate270) != 0 {
		return int(size.Height), int(size.Width)
	}
	return int(size.Width), int(size.Height)
}

func x11ResizeMode(info *randr.GetScreenInfoReply, layout DesktopLayout) (uint16, uint16, error) {
	if info == nil || len(info.Sizes) > math.MaxUint16 || !x11SingleScreen(layout.Screens, layout.Width, layout.Height) {
		return 0, 0, ErrResizeUnsupported
	}
	for index, size := range info.Sizes {
		width, height := x11RotatedSize(size, info.Rotation)
		if width != layout.Width || height != layout.Height {
			continue
		}
		// Zero selects the server's default rate when the old rate is unavailable.
		rate := uint16(0)
		if index < len(info.Rates) && slices.Contains(info.Rates[index].Rates, info.Rate) {
			rate = info.Rate
		}
		return uint16(index), rate, nil
	}
	return 0, 0, ErrResizeUnsupported
}

func (backend *LinuxX11) ResizeDesktop(ctx context.Context, layout DesktopLayout) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := layout.Validate(); err != nil {
		return err
	}
	backend.mu.Lock()
	defer backend.mu.Unlock()
	if backend.closed.Load() {
		return ErrClosed
	}
	if backend.randrVersion < 2 {
		return ErrResizeUnsupported
	}
	if err := backend.refreshGeometryLocked(); err != nil {
		return err
	}
	if !x11SingleScreen(backend.screens, backend.width, backend.height) ||
		!x11SingleScreen(layout.Screens, layout.Width, layout.Height) ||
		layout.Screens[0].ID != backend.screens[0].ID {
		return ErrResizeUnsupported
	}
	info, err := randr.GetScreenInfo(backend.connection, backend.root).Reply()
	if err != nil {
		return fmt.Errorf("query X11 resize modes: %w", err)
	}
	sizeID, rate, err := x11ResizeMode(info, layout)
	if err != nil {
		return err
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	// SetScreenConfig applies one server-advertised mode in a single request;
	// arbitrary framebuffer sizes and partial CRTC reconfiguration are not used.
	reply, err := randr.SetScreenConfig(backend.connection, backend.root, info.Timestamp, info.ConfigTimestamp, sizeID, info.Rotation, rate).Reply()
	if err != nil {
		return fmt.Errorf("resize X11 screen: %w", err)
	}
	if reply == nil || reply.Status != randr.SetConfigSuccess {
		return ErrResizeUnsupported
	}
	if err := backend.refreshGeometryLocked(); err != nil {
		return err
	}
	if backend.width != layout.Width || backend.height != layout.Height {
		return errors.New("X11 resize did not apply requested dimensions")
	}
	return nil
}
