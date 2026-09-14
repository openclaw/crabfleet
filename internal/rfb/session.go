package rfb

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"sync"
	"time"

	"github.com/openclaw/crabfleet/internal/connect"
)

const (
	defaultHandshakeTimeout = 10 * time.Second
	defaultMediaTimeout     = 5 * time.Second
	defaultJPEGQuality      = 80
	maximumPressedKeys      = 32
)

type SessionConfig struct {
	Backend          connect.Backend
	Password         string
	DesktopName      string
	ChallengeReader  io.Reader
	HandshakeTimeout time.Duration
	MediaTimeout     time.Duration
	JPEGQuality      int
	ViewOnly         bool
	AllowResize      bool
	Clipboard        connect.Clipboard
	SharedFolder     *SharedFolder
	Audio            connect.AudioSource
	Video            connect.VideoEncoder
	// Set only by PublishRelay after the ownership-authenticated WebSocket opens.
	relay bool
}

func (config SessionConfig) normalized() (SessionConfig, error) {
	if config.Backend == nil {
		return config, errors.New("RFB backend is required")
	}
	if config.Password == "" {
		return config, errors.New("RFB password is required")
	}
	if _, err := vncKey(config.Password); err != nil {
		return config, err
	}
	passwordLength := 0
	for range config.Password {
		passwordLength++
	}
	if passwordLength > 8 {
		return config, errors.New("VNC passwords are limited to eight ISO-8859-1 characters")
	}
	if len([]byte(config.DesktopName)) > MaxDesktopName {
		return config, errors.New("desktop name is too long")
	}
	if config.DesktopName == "" {
		config.DesktopName = "Crabfleet Connect"
	}
	if config.ChallengeReader == nil {
		config.ChallengeReader = rand.Reader
	}
	if config.HandshakeTimeout == 0 {
		config.HandshakeTimeout = defaultHandshakeTimeout
	}
	if config.MediaTimeout == 0 {
		config.MediaTimeout = defaultMediaTimeout
	}
	if config.JPEGQuality == 0 {
		config.JPEGQuality = defaultJPEGQuality
	}
	if config.HandshakeTimeout < 0 || config.MediaTimeout < 0 || config.JPEGQuality < 1 || config.JPEGQuality > 100 {
		return config, errors.New("invalid RFB session limits")
	}
	return config, nil
}

func ServeConn(ctx context.Context, connection net.Conn, config SessionConfig) error {
	config, err := config.normalized()
	if err != nil {
		return err
	}
	if connection == nil {
		return errors.New("RFB connection is required")
	}
	stopWatch := make(chan struct{})
	go func() {
		select {
		case <-ctx.Done():
			_ = connection.Close()
		case <-stopWatch:
		}
	}()
	defer close(stopWatch)

	if config.HandshakeTimeout > 0 && !config.relay {
		if err := connection.SetDeadline(time.Now().Add(config.HandshakeTimeout)); err != nil {
			return err
		}
	}
	handshakeContext, cancelHandshake := context.WithCancel(ctx)
	if !config.relay {
		cancelHandshake()
		handshakeContext, cancelHandshake = context.WithTimeout(ctx, config.HandshakeTimeout)
	}
	frame, err := handshake(handshakeContext, connection, config)
	cancelHandshake()
	if err != nil {
		return fmt.Errorf("RFB handshake: %w", err)
	}
	if err := connection.SetDeadline(time.Time{}); err != nil {
		return err
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	return messageLoop(ctx, connection, config, frame)
}

func handshake(ctx context.Context, connection net.Conn, config SessionConfig) (connect.Frame, error) {
	if err := writeFull(connection, Version38Banner); err != nil {
		return connect.Frame{}, err
	}
	clientBanner := make([]byte, len(Version38Banner))
	if _, err := io.ReadFull(connection, clientBanner); err != nil {
		return connect.Frame{}, err
	}
	if string(clientBanner) != string(Version38Banner) {
		return connect.Frame{}, errors.New("unsupported RFB version")
	}
	if config.relay {
		if err := connection.SetDeadline(time.Now().Add(config.HandshakeTimeout)); err != nil {
			return connect.Frame{}, err
		}
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, config.HandshakeTimeout)
		defer cancel()
	}
	if err := authenticateViewer(connection, config); err != nil {
		return connect.Frame{}, err
	}
	clientInit := []byte{0}
	if _, err := io.ReadFull(connection, clientInit); err != nil {
		return connect.Frame{}, err
	}
	if clientInit[0] == 0 {
		return connect.Frame{}, errors.New("exclusive ClientInit is not supported")
	}
	frame, err := config.Backend.Capture(ctx)
	if err != nil {
		return connect.Frame{}, fmt.Errorf("initial capture: %w", err)
	}
	if err := frame.Validate(); err != nil {
		return connect.Frame{}, err
	}
	serverInit, err := ServerInit(frame.Width, frame.Height, config.DesktopName)
	if err != nil {
		return connect.Frame{}, err
	}
	if err := writeFull(connection, serverInit); err != nil {
		return connect.Frame{}, err
	}
	return frame, nil
}

