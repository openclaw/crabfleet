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
	"time"

	"github.com/coder/websocket"
)

const (
	magic         = 0x5943
	version       = 2
	maxFrameBytes = 16 * 1024 * 1024
	maxErrorBytes = 512

	defaultInputConfirmationTimeout  = 5 * time.Second
	defaultAttachmentShutdownTimeout = 250 * time.Millisecond

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
	conn                         *websocket.Conn
	sessionID                    string
	supportsInputAcknowledgement bool
	cancel                       context.CancelFunc
	readCancel                   context.CancelFunc
	canInput                     atomic.Bool
	lastSize                     atomic.Uint64
	writeMu                      sync.Mutex
	confirmOnce                  sync.Once
	confirmGate                  chan struct{}
	confirmationTimeout          time.Duration
	attachmentShutdownTimeout    time.Duration
	stateMu                      sync.Mutex
	inputWaiter                  chan error
	attachment                   *terminalAttachment
	attachmentReady              chan struct{}
	terminalErr                  error
	readerDone                   chan struct{}
	readerErr                    error
}

type frame struct {
	messageType byte
	sessionID   string
	payload     []byte
}

type terminalAttachment struct {
	frames chan attachmentDelivery
	done   chan struct{}
}

type attachmentDelivery struct {
	frame    frame
	accepted chan bool
}

type eventPayload struct {
	Type     string `json:"type"`
	Error    string `json:"error"`
	Reason   string `json:"reason"`
	CanInput bool   `json:"canInput"`
}

type welcomePayload struct {
	InputAcknowledgements bool `json:"inputAcknowledgements"`
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
	httpClient := options.HTTPClient
	var setupCancel context.CancelFunc
	var setupTimer *time.Timer
	var setupFinished atomic.Bool
	if options.HTTPClient != nil && options.HTTPClient.Timeout > 0 {
		cloned := *options.HTTPClient
		cloned.Timeout = 0
		httpClient = &cloned
		ctx, setupCancel = context.WithCancel(ctx)
		setupTimer = time.AfterFunc(options.HTTPClient.Timeout, func() {
			if setupFinished.CompareAndSwap(false, true) {
				setupCancel()
			}
		})
	}
	conn, resp, err := websocket.Dial(ctx, endpoint, &websocket.DialOptions{
		HTTPClient: httpClient,
		HTTPHeader: options.Header,
	})
	if err != nil {
		setupFinished.Store(true)
		if setupTimer != nil {
			setupTimer.Stop()
		}
		if setupCancel != nil {
			setupCancel()
		}
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
	client := &Client{
		conn:                conn,
		sessionID:           sessionID,
		cancel:              setupCancel,
		confirmationTimeout: defaultInputConfirmationTimeout,
	}
	client.rememberSize(Size{Cols: options.Cols, Rows: options.Rows})
	closeWithError := func(err error) (*Client, error) {
		setupFinished.Store(true)
		if setupTimer != nil {
			setupTimer.Stop()
		}
		if setupCancel != nil {
			setupCancel()
		}
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
			var welcome welcomePayload
			if json.Unmarshal(current.payload, &welcome) == nil {
				client.supportsInputAcknowledgement = welcome.InputAcknowledgements
			}
			continue
		case messageError, messageControlRevoked:
			return closeWithError(frameError(current, "terminal subscription failed"))
		case messageEvent:
			var event eventPayload
			if err := json.Unmarshal(current.payload, &event); err != nil {
				return closeWithError(fmt.Errorf("decode terminal event: %w", err))
			}
			if event.Type == "subscribed" {
				if setupTimer != nil && !setupFinished.CompareAndSwap(false, true) {
					return closeWithError(errors.New("terminal subscription timed out"))
				}
				client.canInput.Store(event.CanInput)
				if setupTimer != nil {
					setupTimer.Stop()
				}
				client.startReader()
				return client, nil
			}
			if event.Type == "closed" {
				return closeWithError(errors.New("terminal closed during subscription"))
			}
		}
	}
}

