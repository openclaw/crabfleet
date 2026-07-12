package terminalws

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"

	"github.com/coder/websocket"
)

const (
	magic         = 0x5943
	version       = 2
	maxFrameBytes = 16 * 1024 * 1024
	maxErrorBytes = 512

	messageHello           = 1
	messageWelcome         = 2
	messageSubscribe       = 10
	messageUnsubscribe     = 11
	messageOutput          = 20
	messageSnapshot        = 21
	messageEvent           = 22
	messageError           = 23
	messageInput           = 30
	messageKey             = 31
	messageResize          = 32
	messageStop            = 33
	messageControlRequest  = 50
	messageControlDecision = 51
	messageControlGranted  = 52
	messageControlRevoked  = 53
	messagePing            = 60
	messagePong            = 61
	messageAck             = 62

	subscribeOutput                 = 1 << 0
	subscribeSnapshot               = 1 << 1
	subscribeEvents                 = 1 << 2
	subscribeOutputAcknowledgements = 1 << 3
)

type Options struct {
	HTTPClient *http.Client
	Header     http.Header
	Cols       uint32
	Rows       uint32
}

type HandshakeStatusError struct {
	StatusCode int
	Status     string
	Body       string
}

func (e *HandshakeStatusError) Error() string {
	if e.Body == "" {
		return fmt.Sprintf("terminal websocket %s", e.Status)
	}
	return fmt.Sprintf("terminal websocket %s: %s", e.Status, e.Body)
}

type Size struct {
	Cols uint32
	Rows uint32
}

type Client struct {
	conn      *websocket.Conn
	sessionID string
	canInput  atomic.Bool
	lastSize  atomic.Uint64
	writeMu   sync.Mutex
}

type frame struct {
	messageType byte
	sessionID   string
	payload     []byte
}

type eventPayload struct {
	Type     string `json:"type"`
	Error    string `json:"error"`
	Reason   string `json:"reason"`
	CanInput bool   `json:"canInput"`
}

type readCanceler interface {
	CancelRead() error
}

func Endpoint(baseURL string) (string, error) {
	target, err := url.Parse(baseURL)
	if err != nil {
		return "", err
	}
	switch target.Scheme {
	case "https":
		target.Scheme = "wss"
	case "http":
		target.Scheme = "ws"
	case "wss", "ws":
	default:
		return "", fmt.Errorf("unsupported terminal URL scheme %q", target.Scheme)
	}
	target.Path = "/api/terminal/ws"
	target.RawPath = ""
	target.RawQuery = ""
	target.Fragment = ""
	return target.String(), nil
}

func Dial(ctx context.Context, endpoint string, sessionID string, options Options) (*Client, error) {
	if sessionID == "" {
		return nil, errors.New("terminal session id is required")
	}
	if options.HTTPClient != nil && options.HTTPClient.Timeout > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, options.HTTPClient.Timeout)
		defer cancel()
	}
	conn, resp, err := websocket.Dial(ctx, endpoint, &websocket.DialOptions{
		HTTPClient: options.HTTPClient,
		HTTPHeader: options.Header,
	})
	if err != nil {
		if resp != nil {
			body := ""
			if resp.Body != nil {
				data, _ := io.ReadAll(io.LimitReader(resp.Body, maxErrorBytes))
				_ = resp.Body.Close()
				body = strings.TrimSpace(string(data))
			}
			return nil, &HandshakeStatusError{StatusCode: resp.StatusCode, Status: resp.Status, Body: body}
		}
		return nil, err
	}
	conn.SetReadLimit(maxFrameBytes)
	client := &Client{conn: conn, sessionID: sessionID}
	client.rememberSize(Size{Cols: options.Cols, Rows: options.Rows})
	closeWithError := func(err error) (*Client, error) {
		_ = conn.Close(websocket.StatusInternalError, "terminal setup failed")
		return nil, err
	}
	if err := client.write(ctx, frame{messageType: messageHello}); err != nil {
		return closeWithError(err)
	}
	if err := client.write(ctx, frame{
		messageType: messageSubscribe,
		sessionID:   sessionID,
		payload:     subscribePayload(options.Cols, options.Rows),
	}); err != nil {
		return closeWithError(err)
	}
	for {
		current, err := client.read(ctx)
		if err != nil {
			return closeWithError(err)
		}
		if current.sessionID != "" && current.sessionID != sessionID {
			continue
		}
		switch current.messageType {
		case messageWelcome:
			continue
		case messageError, messageControlRevoked:
			return closeWithError(frameError(current, "terminal subscription failed"))
		case messageEvent:
			var event eventPayload
			if err := json.Unmarshal(current.payload, &event); err != nil {
				return closeWithError(fmt.Errorf("decode terminal event: %w", err))
			}
			if event.Type == "subscribed" {
				client.canInput.Store(event.CanInput)
				return client, nil
			}
			if event.Type == "closed" {
				return closeWithError(errors.New("terminal closed during subscription"))
			}
		}
	}
}