func authenticateViewer(connection net.Conn, config SessionConfig) error {
	if config.relay {
		if err := writeFull(connection, []byte{1, 1}); err != nil {
			return err
		}
		var selection [1]byte
		if _, err := io.ReadFull(connection, selection[:]); err != nil {
			return err
		}
		if selection[0] != 1 {
			return errors.New("unsupported relay security selection")
		}
		return writeFull(connection, []byte{0, 0, 0, 0})
	}
	if err := writeFull(connection, []byte{1, SecurityVNC}); err != nil {
		return err
	}
	selection := []byte{0}
	if _, err := io.ReadFull(connection, selection); err != nil {
		return err
	}
	if selection[0] != SecurityVNC {
		return errors.New("unsupported RFB security selection")
	}
	challenge := make([]byte, 16)
	if _, err := io.ReadFull(config.ChallengeReader, challenge); err != nil {
		return fmt.Errorf("generate VNC challenge: %w", err)
	}
	if err := writeFull(connection, challenge); err != nil {
		return err
	}
	response := make([]byte, 16)
	if _, err := io.ReadFull(connection, response); err != nil {
		return err
	}
	accepted, err := VerifyVNCResponse(challenge, response, config.Password)
	if err != nil {
		return err
	}
	if !accepted {
		if err := sendSecurityFailure(connection, "Authentication failed."); err != nil {
			return err
		}
		return errors.New("VNC authentication failed")
	}
	if err := writeFull(connection, []byte{0, 0, 0, 0}); err != nil {
		return err
	}
	return nil
}

func sendSecurityFailure(writer io.Writer, reason string) error {
	reasonBytes := []byte(reason)
	if len(reasonBytes) > MaxSecurityReason {
		return errors.New("security failure reason is too long")
	}
	result := make([]byte, 8+len(reasonBytes))
	binary.BigEndian.PutUint32(result, 1)
	binary.BigEndian.PutUint32(result[4:], uint32(len(reasonBytes)))
	copy(result[8:], reasonBytes)
	return writeFull(writer, result)
}

