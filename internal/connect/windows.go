//go:build windows

package connect

import (
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"runtime"
	"sync"
	"syscall"
	"unicode"
	"unicode/utf16"
	"unsafe"
)

const (
	windowsSMCXScreen = 0
	windowsSMCYScreen = 1

	windowsBIRGB        = 0
	windowsDIBRGBColors = 0
	windowsSRCCopy      = 0x00cc0020
	windowsCaptureBLT   = 0x40000000

	windowsInputMouse    = 0
	windowsInputKeyboard = 1

	windowsMouseMove       = 0x0001
	windowsMouseLeftDown   = 0x0002
	windowsMouseLeftUp     = 0x0004
	windowsMouseRightDown  = 0x0008
	windowsMouseRightUp    = 0x0010
	windowsMouseMiddleDown = 0x0020
	windowsMouseMiddleUp   = 0x0040
	windowsMouseWheel      = 0x0800
	windowsMouseHWheel     = 0x1000
	windowsMouseAbsolute   = 0x8000

	windowsKeyExtended = 0x0001
	windowsKeyUp       = 0x0002
	windowsKeyUnicode  = 0x0004
	windowsWheelDelta  = 120
)

var (
	windowsUser32                  = syscall.NewLazyDLL("user32.dll")
	windowsGDI32                   = syscall.NewLazyDLL("gdi32.dll")
	windowsProcGetSystemMetrics    = windowsUser32.NewProc("GetSystemMetrics")
	windowsProcSendInput           = windowsUser32.NewProc("SendInput")
	windowsProcGetAsyncKeyState    = windowsUser32.NewProc("GetAsyncKeyState")
	windowsProcGetForegroundWindow = windowsUser32.NewProc("GetForegroundWindow")
	windowsProcGetWindowThreadID   = windowsUser32.NewProc("GetWindowThreadProcessId")
	windowsProcGetKeyboardLayout   = windowsUser32.NewProc("GetKeyboardLayout")
	windowsProcVkKeyScanExW        = windowsUser32.NewProc("VkKeyScanExW")
	windowsProcCreateDCW           = windowsGDI32.NewProc("CreateDCW")
	windowsProcCreateCompatibleDC  = windowsGDI32.NewProc("CreateCompatibleDC")
	windowsProcDeleteDC            = windowsGDI32.NewProc("DeleteDC")
	windowsProcCreateDIBSection    = windowsGDI32.NewProc("CreateDIBSection")
	windowsProcSelectObject        = windowsGDI32.NewProc("SelectObject")
	windowsProcDeleteObject        = windowsGDI32.NewProc("DeleteObject")
	windowsProcBitBlt              = windowsGDI32.NewProc("BitBlt")
	windowsProcGdiFlush            = windowsGDI32.NewProc("GdiFlush")
)

type windowsBitmapInfoHeader struct {
	Size          uint32
	Width         int32
	Height        int32
	Planes        uint16
	BitCount      uint16
	Compression   uint32
	SizeImage     uint32
	XPelsPerMeter int32
	YPelsPerMeter int32
	ClrUsed       uint32
	ClrImportant  uint32
}

type windowsBitmapInfo struct {
	Header windowsBitmapInfoHeader
	Colors [1]uint32
}

type windowsHeldKey struct {
	binding        windowsKeyBinding
	unicodeUnits   []uint16
	syntheticShift bool
}

// WindowsBackend captures the primary desktop with GDI and injects input with
// SendInput. DXGI Desktop Duplication is the intended faster capture follow-up.
type WindowsBackend struct {
	mu sync.Mutex

	closed         bool
	screenDC       uintptr
	memoryDC       uintptr
	bitmap         uintptr
	previousBitmap uintptr
	dibBits        unsafe.Pointer
	width          int
	height         int
	stride         int
	sequence       uint64
	buttonMask     byte
	heldKeys       map[uint32]windowsHeldKey
	syntheticShift int
}

var _ Backend = (*WindowsBackend)(nil)