func (c *Client) Close() error {
	if c.readCancel != nil {
		c.readCancel()
	}
	err := c.conn.Close(websocket.StatusNormalClosure, "")
	if c.cancel != nil {
		c.cancel()
	}
	return err
}

func (c *Client) SendInput(ctx context.Context, payload []byte) error {
	if len(payload) == 0 {
		return nil
	}
	if !c.canInput.Load() {
		return errors.New("terminal control has not been granted")
	}
	if !c.supportsInputAcknowledgement {
		return c.writeInput(ctx, payload)
	}
	if err := c.acquireConfirmation(ctx); err != nil {
		return err
	}

	waiter := make(chan error, 1)
	if err := c.registerInputWaiter(waiter); err != nil {
		c.releaseConfirmation()
		return err
	}
	if err := c.writeInput(ctx, payload); err != nil {
		c.clearInputWaiter(waiter)
		c.releaseConfirmation()
		return err
	}
	go c.drainInputConfirmation(waiter)
	return nil
}

func (c *Client) writeInput(ctx context.Context, payload []byte) error {
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
	if len(payload) == 0 {
		return nil
	}
	if !c.supportsInputAcknowledgement {
		return c.SendInput(ctx, payload)
	}
	if err := c.acquireConfirmation(ctx); err != nil {
		return err
	}
	defer c.releaseConfirmation()

	waiter := make(chan error, 1)
	if err := c.registerInputWaiter(waiter); err != nil {
		return err
	}
	if err := c.writeInput(ctx, payload); err != nil {
		c.clearInputWaiter(waiter)
		return err
	}
	return c.waitForInputConfirmation(ctx, waiter)
}

func (c *Client) drainInputConfirmation(waiter chan error) {
	defer c.releaseConfirmation()
	ctx, cancel := context.WithTimeout(context.Background(), c.inputConfirmationTimeout())
	defer cancel()
	_ = c.waitForInputConfirmation(ctx, waiter)
}

func (c *Client) waitForInputConfirmation(ctx context.Context, waiter chan error) error {
	select {
	case err := <-waiter:
		return err
	case <-c.readerDone:
		select {
		case err := <-waiter:
			return err
		default:
		}
		c.clearInputWaiter(waiter)
		return readerUnavailableError(c.readerError())
	case <-ctx.Done():
		c.clearInputWaiter(waiter)
		_ = c.Close()
		return ctx.Err()
	}
}