func messageLoop(ctx context.Context, connection net.Conn, config SessionConfig, initialFrame connect.Frame) error {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	var writeMu sync.Mutex
	send := func(p []byte) error {
		if len(p) == 0 {
			return nil
		}
		writeMu.Lock()
		defer writeMu.Unlock()
		return writeMedia(connection, p, config.MediaTimeout)
	}
	files := &fileSession{folder: config.SharedFolder, viewOnly: config.ViewOnly}
	defer files.close()
	clipboard := &clipboardSession{source: config.Clipboard, viewOnly: config.ViewOnly}
	_, _ = clipboard.poll(ctx)
	nextClipboardPoll := time.Now().Add(500 * time.Millisecond)
	var audioCancel context.CancelFunc
	var audioDone <-chan struct{}
	stopAudio := func() {
		if audioCancel != nil {
			audioCancel()
			<-audioDone
			audioCancel = nil
		}
	}
	defer stopAudio()
	width, height := initialFrame.Width, initialFrame.Height
	layout := initialFrame.DesktopLayout()
	lastDesktopRevision := initialFrame.DesktopRevision
	layoutSent := false
	var encodings Encodings
	var negotiated bool
	var lastCursorShape *connect.Cursor
	var videoState videoSession
	pressedKeys := make(map[uint32]struct{})
	var lastPointer connect.PointerEvent
	defer func() { releaseInput(config.Backend, pressedKeys, lastPointer) }()
	for {
		messageType := []byte{0}
		if _, err := io.ReadFull(connection, messageType); err != nil {
			return err
		}
		switch messageType[0] {
		case 0:
			if err := parseSetPixelFormat(connection); err != nil {
				return err
			}
		case 2:
			next, err := parseSetEncodings(connection)
			if err != nil {
				return err
			}
			fileSharingStarted := next.FileSharing && !encodings.FileSharing
			encodings = next
			layoutSent = false
			negotiated = true
			lastCursorShape = nil
			clipboard.extended = next.Clipboard
			if next.Clipboard && config.Clipboard != nil {
				if err := send(clipboard.capabilities()); err != nil {
					return err
				}
			}
			if next.FileSharing && config.SharedFolder != nil {
				if fileSharingStarted {
					if err := send(config.SharedFolder.capability(config.ViewOnly)); err != nil {
						return err
					}
				}
			} else {
				files.close()
			}
			if !next.Audio {
				wasPlaying := audioCancel != nil
				stopAudio()
				if wasPlaying {
					if err := send([]byte{200, 3, 0, 0}); err != nil {
						return err
					}
				}
			} else if audioDone != nil {
				select {
				case <-audioDone:
					stopAudio()
				default:
				}
			}
			if next.Audio && config.Audio != nil && audioCancel == nil {
				audioContext, stop := context.WithCancel(ctx)
				packets, err := config.Audio.Subscribe(audioContext)
				if err != nil {
					stop()
					continue
				}
				if err := send([]byte{200, 1, 1, 2, 0, 0, 187, 128, 0, 0, 0, 2, 0x11, 0x90}); err != nil {
					stop()
					for range packets {
					}
					return err
				}
				done := make(chan struct{})
				audioCancel, audioDone = stop, done
				go func() {
					defer close(done)
					defer func() {
						stop()
						// Packet closure fences the capture process's final reap.
						for range packets {
						}
					}()
					for {
						select {
						case <-audioContext.Done():
							return
						case packet, ok := <-packets:
							if !ok {
								_ = send([]byte{200, 3, 0, 0})
								return
							}
							if len(packet.Payload) == 0 || len(packet.Payload) > 64<<10 {
								continue
							}
							p := binary.BigEndian.AppendUint32([]byte{200, 2, 0, 0}, packet.TimestampMS)
							p = binary.BigEndian.AppendUint32(p, uint32(len(packet.Payload)))
							if err := send(append(p, packet.Payload...)); err != nil && !errors.Is(err, errMediaDropped) {
								_ = connection.Close()
								return
							}
						}
					}
				}()
			}
		case 3:
			request, err := parseFramebufferRequest(connection)
			if err != nil {
				return err
			}
			if !negotiated || (!encodings.Tight && !encodings.Raw && !encodings.H264 && !encodings.HEVC) {
				return errors.New("the client did not offer a supported video encoding")
			}
			frame, err := config.Backend.Capture(ctx)
			if err != nil {
				return fmt.Errorf("capture framebuffer: %w", err)
			}
			if err := frame.Validate(); err != nil {
				return err
			}
			nextLayout := frame.DesktopLayout()
			sizeChanged := frame.Width != width || frame.Height != height
			layoutChanged := !layout.Equal(nextLayout)
			if sizeChanged && !encodings.ExtendedDesktopSize && !encodings.DesktopSize {
				return errors.New("framebuffer size changed without resize negotiation")
			}
			if (encodings.ExtendedDesktopSize && (!request.Incremental || !layoutSent || layoutChanged)) || (encodings.DesktopSize && sizeChanged) {
				reason := 0
				if request.Incremental && frame.DesktopRevision != lastDesktopRevision {
					reason = 2
				}
				if !encodings.ExtendedDesktopSize {
					reason = 0
				}
				metadata, err := desktopSizeUpdate(nextLayout, encodings.ExtendedDesktopSize, reason, 0)
				if err != nil {
					return err
				}
				// Control metadata is a separate update and cannot be dropped:
				// all subsequent pixels and pointer coordinates depend on it.
				if err := send(metadata); err != nil {
					return err
				}
				layoutSent = true
				videoState.resetPending = true
			}
			layout = nextLayout
			lastDesktopRevision = frame.DesktopRevision
			width, height = frame.Width, frame.Height
			video, err := encodeVideoRectangle(ctx, config, encodings, frame)
			if err != nil {
				return err
			}
			nextVideoContext := videoState.prepare(video)
			rectangles := [][]byte{video}
			var nextCursorShape *connect.Cursor
			if source, ok := config.Backend.(connect.CursorCapturer); ok && encodings.cursorEncoding() != 0 {
				cursor, cursorErr := source.Cursor(ctx)
				if cursorErr == nil {
					if err := cursor.Validate(width, height); err != nil {
						return err
					}
					if lastCursorShape == nil || !sameCursorShape(*lastCursorShape, cursor) {
						shape, err := cursorRectangle(cursor, encodings.cursorEncoding())
						if err != nil {
							return err
						}
						rectangles = append(rectangles, shape)
						copy := cursor
						copy.RGBA = append([]byte(nil), cursor.RGBA...)
						nextCursorShape = &copy
					}
					if cursor.Visible && encodings.PointerPosition {
						position, err := pointerPositionRectangle(cursor.X, cursor.Y)
						if err != nil {
							return err
						}
						rectangles = append(rectangles, position)
					}
				}
			}
			update, err := framebufferUpdate(rectangles...)
			if err != nil {
				return err
			}
			if err := send(update); err != nil {
				if !errors.Is(err, errMediaDropped) {
					return err
				}
				// The media frame was dropped before any bytes reached the wire.
				// Preserve request/response pacing with a legal empty update. If
				// even that control response cannot be sent, framing cannot recover.
				if err := send([]byte{0, 0, 0, 0}); err != nil {
					return fmt.Errorf("send empty update after media drop: %w", err)
				}
				continue
			}
			videoState.sent(nextVideoContext)
			if nextCursorShape != nil {
				lastCursorShape = nextCursorShape
			}
			if time.Now().After(nextClipboardPoll) {
				clip, err := clipboard.poll(ctx)
				nextClipboardPoll = time.Now().Add(500 * time.Millisecond)
				if err != nil {
					return err
				}
				if err := send(clip); err != nil {
					return err
				}
			}
		case 4:
			down, keysym, err := parseKeyEvent(connection)
			if err != nil {
				return err
			}
			if config.ViewOnly {
				continue
			}
			if down {
				if _, alreadyPressed := pressedKeys[keysym]; !alreadyPressed && len(pressedKeys) >= maximumPressedKeys {
					return errors.New("too many simultaneously pressed keys")
				}
			}
			if err := config.Backend.Key(ctx, connect.KeyEvent{Down: down, Keysym: keysym}); err != nil {
				return fmt.Errorf("inject key: %w", err)
			}
			if down {
				pressedKeys[keysym] = struct{}{}
			} else {
				delete(pressedKeys, keysym)
			}
		case 5:
			mask, x, y, err := parsePointerEvent(connection, width, height)
			if err != nil {
				return err
			}
			if config.ViewOnly {
				continue
			}
			if err := config.Backend.Pointer(ctx, connect.PointerEvent{ButtonMask: mask, X: x, Y: y}); err != nil {
				return fmt.Errorf("inject pointer: %w", err)
			}
			lastPointer = connect.PointerEvent{ButtonMask: mask, X: x, Y: y}
		case 6:
			response, err := clipboard.receive(ctx, connection)
			if err != nil {
				return err
			}
			if err := send(response); err != nil {
				return err
			}
		case 251:
			requested, err := parseSetDesktopSize(connection)
			if err != nil {
				return err
			}
			if !encodings.ExtendedDesktopSize {
				return errors.New("desktop resizing was not negotiated")
			}
			status := 0
			var resizedFrame connect.Frame
			if requested.Validate() != nil {
				status = 3
			} else if config.ViewOnly || !config.AllowResize {
				status = 1
			} else if resizer, ok := config.Backend.(connect.DesktopResizer); !ok || !resizer.DesktopResizeSupported() {
				status = 1
			} else {
				resizeContext, cancelResize := context.WithTimeout(ctx, defaultMediaTimeout)
				resizedFrame, err = resizeDesktopFrame(resizeContext, config.Backend, resizer, requested)
				cancelResize()
				if errors.Is(err, connect.ErrResizeProhibited) {
					status = 1
				} else if errors.Is(err, connect.ErrResizeUnsupported) {
					status = 3
				} else if err != nil {
					status = 2
				}
			}
			// Failed replies do not change client geometry. If a platform
			// partially applied a request, the next capture announces its real
			// layout as a separate server-side change before sending pixels.
			if status == 0 {
				layout = resizedFrame.DesktopLayout()
				width, height = resizedFrame.Width, resizedFrame.Height
				lastDesktopRevision = resizedFrame.DesktopRevision
			}
			response, err := desktopSizeUpdate(layout, true, 1, status)
			if err != nil {
				return err
			}
			if err := send(response); err != nil {
				return err
			}
			layoutSent = true
			if status == 0 {
				videoState.resetPending = true
			}
			lastCursorShape = nil
		case 202:
			if !encodings.FileSharing || config.SharedFolder == nil {
				return errors.New("file sharing was not negotiated")
			}
			response, err := files.handle(connection)
			if err != nil {
				return err
			}
			if err := send(response); err != nil {
				return err
			}
		default:
			return fmt.Errorf("unsupported client message %d", messageType[0])
		}
	}
}