func NewWindowsBackend() (_ *WindowsBackend, resultErr error) {
	width, _, _ := windowsProcGetSystemMetrics.Call(windowsSMCXScreen)
	height, _, _ := windowsProcGetSystemMetrics.Call(windowsSMCYScreen)
	if width < 1 || width > MaxDimension || height < 1 || height > MaxDimension {
		return nil, fmt.Errorf("invalid Windows primary display dimensions %dx%d", width, height)
	}
	stride, ok := checkedMul(int(width), 4)
	if !ok {
		return nil, errors.New("Windows capture stride overflow")
	}
	bufferSize, ok := checkedMul(stride, int(height))
	if !ok || bufferSize > MaxFrameBytes {
		return nil, errors.New("Windows primary display exceeds capture memory limit")
	}

	backend := &WindowsBackend{
		width:    int(width),
		height:   int(height),
		stride:   stride,
		heldKeys: make(map[uint32]windowsHeldKey),
	}
	defer func() {
		if resultErr != nil {
			backend.cleanupLocked()
		}
	}()

	displayDriver, err := syscall.UTF16PtrFromString("DISPLAY")
	if err != nil {
		return nil, fmt.Errorf("encode Windows display driver name: %w", err)
	}
	backend.screenDC, _, _ = windowsProcCreateDCW.Call(uintptr(unsafe.Pointer(displayDriver)), 0, 0, 0)
	if backend.screenDC == 0 {
		return nil, errors.New("CreateDCW for the Windows display failed")
	}
	backend.memoryDC, _, _ = windowsProcCreateCompatibleDC.Call(backend.screenDC)
	if backend.memoryDC == 0 {
		return nil, errors.New("CreateCompatibleDC failed")
	}
	info := windowsBitmapInfo{Header: windowsBitmapInfoHeader{
		Size:        uint32(unsafe.Sizeof(windowsBitmapInfoHeader{})),
		Width:       int32(backend.width),
		Height:      -int32(backend.height),
		Planes:      1,
		BitCount:    32,
		Compression: windowsBIRGB,
		SizeImage:   uint32(bufferSize),
	}}
	backend.bitmap, _, _ = windowsProcCreateDIBSection.Call(
		backend.screenDC,
		uintptr(unsafe.Pointer(&info)),
		windowsDIBRGBColors,
		uintptr(unsafe.Pointer(&backend.dibBits)),
		0,
		0,
	)
	if backend.bitmap == 0 || backend.dibBits == nil {
		return nil, errors.New("CreateDIBSection failed")
	}
	backend.previousBitmap, _, _ = windowsProcSelectObject.Call(backend.memoryDC, backend.bitmap)
	if backend.previousBitmap == 0 || backend.previousBitmap == ^uintptr(0) {
		return nil, errors.New("SelectObject for the Windows capture bitmap failed")
	}
	return backend, nil
}

func (backend *WindowsBackend) Capture(ctx context.Context) (Frame, error) {
	if err := ctx.Err(); err != nil {
		return Frame{}, err
	}
	backend.mu.Lock()
	defer backend.mu.Unlock()
	if backend.closed {
		return Frame{}, ErrClosed
	}
	// GDI batches are thread-local. Keep BitBlt, GdiFlush, and the direct DIB
	// read on one OS thread so the bitmap memory is synchronized first.
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	result, _, callErr := windowsProcBitBlt.Call(
		backend.memoryDC,
		0,
		0,
		uintptr(backend.width),
		uintptr(backend.height),
		backend.screenDC,
		0,
		0,
		windowsSRCCopy|windowsCaptureBLT,
	)
	if result == 0 {
		return Frame{}, windowsCallError("BitBlt", callErr)
	}
	result, _, callErr = windowsProcGdiFlush.Call()
	if result == 0 {
		return Frame{}, windowsCallError("GdiFlush", callErr)
	}
	source := unsafe.Slice((*byte)(backend.dibBits), backend.stride*backend.height)
	pixels := make([]byte, len(source))
	for offset := 0; offset < len(source); offset += 4 {
		pixels[offset] = source[offset+2]
		pixels[offset+1] = source[offset+1]
		pixels[offset+2] = source[offset]
		pixels[offset+3] = 0xff
	}
	backend.sequence++
	return Frame{
		Width:      backend.width,
		Height:     backend.height,
		Stride:     backend.stride,
		Pixels:     pixels,
		DirtyRects: []Rect{{Width: backend.width, Height: backend.height}},
		Sequence:   backend.sequence,
	}, nil
}