func (c *Client) Close() error {
	return c.conn.Close(websocket.StatusNormalClosure, "")
}

func (c *Client) SendInput(ctx context.Context, payload []byte) error {
	if len(payload) == 0 {
		return nil
	}
	if !c.canInput.Load() {
		return errors.New("terminal control has not been granted")
	}
	return c.write(ctx, frame{
		messageType: messageInput,
		sessionID:   c.sessionID,
		payload:     payload,
	})
}

func (c *Client) SendInputConfirmed(ctx context.Context, payload []byte) error {
	if err := c.SendInput(ctx, payload); err != nil {
		return err
	}
	for {
		current, err := c.read(ctx)
		if err != nil {
			return err
		}
		if current.sessionID != "" && current.sessionID != c.sessionID {
			continue
		}
		switch current.messageType {
		case messageOutput:
			if err := c.write(ctx, frame{
				messageType: messageAck,
				sessionID:   c.sessionID,
				payload:     ackPayload(uint32(len(current.payload))),
			}); err != nil {
				return err
			}
		case messageError, messageControlRevoked:
			c.canInput.Store(false)
			return frameError(current, "terminal input rejected")
		case messageControlGranted:
			c.canInput.Store(true)
		case messageEvent:
			var event eventPayload
			if err := json.Unmarshal(current.payload, &event); err != nil {
				return fmt.Errorf("decode terminal event: %w", err)
			}
			switch event.Type {
			case "input-accepted":
				return nil
			case "closed":
				return errors.New("terminal closed before accepting input")
			}
		}
	}
}

func (c *Client) Resize(ctx context.Context, size Size) error {
	if size.Cols == 0 || size.Rows == 0 {
		return nil
	}
	c.rememberSize(size)
	if !c.canInput.Load() {
		return nil
	}
	return c.write(ctx, frame{
		messageType: messageResize,
		sessionID:   c.sessionID,
		payload:     resizePayload(size),
	})
}

func (c *Client) Attach(ctx context.Context, terminal io.ReadWriter, resizes <-chan Size) error {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()

	var wg sync.WaitGroup
	canceler, cancelableRead := terminal.(readCanceler)
	cancelRead := func() {
		cancel()
		if cancelableRead {
			_ = canceler.CancelRead()
		}
	}

	errCh := make(chan error, 3)
	wg.Add(1)
	go func() {
		defer wg.Done()
		buffer := make([]byte, 32*1024)
		for {
			count, err := terminal.Read(buffer)
			if count > 0 && c.canInput.Load() {
				if writeErr := c.SendInput(ctx, buffer[:count]); writeErr != nil {
					errCh <- writeErr
					return
				}
			}
			if err != nil {
				if errors.Is(err, io.EOF) {
					errCh <- nil
				} else {
					errCh <- err
				}
				return
			}
		}
	}()
	wg.Add(1)
	go func() {
		defer wg.Done()
		for {
			select {
			case <-ctx.Done():
				return
			case size, ok := <-resizes:
				if !ok {
					resizes = nil
					continue
				}
				if err := c.Resize(ctx, size); err != nil {
					errCh <- err
					return
				}
			}
		}
	}()
	wg.Add(1)
	go func() {
		defer wg.Done()
		for {
			current, err := c.read(ctx)
			if err != nil {
				errCh <- err
				return
			}
			if current.sessionID != "" && current.sessionID != c.sessionID {
				continue
			}
			switch current.messageType {
			case messageOutput:
				if _, err := terminal.Write(current.payload); err != nil {
					errCh <- err
					return
				}
				if err := c.write(ctx, frame{
					messageType: messageAck,
					sessionID:   c.sessionID,
					payload:     ackPayload(uint32(len(current.payload))),
				}); err != nil {
					errCh <- err
					return
				}
			case messageError:
				errCh <- frameError(current, "terminal connection failed")
				return
			case messageControlRevoked:
				c.canInput.Store(false)
			case messageControlGranted:
				c.canInput.Store(true)
				if size := c.rememberedSize(); size.Cols > 0 && size.Rows > 0 {
					if err := c.write(ctx, frame{
						messageType: messageResize,
						sessionID:   c.sessionID,
						payload:     resizePayload(size),
					}); err != nil {
						errCh <- err
						return
					}
				}
			case messageEvent:
				var event eventPayload
				if json.Unmarshal(current.payload, &event) == nil && event.Type == "closed" {
					errCh <- nil
					return
				}
			}
		}
	}()

	err := <-errCh
	cancelRead()
	if cancelableRead {
		wg.Wait()
	}
	return normalizeCloseError(err)
}