func sameCursorShape(left, right connect.Cursor) bool {
	return left.Visible == right.Visible && left.Width == right.Width && left.Height == right.Height &&
		left.HotspotX == right.HotspotX && left.HotspotY == right.HotspotY && bytes.Equal(left.RGBA, right.RGBA)
}

func releaseInput(backend connect.InputSink, keys map[uint32]struct{}, pointer connect.PointerEvent) {
	if releaser, ok := backend.(interface{ releaseSessionInput(context.Context) }); ok {
		ctx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
		defer cancel()
		releaser.releaseSessionInput(ctx)
		return
	}

	deadline := time.Now().Add(500 * time.Millisecond)
	for keysym := range keys {
		for attempt := 0; attempt < 3; attempt++ {
			remaining := time.Until(deadline)
			if remaining <= 0 {
				return
			}
			if remaining > 10*time.Millisecond {
				remaining = 10 * time.Millisecond
			}
			ctx, cancel := context.WithTimeout(context.Background(), remaining)
			err := backend.Key(ctx, connect.KeyEvent{Down: false, Keysym: keysym})
			cancel()
			if err == nil {
				break
			}
		}
	}
	if pointer.ButtonMask != 0 && time.Now().Before(deadline) {
		pointer.ButtonMask = 0
		for attempt := 0; attempt < 3; attempt++ {
			ctx, cancel := context.WithDeadline(context.Background(), deadline)
			err := backend.Pointer(ctx, pointer)
			cancel()
			if err == nil {
				break
			}
		}
	}
}

const (
	maxLegacyClipboardBytes  = 1 * 1024 * 1024
	maxExtendedClipboardBody = 4 + maxLegacyClipboardBytes + 65_536
)

var errMediaDropped = errors.New("media write deadline expired before transmission")

func writeMedia(connection net.Conn, payload []byte, timeout time.Duration) error {
	if timeout > 0 {
		if err := connection.SetWriteDeadline(time.Now().Add(timeout)); err != nil {
			return err
		}
		defer connection.SetWriteDeadline(time.Time{}) //nolint:errcheck // the write result remains authoritative
	}
	written := 0
	for written < len(payload) {
		count, err := connection.Write(payload[written:])
		written += count
		if err != nil {
			if timeoutError, ok := err.(net.Error); ok && timeoutError.Timeout() && written == 0 {
				return errMediaDropped
			}
			return err
		}
		if count == 0 {
			return io.ErrShortWrite
		}
	}
	return nil
}

func writeFull(writer io.Writer, payload []byte) error {
	for len(payload) > 0 {
		count, err := writer.Write(payload)
		if err != nil {
			return err
		}
		if count == 0 {
			return io.ErrShortWrite
		}
		payload = payload[count:]
	}
	return nil
}