func (backend *WindowsBackend) Pointer(ctx context.Context, event PointerEvent) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if event.ButtonMask&0x80 != 0 {
		return errors.New("Windows input does not support RFB button 8")
	}
	backend.mu.Lock()
	defer backend.mu.Unlock()
	if backend.closed {
		return ErrClosed
	}
	inputs := make([]windowsInput, 0, 8)
	inputs = append(inputs, windowsInput{
		mouseX: backend.absoluteCoordinate(event.X, backend.width),
		mouseY: backend.absoluteCoordinate(event.Y, backend.height),
		flags:  windowsMouseMove | windowsMouseAbsolute,
	})
	for bit := 0; bit < 7; bit++ {
		button := byte(1 << bit)
		wasDown := backend.buttonMask&button != 0
		isDown := event.ButtonMask&button != 0
		if wasDown == isDown {
			continue
		}
		input := windowsInput{}
		switch bit {
		case 0:
			if isDown {
				input.flags = windowsMouseLeftDown
			} else {
				input.flags = windowsMouseLeftUp
			}
		case 1:
			if isDown {
				input.flags = windowsMouseMiddleDown
			} else {
				input.flags = windowsMouseMiddleUp
			}
		case 2:
			if isDown {
				input.flags = windowsMouseRightDown
			} else {
				input.flags = windowsMouseRightUp
			}
		case 3:
			if !isDown {
				continue
			}
			input.flags = windowsMouseWheel
			input.mouseData = windowsWheelDelta
		case 4:
			if !isDown {
				continue
			}
			input.flags = windowsMouseWheel
			input.mouseData = ^uint32(windowsWheelDelta - 1)
		case 5:
			if !isDown {
				continue
			}
			input.flags = windowsMouseHWheel
			input.mouseData = ^uint32(windowsWheelDelta - 1)
		case 6:
			if !isDown {
				continue
			}
			input.flags = windowsMouseHWheel
			input.mouseData = windowsWheelDelta
		}
		inputs = append(inputs, input)
	}
	if err := sendWindowsInputs(inputs); err != nil {
		return err
	}
	backend.buttonMask = event.ButtonMask
	return nil
}

func (backend *WindowsBackend) Key(ctx context.Context, event KeyEvent) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	backend.mu.Lock()
	defer backend.mu.Unlock()
	if backend.closed {
		return ErrClosed
	}
	if held, ok := backend.heldKeys[event.Keysym]; ok {
		if event.Down {
			return sendWindowsInputs(held.keyInputs(false))
		}
		return backend.releaseKey(event.Keysym, held)
	}
	if !event.Down {
		return nil
	}
	held := windowsHeldKey{}
	if binding, ok := windowsKeyBindingForKeysym(event.Keysym); ok {
		held.binding = binding
	} else if character, ok := windowsRuneForKeysym(event.Keysym); ok {
		if backend.shortcutModifierHeld() {
			binding, ok = windowsShortcutBinding(character)
			if !ok {
				return fmt.Errorf("Windows active keymap has no virtual key for keysym %#x", event.Keysym)
			}
			if binding.control && !backend.controlHeld() {
				return fmt.Errorf("Windows active keymap requires Control for keysym %#x", event.Keysym)
			}
			if binding.alt && !backend.altHeld() {
				return fmt.Errorf("Windows active keymap requires Alt for keysym %#x", event.Keysym)
			}
			held.binding = binding
		} else {
			held.unicodeUnits = utf16.Encode([]rune{character})
		}
	} else {
		return fmt.Errorf("Windows keymap has no input for keysym %#x", event.Keysym)
	}
	inputs := make([]windowsInput, 0, len(held.unicodeUnits)+1)
	if len(held.unicodeUnits) == 0 && held.binding.shift && !backend.shiftHeld() {
		shift := windowsKeyBinding{virtualKey: windowsVKShift}
		inputs = append(inputs, windowsInput{keyboard: &shift})
		held.syntheticShift = true
	} else if len(held.unicodeUnits) == 0 && held.binding.shift &&
		backend.syntheticShift > 0 && !backend.explicitShiftHeld() {
		held.syntheticShift = true
	}
	inputs = append(inputs, held.keyInputs(false)...)
	if err := sendWindowsInputs(inputs); err != nil {
		return err
	}
	backend.heldKeys[event.Keysym] = held
	if held.syntheticShift {
		backend.syntheticShift++
	}
	return nil
}