func (c *Client) rememberSize(size Size) {
	c.lastSize.Store(uint64(size.Cols)<<32 | uint64(size.Rows))
}

func (c *Client) rememberedSize() Size {
	value := c.lastSize.Load()
	return Size{Cols: uint32(value >> 32), Rows: uint32(value)}
}

func (c *Client) write(ctx context.Context, current frame) error {
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	return c.conn.Write(ctx, websocket.MessageBinary, encodeFrame(current))
}

func (c *Client) read(ctx context.Context) (frame, error) {
	messageType, payload, err := c.conn.Read(ctx)
	if err != nil {
		return frame{}, normalizeCloseError(err)
	}
	if messageType != websocket.MessageBinary {
		return frame{}, errors.New("terminal server sent a non-binary frame")
	}
	return decodeFrame(payload)
}

func encodeFrame(current frame) []byte {
	sessionID := []byte(current.sessionID)
	payload := make([]byte, 12+len(sessionID)+len(current.payload))
	binary.LittleEndian.PutUint16(payload[0:2], magic)
	payload[2] = version
	payload[3] = current.messageType
	binary.LittleEndian.PutUint32(payload[4:8], uint32(len(sessionID)))
	copy(payload[8:], sessionID)
	offset := 8 + len(sessionID)
	binary.LittleEndian.PutUint32(payload[offset:offset+4], uint32(len(current.payload)))
	copy(payload[offset+4:], current.payload)
	return payload
}

func decodeFrame(payload []byte) (frame, error) {
	if len(payload) < 12 || binary.LittleEndian.Uint16(payload[0:2]) != magic {
		return frame{}, errors.New("invalid terminal frame")
	}
	if payload[2] != version {
		return frame{}, fmt.Errorf("unsupported terminal protocol version %d", payload[2])
	}
	sessionLength := uint64(binary.LittleEndian.Uint32(payload[4:8]))
	if sessionLength > uint64(len(payload)-12) {
		return frame{}, errors.New("invalid terminal session id length")
	}
	payloadLengthOffset := 8 + int(sessionLength)
	bodyLength := uint64(binary.LittleEndian.Uint32(payload[payloadLengthOffset : payloadLengthOffset+4]))
	bodyOffset := payloadLengthOffset + 4
	if bodyLength != uint64(len(payload)-bodyOffset) {
		return frame{}, errors.New("invalid terminal payload length")
	}
	return frame{
		messageType: payload[3],
		sessionID:   string(payload[8:payloadLengthOffset]),
		payload:     payload[bodyOffset:],
	}, nil
}

func subscribePayload(cols uint32, rows uint32) []byte {
	payload := make([]byte, 20)
	binary.LittleEndian.PutUint32(
		payload[0:4],
		subscribeOutput|subscribeEvents|subscribeOutputAcknowledgements,
	)
	binary.LittleEndian.PutUint32(payload[12:16], cols)
	binary.LittleEndian.PutUint32(payload[16:20], rows)
	return payload
}

func resizePayload(size Size) []byte {
	payload := make([]byte, 8)
	binary.LittleEndian.PutUint32(payload[0:4], size.Cols)
	binary.LittleEndian.PutUint32(payload[4:8], size.Rows)
	return payload
}

func ackPayload(bytes uint32) []byte {
	payload := make([]byte, 4)
	binary.LittleEndian.PutUint32(payload, bytes)
	return payload
}

func frameError(current frame, fallback string) error {
	var event eventPayload
	if json.Unmarshal(current.payload, &event) == nil {
		if event.Error != "" {
			return errors.New(event.Error)
		}
		if event.Reason != "" {
			return errors.New(event.Reason)
		}
	}
	return errors.New(fallback)
}

func normalizeCloseError(err error) error {
	if err == nil {
		return nil
	}
	var closeError websocket.CloseError
	if errors.As(err, &closeError) &&
		(closeError.Code == websocket.StatusNormalClosure || closeError.Code == websocket.StatusGoingAway) {
		return nil
	}
	return err
}