func (c *Client) acquireConfirmation(ctx context.Context) error {
	c.confirmOnce.Do(func() {
		c.confirmGate = make(chan struct{}, 1)
	})
	select {
	case c.confirmGate <- struct{}{}:
		if err := ctx.Err(); err != nil {
			<-c.confirmGate
			return err
		}
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (c *Client) releaseConfirmation() {
	<-c.confirmGate
}

func (c *Client) inputConfirmationTimeout() time.Duration {
	if c.confirmationTimeout > 0 {
		return c.confirmationTimeout
	}
	return defaultInputConfirmationTimeout
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

	attachment, err := c.registerAttachment()
	if err != nil {
		return err
	}
	defer c.clearAttachment(attachment)

	var wg sync.WaitGroup
	canceler, cancelableRead := terminal.(readCanceler)
	cancelRead := func() {
		cancel()
		if cancelableRead {
			_ = canceler.CancelRead()
		}
	}

	errCh := make(chan error, 3)
	frameConsumerDone := make(chan struct{})
	wg.Add(1)
	go func() {
		defer wg.Done()
		buffer := make([]byte, 32*1024)
		for {
			count, err := terminal.Read(buffer)
			if count > 0 && c.canInput.Load() {
				confirmationCtx, confirmationCancel := context.WithTimeout(
					ctx,
					c.inputConfirmationTimeout(),
				)
				writeErr := c.SendInputConfirmed(confirmationCtx, buffer[:count])
				confirmationCancel()
				if writeErr != nil {
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
		defer close(frameConsumerDone)
		for {
			select {
			case <-ctx.Done():
				return
			case <-c.readerDone:
				errCh <- c.readerError()
				return
			case delivery := <-attachment.frames:
				if !c.acceptAttachmentDelivery(attachment, delivery) {
					return
				}
				current := delivery.frame
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
				case messageControlGranted:
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
		}
	}()

	select {
	case err = <-errCh:
	case <-ctx.Done():
		err = ctx.Err()
	}
	cancelRead()
	// Let completed writes preserve their acknowledgement ordering, but retire the
	// attachment if its owner must close the terminal to unblock a write.
	shutdownTimer := time.NewTimer(c.frameConsumerShutdownTimeout())
	frameConsumerStopped := false
	select {
	case <-frameConsumerDone:
		frameConsumerStopped = true
		if !shutdownTimer.Stop() {
			<-shutdownTimer.C
		}
	case <-shutdownTimer.C:
	}
	if cancelableRead && frameConsumerStopped {
		wg.Wait()
	}
	return normalizeCloseError(err)
}

func (c *Client) frameConsumerShutdownTimeout() time.Duration {
	if c.attachmentShutdownTimeout > 0 {
		return c.attachmentShutdownTimeout
	}
	return defaultAttachmentShutdownTimeout
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

func (c *Client) startReader() {
	ctx, cancel := context.WithCancel(context.Background())
	c.readCancel = cancel
	c.stateMu.Lock()
	c.readerDone = make(chan struct{})
	c.attachmentReady = make(chan struct{})
	c.stateMu.Unlock()
	go c.readLoop(ctx)
}

func (c *Client) readLoop(ctx context.Context) {
	for {
		current, err := c.read(ctx)
		if err != nil {
			c.finishReader(err)
			return
		}
		if err := c.handleFrame(ctx, current); err != nil {
			c.finishReader(err)
			return
		}
	}
}

func (c *Client) handleFrame(ctx context.Context, current frame) error {
	if current.sessionID != "" && current.sessionID != c.sessionID {
		return nil
	}
	switch current.messageType {
	case messageOutput:
		return c.deliverOrQueueOutput(ctx, current)
	case messageError:
		err := frameError(current, "terminal connection failed")
		c.canInput.Store(false)
		c.completeInput(err)
		return err
	case messageControlRevoked:
		c.canInput.Store(false)
		c.completeInput(frameError(current, "terminal input rejected"))
		c.deliverAttachment(ctx, current)
	case messageControlGranted:
		c.canInput.Store(true)
		c.deliverAttachment(ctx, current)
	case messageEvent:
		var event eventPayload
		if err := json.Unmarshal(current.payload, &event); err != nil {
			return fmt.Errorf("decode terminal event: %w", err)
		}
		switch event.Type {
		case "subscribed":
			c.canInput.Store(event.CanInput)
		case "input-accepted":
			c.completeInput(nil)
		case "input-rejected":
			c.completeInput(frameError(current, "terminal input rejected"))
		case "closed":
			c.canInput.Store(false)
			c.markTerminalClosed(errors.New("terminal closed"))
			c.completeInput(errors.New("terminal closed before accepting input"))
			c.deliverAttachment(ctx, current)
		default:
			c.deliverAttachment(ctx, current)
		}
	default:
		c.deliverAttachment(ctx, current)
	}
	return nil
}

func (c *Client) registerInputWaiter(waiter chan error) error {
	c.stateMu.Lock()
	defer c.stateMu.Unlock()
	select {
	case <-c.readerDone:
		return readerUnavailableError(c.readerErr)
	default:
	}
	if c.terminalErr != nil {
		return c.terminalErr
	}
	c.inputWaiter = waiter
	if c.attachment == nil && c.attachmentReady != nil {
		close(c.attachmentReady)
		c.attachmentReady = make(chan struct{})
	}
	return nil
}

func (c *Client) clearInputWaiter(waiter chan error) {
	c.stateMu.Lock()
	defer c.stateMu.Unlock()
	if c.inputWaiter == waiter {
		c.inputWaiter = nil
	}
}

func (c *Client) completeInput(err error) {
	c.stateMu.Lock()
	waiter := c.inputWaiter
	c.inputWaiter = nil
	c.stateMu.Unlock()
	if waiter != nil {
		waiter <- err
	}
}

func (c *Client) registerAttachment() (*terminalAttachment, error) {
	c.stateMu.Lock()
	defer c.stateMu.Unlock()
	if c.attachment != nil {
		return nil, errors.New("terminal client is already attached")
	}
	if c.terminalErr != nil {
		return nil, c.terminalErr
	}
	select {
	case <-c.readerDone:
		return nil, readerUnavailableError(c.readerErr)
	default:
	}
	attachment := &terminalAttachment{
		frames: make(chan attachmentDelivery),
		done:   make(chan struct{}),
	}
	c.attachment = attachment
	if c.attachmentReady != nil {
		close(c.attachmentReady)
		c.attachmentReady = nil
	}
	return attachment, nil
}

func (c *Client) clearAttachment(attachment *terminalAttachment) {
	c.stateMu.Lock()
	if c.attachment == attachment {
		c.attachment = nil
		close(attachment.done)
		select {
		case <-c.readerDone:
		default:
			c.attachmentReady = make(chan struct{})
		}
	}
	c.stateMu.Unlock()
}

func (c *Client) markTerminalClosed(err error) {
	c.stateMu.Lock()
	if c.terminalErr == nil {
		c.terminalErr = err
	}
	c.stateMu.Unlock()
}

func (c *Client) deliverOrQueueOutput(ctx context.Context, current frame) error {
	for {
		c.stateMu.Lock()
		attachment := c.attachment
		ready := c.attachmentReady
		discardOutput := c.inputWaiter != nil
		c.stateMu.Unlock()
		if attachment == nil {
			if discardOutput {
				return c.write(ctx, frame{
					messageType: messageAck,
					sessionID:   c.sessionID,
					payload:     ackPayload(uint32(len(current.payload))),
				})
			}
			if ready == nil {
				return nil
			}
			select {
			case <-ready:
				continue
			case <-ctx.Done():
				return ctx.Err()
			}
		}
		if c.deliverToAttachment(ctx, attachment, current) {
			return nil
		}
		if err := ctx.Err(); err != nil {
			return ctx.Err()
		}
	}
}

func (c *Client) deliverAttachment(ctx context.Context, current frame) bool {
	c.stateMu.Lock()
	attachment := c.attachment
	c.stateMu.Unlock()
	if attachment == nil {
		return false
	}
	return c.deliverToAttachment(ctx, attachment, current)
}

func (c *Client) deliverToAttachment(
	ctx context.Context,
	attachment *terminalAttachment,
	current frame,
) bool {
	delivery := attachmentDelivery{
		frame:    current,
		accepted: make(chan bool, 1),
	}
	select {
	case attachment.frames <- delivery:
	case <-attachment.done:
		return false
	case <-ctx.Done():
		return false
	}
	select {
	case accepted := <-delivery.accepted:
		return accepted
	case <-ctx.Done():
		return false
	}
}

func (c *Client) acceptAttachmentDelivery(
	attachment *terminalAttachment,
	delivery attachmentDelivery,
) bool {
	c.stateMu.Lock()
	accepted := c.attachment == attachment
	c.stateMu.Unlock()
	delivery.accepted <- accepted
	return accepted
}

func (c *Client) finishReader(err error) {
	c.stateMu.Lock()
	c.readerErr = normalizeCloseError(err)
	waiter := c.inputWaiter
	c.inputWaiter = nil
	if waiter != nil {
		waiter <- readerUnavailableError(c.readerErr)
	}
	close(c.readerDone)
	c.stateMu.Unlock()
}

func (c *Client) readerError() error {
	c.stateMu.Lock()
	defer c.stateMu.Unlock()
	return c.readerErr
}

func readerUnavailableError(err error) error {
	if err != nil {
		return err
	}
	return errors.New("terminal connection closed")
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