func (backend *WindowsBackend) Close() error {
	backend.mu.Lock()
	defer backend.mu.Unlock()
	if backend.closed && len(backend.heldKeys) == 0 && backend.buttonMask == 0 && backend.syntheticShift == 0 {
		return nil
	}
	inputs := make([]windowsInput, 0, len(backend.heldKeys)+4)
	released := make(map[windowsKeyBinding]struct{}, len(backend.heldKeys))
	for _, held := range backend.heldKeys {
		if len(held.unicodeUnits) != 0 {
			inputs = append(inputs, held.keyInputs(true)...)
			continue
		}
		binding := held.binding
		binding.shift = false
		binding.control = false
		binding.alt = false
		if _, exists := released[binding]; exists {
			continue
		}
		released[binding] = struct{}{}
		inputs = append(inputs, windowsInput{keyboard: &binding, keyUp: true})
	}
	if backend.syntheticShift > 0 {
		shift := windowsKeyBinding{virtualKey: windowsVKShift}
		if _, exists := released[shift]; !exists {
			inputs = append(inputs, windowsInput{keyboard: &shift, keyUp: true})
		}
	}
	if backend.buttonMask&1 != 0 {
		inputs = append(inputs, windowsInput{flags: windowsMouseLeftUp})
	}
	if backend.buttonMask&2 != 0 {
		inputs = append(inputs, windowsInput{flags: windowsMouseMiddleUp})
	}
	if backend.buttonMask&4 != 0 {
		inputs = append(inputs, windowsInput{flags: windowsMouseRightUp})
	}
	releaseErr := sendWindowsInputs(inputs)
	if !backend.closed {
		backend.closed = true
		backend.cleanupLocked()
	}
	if releaseErr != nil {
		return fmt.Errorf("release Windows input: %w", releaseErr)
	}
	backend.heldKeys = nil
	backend.syntheticShift = 0
	backend.buttonMask = 0
	return nil
}

type windowsInput struct {
	mouseX    int32
	mouseY    int32
	mouseData uint32
	flags     uint32
	keyboard  *windowsKeyBinding
	unicode   uint16
	isUnicode bool
	keyUp     bool
}

func (backend *WindowsBackend) releaseKey(keysym uint32, held windowsHeldKey) error {
	inputs := make([]windowsInput, 0, 2)
	if len(held.unicodeUnits) != 0 {
		inputs = append(inputs, held.keyInputs(true)...)
	} else if !backend.bindingHeldByOther(keysym, held.binding) {
		inputs = append(inputs, windowsInput{keyboard: &held.binding, keyUp: true})
		if windowsVirtualKeyIsShift(held.binding.virtualKey) && backend.syntheticShift > 0 {
			shift := windowsKeyBinding{virtualKey: windowsVKShift}
			inputs = append(inputs, windowsInput{keyboard: &shift})
		}
	}
	if held.syntheticShift && backend.syntheticShift == 1 {
		shift := windowsKeyBinding{virtualKey: windowsVKShift}
		inputs = append(inputs, windowsInput{keyboard: &shift, keyUp: true})
		inputs = append(inputs, backend.explicitShiftInputsExcept(keysym)...)
	}
	if err := sendWindowsInputs(inputs); err != nil {
		return err
	}
	delete(backend.heldKeys, keysym)
	if held.syntheticShift {
		backend.syntheticShift--
	}
	return nil
}

func (backend *WindowsBackend) bindingHeldByOther(keysym uint32, binding windowsKeyBinding) bool {
	for candidate, held := range backend.heldKeys {
		if candidate != keysym && len(held.unicodeUnits) == 0 &&
			held.binding.virtualKey == binding.virtualKey && held.binding.extended == binding.extended {
			return true
		}
	}
	return false
}

func (held windowsHeldKey) keyInputs(keyUp bool) []windowsInput {
	if len(held.unicodeUnits) == 0 {
		return []windowsInput{{keyboard: &held.binding, keyUp: keyUp}}
	}
	inputs := make([]windowsInput, 0, len(held.unicodeUnits))
	for _, unit := range held.unicodeUnits {
		inputs = append(inputs, windowsInput{unicode: unit, isUnicode: true, keyUp: keyUp})
	}
	return inputs
}

func (backend *WindowsBackend) shiftHeld() bool {
	if backend.syntheticShift > 0 || backend.explicitShiftHeld() {
		return true
	}
	state, _, _ := windowsProcGetAsyncKeyState.Call(windowsVKShift)
	return state&0x8000 != 0
}

func (backend *WindowsBackend) explicitShiftHeld() bool {
	return backend.explicitShiftHeldExcept(0)
}

