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

	if config.HandshakeTimeout > 0 {
		if err := connection.SetDeadline(time.Now().Add(config.HandshakeTimeout)); err != nil {
			return err
		}
	}
	handshakeContext, cancelHandshake := context.WithTimeout(ctx, config.HandshakeTimeout)
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
	if err := writeFull(connection, []byte{2, SecurityARD, SecurityVNC}); err != nil {
		return connect.Frame{}, err
	}
	selection := []byte{0}
	if _, err := io.ReadFull(connection, selection); err != nil {
		return connect.Frame{}, err
	}
	if selection[0] == SecurityARD {
		err := sendSecurityFailure(connection, "ARD host authentication is not implemented by Crabfleet Connect yet.")
		if err != nil {
			return connect.Frame{}, err
		}
		return connect.Frame{}, errors.New("ARD host authentication is deferred")
	}
	if selection[0] != SecurityVNC {
		return connect.Frame{}, errors.New("unsupported RFB security selection")
	}
	challenge := make([]byte, 16)
	if _, err := io.ReadFull(config.ChallengeReader, challenge); err != nil {
		return connect.Frame{}, fmt.Errorf("generate VNC challenge: %w", err)
	}
	if err := writeFull(connection, challenge); err != nil {
		return connect.Frame{}, err
	}
	response := make([]byte, 16)
	if _, err := io.ReadFull(connection, response); err != nil {
		return connect.Frame{}, err
	}
	accepted, err := VerifyVNCResponse(challenge, response, config.Password)
	if err != nil {
		return connect.Frame{}, err
	}
	if !accepted {
		if err := sendSecurityFailure(connection, "Authentication failed."); err != nil {
			return connect.Frame{}, err
		}
		return connect.Frame{}, errors.New("VNC authentication failed")
	}
	if err := writeFull(connection, []byte{0, 0, 0, 0}); err != nil {
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
	if _, err := EncodeJPEG(frame, config.JPEGQuality); err != nil {
		return connect.Frame{}, fmt.Errorf("initial Tight JPEG: %w", err)
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
	width, height := initialFrame.Width, initialFrame.Height
	var encodings Encodings
	var negotiated bool
	var lastCursorShape *connect.Cursor
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
			encodings = next
			negotiated = true
			lastCursorShape = nil
		case 3:
			if _, err := parseFramebufferRequest(connection, width, height); err != nil {
				return err
			}
			if !negotiated || !encodings.Tight {
				return errors.New("the client did not offer Tight encoding")
			}
			frame, err := config.Backend.Capture(ctx)
			if err != nil {
				return fmt.Errorf("capture framebuffer: %w", err)
			}
			if err := frame.Validate(); err != nil {
				return err
			}
			if frame.Width != width || frame.Height != height {
				return errors.New("framebuffer size changed without resize negotiation")
			}
			payload, err := EncodeJPEG(frame, config.JPEGQuality)
			if err != nil {
				return err
			}
			video, err := tightJPEGRectangle(width, height, payload)
			if err != nil {
				return err
			}
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
			if err := writeMedia(connection, update, config.MediaTimeout); err != nil {
				if !errors.Is(err, errMediaDropped) {
					return err
				}
				// The media frame was dropped before any bytes reached the wire.
				// Preserve request/response pacing with a legal empty update. If
				// even that control response cannot be sent, framing cannot recover.
				if err := writeMedia(connection, []byte{0, 0, 0, 0}, config.MediaTimeout); err != nil {
					return fmt.Errorf("send empty update after media drop: %w", err)
				}
				continue
			}
			if nextCursorShape != nil {
				lastCursorShape = nextCursorShape
			}
		case 4:
			down, keysym, err := parseKeyEvent(connection)
			if err != nil {
				return err
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
			if err := config.Backend.Pointer(ctx, connect.PointerEvent{ButtonMask: mask, X: x, Y: y}); err != nil {
				return fmt.Errorf("inject pointer: %w", err)
			}
			lastPointer = connect.PointerEvent{ButtonMask: mask, X: x, Y: y}
		case 6:
			if err := consumeClientCutText(connection); err != nil {
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

func consumeClientCutText(reader io.Reader) error {
	header := make([]byte, 7)
	if _, err := io.ReadFull(reader, header); err != nil {
		return err
	}
	if header[0] != 0 || header[1] != 0 || header[2] != 0 {
		return errors.New("invalid ClientCutText padding")
	}
	length := int64(int32(binary.BigEndian.Uint32(header[3:])))
	limit := int64(maxLegacyClipboardBytes)
	if length < 0 {
		length = -length
		limit = maxExtendedClipboardBody
	}
	if length > limit {
		return errors.New("ClientCutText payload is too large")
	}
	_, err := io.CopyN(io.Discard, reader, length)
	return err
}

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