func (backend *WindowsBackend) explicitShiftHeldExcept(except uint32) bool {
	for keysym, held := range backend.heldKeys {
		if keysym != except && len(held.unicodeUnits) == 0 && windowsVirtualKeyIsShift(held.binding.virtualKey) {
			return true
		}
	}
	return false
}

func (backend *WindowsBackend) explicitShiftInputsExcept(except uint32) []windowsInput {
	inputs := make([]windowsInput, 0, 2)
	seen := make(map[uint16]struct{}, 2)
	for keysym, held := range backend.heldKeys {
		if keysym == except || len(held.unicodeUnits) != 0 ||
			!windowsVirtualKeyIsShift(held.binding.virtualKey) {
			continue
		}
		if _, exists := seen[held.binding.virtualKey]; exists {
			continue
		}
		seen[held.binding.virtualKey] = struct{}{}
		binding := held.binding
		inputs = append(inputs, windowsInput{keyboard: &binding})
	}
	return inputs
}

func (backend *WindowsBackend) shortcutModifierHeld() bool {
	for _, held := range backend.heldKeys {
		if len(held.unicodeUnits) == 0 &&
			(windowsVirtualKeyIsShift(held.binding.virtualKey) ||
				windowsVirtualKeyIsShortcutModifier(held.binding.virtualKey)) {
			return true
		}
	}
	return false
}

func (backend *WindowsBackend) controlHeld() bool {
	if backend.virtualKeyHeld(windowsVKControl, windowsVKLControl, windowsVKRControl) {
		return true
	}
	_, level3Shift := backend.heldKeys[uint32(0xfe03)]
	_, modeSwitch := backend.heldKeys[uint32(0xff7e)]
	return level3Shift || modeSwitch
}

func (backend *WindowsBackend) altHeld() bool {
	return backend.virtualKeyHeld(windowsVKMenu, windowsVKLMenu, windowsVKRMenu)
}

func (backend *WindowsBackend) virtualKeyHeld(virtualKeys ...uint16) bool {
	for _, held := range backend.heldKeys {
		if len(held.unicodeUnits) != 0 {
			continue
		}
		for _, virtualKey := range virtualKeys {
			if held.binding.virtualKey == virtualKey {
				return true
			}
		}
	}
	return false
}

func windowsShortcutBinding(character rune) (windowsKeyBinding, bool) {
	if character < 0 || character > 0xffff {
		return windowsKeyBinding{}, false
	}
	foreground, _, _ := windowsProcGetForegroundWindow.Call()
	threadID := uintptr(0)
	if foreground != 0 {
		threadID, _, _ = windowsProcGetWindowThreadID.Call(foreground, 0)
	}
	layout, _, _ := windowsProcGetKeyboardLayout.Call(threadID)
	if layout == 0 {
		return windowsKeyBinding{}, false
	}
	result, _, _ := windowsProcVkKeyScanExW.Call(uintptr(character), layout)
	value := uint16(result)
	if value == 0xffff {
		return windowsKeyBinding{}, false
	}
	modifiers := byte(value >> 8)
	if modifiers & ^byte(0x07) != 0 {
		return windowsKeyBinding{}, false
	}
	// RFB reports the resulting letter. Explicit Shift events carry chord
	// identity; uppercase can instead result from the client's Caps Lock.
	if unicode.IsLetter(character) {
		modifiers &^= 1
	}
	return windowsKeyBinding{
		virtualKey: value & 0xff,
		shift:      modifiers&1 != 0,
		control:    modifiers&2 != 0,
		alt:        modifiers&4 != 0,
	}, true
}

func (backend *WindowsBackend) absoluteCoordinate(coordinate uint16, dimension int) int32 {
	if dimension <= 1 {
		return 0
	}
	maximum := uint64(dimension - 1)
	value := min(uint64(coordinate), maximum)
	return int32((value*65_535 + maximum/2) / maximum)
}

func (backend *WindowsBackend) cleanupLocked() {
	if backend.memoryDC != 0 && backend.previousBitmap != 0 && backend.previousBitmap != ^uintptr(0) {
		windowsProcSelectObject.Call(backend.memoryDC, backend.previousBitmap)
		backend.previousBitmap = 0
	}
	if backend.bitmap != 0 {
		windowsProcDeleteObject.Call(backend.bitmap)
		backend.bitmap = 0
		backend.dibBits = nil
	}
	if backend.memoryDC != 0 {
		windowsProcDeleteDC.Call(backend.memoryDC)
		backend.memoryDC = 0
	}
	if backend.screenDC != 0 {
		windowsProcDeleteDC.Call(backend.screenDC)
		backend.screenDC = 0
	}
}

func sendWindowsInputs(inputs []windowsInput) error {
	if len(inputs) == 0 {
		return nil
	}
	inputSize, _ := windowsInputLayout()
	buffer := encodeWindowsInputs(inputs)
	inserted, _, callErr := windowsProcSendInput.Call(
		uintptr(len(inputs)),
		uintptr(unsafe.Pointer(&buffer[0])),
		uintptr(inputSize),
	)
	if inserted != uintptr(len(inputs)) {
		failure := windowsCallError(fmt.Sprintf("SendInput inserted %d of %d events", inserted, len(inputs)), callErr)
		if inserted == 0 {
			return failure
		}
		compensation := windowsInputCompensation(inputs[:inserted])
		if len(compensation) == 0 {
			return failure
		}
		compensationBuffer := encodeWindowsInputs(compensation)
		compensated, _, compensationErr := windowsProcSendInput.Call(
			uintptr(len(compensation)),
			uintptr(unsafe.Pointer(&compensationBuffer[0])),
			uintptr(inputSize),
		)
		if compensated != uintptr(len(compensation)) {
			return fmt.Errorf(
				"%w; compensation inserted %d of %d events: %v",
				failure, compensated, len(compensation), compensationErr,
			)
		}
		return failure
	}
	return nil
}

func encodeWindowsInputs(inputs []windowsInput) []byte {
	inputSize, dataOffset := windowsInputLayout()
	buffer := make([]byte, len(inputs)*inputSize)
	for index, input := range inputs {
		target := buffer[index*inputSize : (index+1)*inputSize]
		if input.keyboard != nil || input.isUnicode {
			binary.LittleEndian.PutUint32(target, windowsInputKeyboard)
			if input.isUnicode {
				binary.LittleEndian.PutUint16(target[dataOffset+2:], input.unicode)
			} else {
				binary.LittleEndian.PutUint16(target[dataOffset:], input.keyboard.virtualKey)
			}
			flags := uint32(0)
			if input.isUnicode {
				flags |= windowsKeyUnicode
			} else if input.keyboard.extended {
				flags |= windowsKeyExtended
			}
			if input.keyUp {
				flags |= windowsKeyUp
			}
			binary.LittleEndian.PutUint32(target[dataOffset+4:], flags)
			continue
		}
		binary.LittleEndian.PutUint32(target, windowsInputMouse)
		binary.LittleEndian.PutUint32(target[dataOffset:], uint32(input.mouseX))
		binary.LittleEndian.PutUint32(target[dataOffset+4:], uint32(input.mouseY))
		binary.LittleEndian.PutUint32(target[dataOffset+8:], input.mouseData)
		binary.LittleEndian.PutUint32(target[dataOffset+12:], input.flags)
	}
	return buffer
}

func windowsInputCompensation(inserted []windowsInput) []windowsInput {
	result := make([]windowsInput, 0, len(inserted))
	for index := len(inserted) - 1; index >= 0; index-- {
		input := inserted[index]
		if input.keyboard != nil || input.isUnicode {
			input.keyUp = !input.keyUp
			result = append(result, input)
			continue
		}
		switch input.flags {
		case windowsMouseLeftDown:
			input.flags = windowsMouseLeftUp
		case windowsMouseLeftUp:
			input.flags = windowsMouseLeftDown
		case windowsMouseMiddleDown:
			input.flags = windowsMouseMiddleUp
		case windowsMouseMiddleUp:
			input.flags = windowsMouseMiddleDown
		case windowsMouseRightDown:
			input.flags = windowsMouseRightUp
		case windowsMouseRightUp:
			input.flags = windowsMouseRightDown
		default:
			continue
		}
		result = append(result, input)
	}
	return result
}

func windowsInputLayout() (size, dataOffset int) {
	if unsafe.Sizeof(uintptr(0)) == 8 {
		return 40, 8
	}
	return 28, 4
}

func windowsCallError(action string, err error) error {
	if err == nil || errors.Is(err, syscall.Errno(0)) {
		return errors.New(action + " failed")
	}
	return fmt.Errorf("%s: %w", action, err)
}
