package terminalws

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
)

type protocolFixture struct {
	Magic          uint16            `json:"magic"`
	Version        byte              `json:"version"`
	Messages       map[string]byte   `json:"messages"`
	SubscribeFlags map[string]uint32 `json:"subscribeFlags"`
	Vectors        struct {
		OutputFrame string `json:"outputFrame"`
		PingFrame   string `json:"pingFrame"`
		Subscribe   string `json:"subscribe"`
		Resize      string `json:"resize"`
		Ack         string `json:"ack"`
	} `json:"vectors"`
}

func TestGoTerminalConstantsAndEncodersMatchSharedV2Protocol(t *testing.T) {
	data, err := os.ReadFile("../../protocol/terminal-v2.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture protocolFixture
	if err := json.Unmarshal(data, &fixture); err != nil {
		t.Fatal(err)
	}
	if magic != fixture.Magic || version != fixture.Version {
		t.Fatalf("protocol identity = %#x/%d", magic, version)
	}
	messages := map[string]byte{
		"Hello":           messageHello,
		"Welcome":         messageWelcome,
		"Subscribe":       messageSubscribe,
		"Unsubscribe":     messageUnsubscribe,
		"Output":          messageOutput,
		"Snapshot":        messageSnapshot,
		"Event":           messageEvent,
		"Error":           messageError,
		"Input":           messageInput,
		"Key":             messageKey,
		"Resize":          messageResize,
		"Stop":            messageStop,
		"ControlRequest":  messageControlRequest,
		"ControlDecision": messageControlDecision,
		"ControlGranted":  messageControlGranted,
		"ControlRevoked":  messageControlRevoked,
		"Ping":            messagePing,
		"Pong":            messagePong,
		"Ack":             messageAck,
	}
	if !mapsEqual(messages, fixture.Messages) {
		t.Fatalf("messages = %#v", messages)
	}
	flags := map[string]uint32{
		"Output":                 subscribeOutput,
		"Snapshot":               subscribeSnapshot,
		"Events":                 subscribeEvents,
		"OutputAcknowledgements": subscribeOutputAcknowledgements,
	}
	if !mapsEqual(flags, fixture.SubscribeFlags) {
		t.Fatalf("subscribe flags = %#v", flags)
	}
	output := encodeFrame(frame{
		messageType: messageOutput,
		sessionID:   "IS-123",
		payload:     []byte{0, 1, 2, 255},
	})
	if got := hex.EncodeToString(output); got != fixture.Vectors.OutputFrame {
		t.Fatalf("output frame = %q", got)
	}
	if got := hex.EncodeToString(encodeFrame(frame{messageType: messagePing})); got != fixture.Vectors.PingFrame {
		t.Fatalf("ping frame = %q", got)
	}
	if got := hex.EncodeToString(subscribePayload(144, 41)); got != fixture.Vectors.Subscribe {
		t.Fatalf("subscribe payload = %q", got)
	}
	if got := hex.EncodeToString(resizePayload(Size{Cols: 132, Rows: 43})); got != fixture.Vectors.Resize {
		t.Fatalf("resize payload = %q", got)
	}
	if got := hex.EncodeToString(ackPayload(65_535)); got != fixture.Vectors.Ack {
		t.Fatalf("ack payload = %q", got)
	}
}

func mapsEqual[K comparable, V comparable](left map[K]V, right map[K]V) bool {
	if len(left) != len(right) {
		return false
	}
	for key, value := range left {
		if right[key] != value {
			return false
		}
	}
	return true
}

func TestEndpointUsesTerminalHub(t *testing.T) {
	got, err := Endpoint("https://fleet.example/base?ignored=1")
	if err != nil {
		t.Fatal(err)
	}
	if got != "wss://fleet.example/api/terminal/ws" {
		t.Fatalf("endpoint = %q", got)
	}
}

func TestClientSubscribesSendsInputAndAcknowledgesOutput(t *testing.T) {
	receivedInput := make(chan []byte, 1)
	acknowledged := make(chan uint32, 1)
	receivedResize := make(chan Size, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/terminal/ws" {
			t.Errorf("path = %q", r.URL.Path)
		}
		if r.Header.Get("Authorization") != "Bearer token" {
			t.Errorf("authorization = %q", r.Header.Get("Authorization"))
		}
		conn, err := websocket.Accept(w, r, nil)
		if err != nil {
			t.Error(err)
			return
		}
		defer conn.Close(websocket.StatusNormalClosure, "")

		_, helloPayload, err := conn.Read(r.Context())
		if err != nil {
			t.Error(err)
			return
		}
		hello, err := decodeFrame(helloPayload)
		if err != nil {
			t.Error(err)
			return
		}
		if hello.messageType != messageHello {
			t.Errorf("hello type = %d", hello.messageType)
		}

		_, subscribePayload, err := conn.Read(r.Context())
		if err != nil {
			t.Error(err)
			return
		}
		subscribe, err := decodeFrame(subscribePayload)
		if err != nil {
			t.Error(err)
			return
		}
		if subscribe.messageType != messageSubscribe || subscribe.sessionID != "IS-1" {
			t.Errorf("subscribe = %#v", subscribe)
		}
		flags := binary.LittleEndian.Uint32(subscribe.payload[0:4])
		if flags&subscribeOutputAcknowledgements == 0 {
			t.Errorf("subscribe flags = %d", flags)
		}

		event, _ := json.Marshal(eventPayload{Type: "subscribed", CanInput: true})
		if err := conn.Write(r.Context(), websocket.MessageBinary, encodeFrame(frame{
			messageType: messageEvent,
			sessionID:   "IS-1",
			payload:     event,
		})); err != nil {
			t.Error(err)
			return
		}

		for range 2 {
			_, payload, err := conn.Read(r.Context())
			if err != nil {
				t.Error(err)
				return
			}
			current, err := decodeFrame(payload)
			if err != nil {
				t.Error(err)
				return
			}
			switch current.messageType {
			case messageInput:
				receivedInput <- append([]byte(nil), current.payload...)
			case messageResize:
				receivedResize <- Size{
					Cols: binary.LittleEndian.Uint32(current.payload[0:4]),
					Rows: binary.LittleEndian.Uint32(current.payload[4:8]),
				}
			default:
				t.Errorf("unexpected message type = %d", current.messageType)
				return
			}
		}

		if err := conn.Write(r.Context(), websocket.MessageBinary, encodeFrame(frame{
			messageType: messageOutput,
			sessionID:   "IS-1",
			payload:     []byte("ready\n"),
		})); err != nil {
			t.Error(err)
			return
		}
		_, ackPayload, err := conn.Read(r.Context())
		if err != nil {
			t.Error(err)
			return
		}
		ack, err := decodeFrame(ackPayload)
		if err != nil {
			t.Error(err)
			return
		}
		acknowledged <- binary.LittleEndian.Uint32(ack.payload)
		closed, _ := json.Marshal(eventPayload{Type: "closed"})
		_ = conn.Write(r.Context(), websocket.MessageBinary, encodeFrame(frame{
			messageType: messageEvent,
			sessionID:   "IS-1",
			payload:     closed,
		}))
	}))
	defer server.Close()

	endpoint, err := Endpoint(server.URL)
	if err != nil {
		t.Fatal(err)
	}
	headers := http.Header{"Authorization": []string{"Bearer token"}}
	client, err := Dial(context.Background(), endpoint, "IS-1", Options{
		Header: headers,
		Cols:   120,
		Rows:   34,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()

	inputReader, inputWriter := io.Pipe()
	defer inputReader.Close()
	defer inputWriter.Close()
	terminal := &readWriter{reader: inputReader, closer: inputReader}
	go func() {
		_, _ = inputWriter.Write([]byte("hello\n"))
	}()
	resizes := make(chan Size, 1)
	resizes <- Size{Cols: 132, Rows: 43}
	if err := client.Attach(context.Background(), terminal, resizes); err != nil {
		t.Fatal(err)
	}
	if input := <-receivedInput; string(input) != "hello\n" {
		t.Fatalf("input = %q", input)
	}
	if terminal.String() != "ready\n" {
		t.Fatalf("output = %q", terminal.String())
	}
	if size := <-receivedResize; size != (Size{Cols: 132, Rows: 43}) {
		t.Fatalf("resize = %#v", size)
	}
	if bytes := <-acknowledged; bytes != uint32(len("ready\n")) {
		t.Fatalf("acknowledged = %d", bytes)
	}
}

func TestClientDefersOutputAcknowledgementUntilAttach(t *testing.T) {
	acknowledged := make(chan uint32, 1)
	outputSent := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := websocket.Accept(w, r, nil)
		if err != nil {
			t.Error(err)
			return
		}
		defer conn.Close(websocket.StatusNormalClosure, "")
		for range 2 {
			if _, _, err := conn.Read(r.Context()); err != nil {
				t.Error(err)
				return
			}
		}
		subscribed, _ := json.Marshal(eventPayload{Type: "subscribed", CanInput: false})
		if err := conn.Write(r.Context(), websocket.MessageBinary, encodeFrame(frame{
			messageType: messageEvent,
			sessionID:   "IS-before-attach",
			payload:     subscribed,
		})); err != nil {
			t.Error(err)
			return
		}
		if err := conn.Write(r.Context(), websocket.MessageBinary, encodeFrame(frame{
			messageType: messageOutput,
			sessionID:   "IS-before-attach",
			payload:     []byte("early output\n"),
		})); err != nil {
			t.Error(err)
			return
		}
		close(outputSent)
		_, payload, err := conn.Read(r.Context())
		if err != nil {
			t.Error(err)
			return
		}
		ack, err := decodeFrame(payload)
		if err != nil || ack.messageType != messageAck {
			t.Errorf("output acknowledgement = %#v, %v", ack, err)
			return
		}
		acknowledged <- binary.LittleEndian.Uint32(ack.payload)
		closed, _ := json.Marshal(eventPayload{Type: "closed"})
		_ = conn.Write(r.Context(), websocket.MessageBinary, encodeFrame(frame{
			messageType: messageEvent,
			sessionID:   "IS-before-attach",
			payload:     closed,
		}))
	}))
	defer server.Close()

	endpoint, err := Endpoint(server.URL)
	if err != nil {
		t.Fatal(err)
	}
	client, err := Dial(context.Background(), endpoint, "IS-before-attach", Options{})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	<-outputSent
	waitForPendingAttachmentFrames(t, client, 1)
	select {
	case bytes := <-acknowledged:
		t.Fatalf("acknowledged %d bytes before attach", bytes)
	default:
	}

	terminal := newBlockingTerminal()
	if err := client.Attach(context.Background(), terminal, nil); err != nil {
		t.Fatal(err)
	}
	if terminal.String() != "early output\n" {
		t.Fatalf("output = %q", terminal.String())
	}
	if bytes := <-acknowledged; bytes != uint32(len("early output\n")) {
		t.Fatalf("acknowledged = %d", bytes)
	}
}

func TestSendInputConfirmedReturnsControlRevocation(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := websocket.Accept(w, r, nil)
		if err != nil {
			t.Error(err)
			return
		}
		defer conn.Close(websocket.StatusNormalClosure, "")
		for range 2 {
			if _, _, err := conn.Read(r.Context()); err != nil {
				t.Error(err)
				return
			}
		}
		welcome, _ := json.Marshal(welcomePayload{InputAcknowledgements: true})
		if err := conn.Write(r.Context(), websocket.MessageBinary, encodeFrame(frame{
			messageType: messageWelcome,
			payload:     welcome,
		})); err != nil {
			t.Error(err)
			return
		}
		subscribed, _ := json.Marshal(eventPayload{Type: "subscribed", CanInput: true})
		if err := conn.Write(r.Context(), websocket.MessageBinary, encodeFrame(frame{
			messageType: messageEvent,
			sessionID:   "IS-revoked",
			payload:     subscribed,
		})); err != nil {
			t.Error(err)
			return
		}
		if _, _, err := conn.Read(r.Context()); err != nil {
			t.Error(err)
			return
		}
		revoked, _ := json.Marshal(eventPayload{Error: "terminal control revoked"})
		_ = conn.Write(r.Context(), websocket.MessageBinary, encodeFrame(frame{
			messageType: messageControlRevoked,
			sessionID:   "IS-revoked",
			payload:     revoked,
		}))
	}))
	defer server.Close()

	endpoint, err := Endpoint(server.URL)
	if err != nil {
		t.Fatal(err)
	}
	client, err := Dial(context.Background(), endpoint, "IS-revoked", Options{})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	err = client.SendInputConfirmed(context.Background(), []byte("blocked\n"))
	if err == nil || !strings.Contains(err.Error(), "control revoked") {
		t.Fatalf("error = %v", err)
	}
}

func TestSendInputConfirmedRejectionDoesNotRevokeControl(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := websocket.Accept(w, r, nil)
		if err != nil {
			t.Error(err)
			return
		}
		defer conn.Close(websocket.StatusNormalClosure, "")
		for range 2 {
			if _, _, err := conn.Read(r.Context()); err != nil {
				t.Error(err)
				return
			}
		}
		welcome, _ := json.Marshal(welcomePayload{InputAcknowledgements: true})
		if err := conn.Write(r.Context(), websocket.MessageBinary, encodeFrame(frame{
			messageType: messageWelcome,
			payload:     welcome,
		})); err != nil {
			t.Error(err)
			return
		}
		subscribed, _ := json.Marshal(eventPayload{Type: "subscribed", CanInput: true})
		if err := conn.Write(r.Context(), websocket.MessageBinary, encodeFrame(frame{
			messageType: messageEvent,
			sessionID:   "IS-request-scoped",
			payload:     subscribed,
		})); err != nil {
			t.Error(err)
			return
		}

		for index := range 2 {
			_, payload, err := conn.Read(r.Context())
			if err != nil {
				t.Error(err)
				return
			}
			current, err := decodeFrame(payload)
			if err != nil {
				t.Error(err)
				return
			}
			if current.messageType != messageInput {
				t.Errorf("message type = %d", current.messageType)
				return
			}
			event := eventPayload{Type: "input-accepted"}
			if index == 0 {
				event = eventPayload{
					Type:  "input-rejected",
					Error: "runner rejected terminal input",
				}
			}
			encoded, _ := json.Marshal(event)
			if err := conn.Write(r.Context(), websocket.MessageBinary, encodeFrame(frame{
				messageType: messageEvent,
				sessionID:   "IS-request-scoped",
				payload:     encoded,
			})); err != nil {
				t.Error(err)
				return
			}
		}
	}))
	defer server.Close()

	endpoint, err := Endpoint(server.URL)
	if err != nil {
		t.Fatal(err)
	}
	client, err := Dial(context.Background(), endpoint, "IS-request-scoped", Options{})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()

	err = client.SendInputConfirmed(context.Background(), []byte("rejected\n"))
	if err == nil || !strings.Contains(err.Error(), "runner rejected terminal input") {
		t.Fatalf("error = %v", err)
	}
	if !client.canInput.Load() {
		t.Fatal("request-scoped rejection revoked terminal control")
	}
	if err := client.SendInputConfirmed(context.Background(), []byte("accepted\n")); err != nil {
		t.Fatal(err)
	}
}

func TestSendInputConfirmedSharesOneReaderWithAttach(t *testing.T) {
	firstInput := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := websocket.Accept(w, r, nil)
		if err != nil {
			t.Error(err)
			return
		}
		defer conn.Close(websocket.StatusNormalClosure, "")
		for range 2 {
			if _, _, err := conn.Read(r.Context()); err != nil {
				t.Error(err)
				return
			}
		}
		welcome, _ := json.Marshal(welcomePayload{InputAcknowledgements: true})
		if err := conn.Write(r.Context(), websocket.MessageBinary, encodeFrame(frame{
			messageType: messageWelcome,
			payload:     welcome,
		})); err != nil {
			t.Error(err)
			return
		}
		subscribed, _ := json.Marshal(eventPayload{Type: "subscribed", CanInput: true})
		if err := conn.Write(r.Context(), websocket.MessageBinary, encodeFrame(frame{
			messageType: messageEvent,
			sessionID:   "IS-concurrent",
			payload:     subscribed,
		})); err != nil {
			t.Error(err)
			return
		}

		accepted, _ := json.Marshal(eventPayload{Type: "input-accepted"})
		for index := range 2 {
			_, payload, err := conn.Read(r.Context())
			if err != nil {
				t.Error(err)
				return
			}
			current, err := decodeFrame(payload)
			if err != nil {
				t.Error(err)
				return
			}
			if current.messageType != messageInput {
				t.Errorf("message type = %d", current.messageType)
				return
			}
			if index == 0 {
				close(firstInput)
				if err := conn.Write(r.Context(), websocket.MessageBinary, encodeFrame(frame{
					messageType: messageOutput,
					sessionID:   "IS-concurrent",
					payload:     []byte("attached\n"),
				})); err != nil {
					t.Error(err)
					return
				}
				_, acknowledgement, err := conn.Read(r.Context())
				if err != nil {
					t.Error(err)
					return
				}
				ack, err := decodeFrame(acknowledgement)
				if err != nil || ack.messageType != messageAck {
					t.Errorf("output acknowledgement = %#v, %v", ack, err)
					return
				}
			}
			if err := conn.Write(r.Context(), websocket.MessageBinary, encodeFrame(frame{
				messageType: messageEvent,
				sessionID:   "IS-concurrent",
				payload:     accepted,
			})); err != nil {
				t.Error(err)
				return
			}
		}
		closed, _ := json.Marshal(eventPayload{Type: "closed"})
		_ = conn.Write(r.Context(), websocket.MessageBinary, encodeFrame(frame{
			messageType: messageEvent,
			sessionID:   "IS-concurrent",
			payload:     closed,
		}))
	}))
	defer server.Close()

	endpoint, err := Endpoint(server.URL)
	if err != nil {
		t.Fatal(err)
	}
	client, err := Dial(context.Background(), endpoint, "IS-concurrent", Options{})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()

	terminal := newBlockingTerminal()
	attachDone := make(chan error, 1)
	go func() {
		attachDone <- client.Attach(context.Background(), terminal, nil)
	}()
	<-terminal.started

	sendDone := make(chan error, 2)
	go func() {
		sendDone <- client.SendInputConfirmed(context.Background(), []byte("first\n"))
	}()
	<-firstInput
	go func() {
		sendDone <- client.SendInputConfirmed(context.Background(), []byte("second\n"))
	}()
	for range 2 {
		if err := <-sendDone; err != nil {
			t.Fatal(err)
		}
	}
	if err := <-attachDone; err != nil {
		t.Fatal(err)
	}
	if terminal.String() != "attached\n" {
		t.Fatalf("output = %q", terminal.String())
	}
}

func TestSendInputConfirmedReturnsImmediatelyForEmptyInput(t *testing.T) {
	client := &Client{supportsInputAcknowledgement: true}
	if err := client.SendInputConfirmed(context.Background(), nil); err != nil {
		t.Fatal(err)
	}
}

func TestSendInputConfirmedFallsBackWithoutServerCapability(t *testing.T) {
	receivedInput := make(chan []byte, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := websocket.Accept(w, r, nil)
		if err != nil {
			t.Error(err)
			return
		}
		defer conn.Close(websocket.StatusNormalClosure, "")
		for range 2 {
			if _, _, err := conn.Read(r.Context()); err != nil {
				t.Error(err)
				return
			}
		}
		welcome, _ := json.Marshal(welcomePayload{})
		if err := conn.Write(r.Context(), websocket.MessageBinary, encodeFrame(frame{
			messageType: messageWelcome,
			payload:     welcome,
		})); err != nil {
			t.Error(err)
			return
		}
		subscribed, _ := json.Marshal(eventPayload{Type: "subscribed", CanInput: true})
		if err := conn.Write(r.Context(), websocket.MessageBinary, encodeFrame(frame{
			messageType: messageEvent,
			sessionID:   "IS-legacy",
			payload:     subscribed,
		})); err != nil {
			t.Error(err)
			return
		}
		_, payload, err := conn.Read(r.Context())
		if err != nil {
			t.Error(err)
			return
		}
		current, err := decodeFrame(payload)
		if err != nil {
			t.Error(err)
			return
		}
		receivedInput <- append([]byte(nil), current.payload...)
	}))
	defer server.Close()

	endpoint, err := Endpoint(server.URL)
	if err != nil {
		t.Fatal(err)
	}
	client, err := Dial(context.Background(), endpoint, "IS-legacy", Options{})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := client.SendInputConfirmed(ctx, []byte("legacy\n")); err != nil {
		t.Fatal(err)
	}
	if input := <-receivedInput; string(input) != "legacy\n" {
		t.Fatalf("input = %q", input)
	}
}

func TestDialUsesConfiguredHTTPClientAndTimeout(t *testing.T) {
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := websocket.Accept(w, r, nil)
		if err != nil {
			t.Error(err)
			return
		}
		defer conn.Close(websocket.StatusNormalClosure, "")
		for range 2 {
			if _, _, err := conn.Read(r.Context()); err != nil {
				return
			}
		}
		<-r.Context().Done()
	}))
	defer server.Close()

	endpoint, err := Endpoint(server.URL)
	if err != nil {
		t.Fatal(err)
	}
	httpClient := server.Client()
	httpClient.Timeout = 25 * time.Millisecond
	started := time.Now()
	_, err = Dial(context.Background(), endpoint, "IS-timeout", Options{HTTPClient: httpClient})
	if err == nil {
		t.Fatal("expected subscription timeout")
	}
	if elapsed := time.Since(started); elapsed > time.Second {
		t.Fatalf("dial timeout took %s", elapsed)
	}
}

func TestDialDoesNotApplyHTTPClientTimeoutToEstablishedConnection(t *testing.T) {
	receivedInput := make(chan []byte, 1)
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := websocket.Accept(w, r, nil)
		if err != nil {
			t.Error(err)
			return
		}
		defer conn.Close(websocket.StatusNormalClosure, "")
		for range 2 {
			if _, _, err := conn.Read(r.Context()); err != nil {
				t.Error(err)
				return
			}
		}
		subscribed, _ := json.Marshal(eventPayload{Type: "subscribed", CanInput: true})
		if err := conn.Write(r.Context(), websocket.MessageBinary, encodeFrame(frame{
			messageType: messageEvent,
			sessionID:   "IS-established",
			payload:     subscribed,
		})); err != nil {
			t.Error(err)
			return
		}
		_, payload, err := conn.Read(r.Context())
		if err != nil {
			t.Error(err)
			return
		}
		current, err := decodeFrame(payload)
		if err != nil {
			t.Error(err)
			return
		}
		receivedInput <- append([]byte(nil), current.payload...)
	}))
	defer server.Close()

	endpoint, err := Endpoint(server.URL)
	if err != nil {
		t.Fatal(err)
	}
	httpClient := server.Client()
	httpClient.Timeout = 25 * time.Millisecond
	client, err := Dial(context.Background(), endpoint, "IS-established", Options{
		HTTPClient: httpClient,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	time.Sleep(2 * httpClient.Timeout)
	if err := client.SendInput(context.Background(), []byte("still-open\n")); err != nil {
		t.Fatal(err)
	}
	if input := <-receivedInput; string(input) != "still-open\n" {
		t.Fatalf("input = %q", input)
	}
}

func TestAttachClosesCloseableTerminalAfterRemoteClosure(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := websocket.Accept(w, r, nil)
		if err != nil {
			t.Error(err)
			return
		}
		defer conn.Close(websocket.StatusNormalClosure, "")

		for range 2 {
			if _, _, err := conn.Read(r.Context()); err != nil {
				t.Error(err)
				return
			}
		}
		subscribed, _ := json.Marshal(eventPayload{Type: "subscribed", CanInput: true})
		if err := conn.Write(r.Context(), websocket.MessageBinary, encodeFrame(frame{
			messageType: messageEvent,
			sessionID:   "IS-1",
			payload:     subscribed,
		})); err != nil {
			t.Error(err)
			return
		}
		closed, _ := json.Marshal(eventPayload{Type: "closed"})
		_ = conn.Write(r.Context(), websocket.MessageBinary, encodeFrame(frame{
			messageType: messageEvent,
			sessionID:   "IS-1",
			payload:     closed,
		}))
	}))
	defer server.Close()

	endpoint, err := Endpoint(server.URL)
	if err != nil {
		t.Fatal(err)
	}
	client, err := Dial(context.Background(), endpoint, "IS-1", Options{Cols: 120, Rows: 34})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()

	terminal := newBlockingTerminal()
	if err := client.Attach(context.Background(), terminal, nil); err != nil {
		t.Fatal(err)
	}
	select {
	case <-terminal.closed:
	case <-time.After(time.Second):
		t.Fatal("terminal was not closed")
	}
}

func TestClientSubscribesReadOnlyAndSuppressesInput(t *testing.T) {
	acknowledged := make(chan uint32, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := websocket.Accept(w, r, nil)
		if err != nil {
			t.Error(err)
			return
		}
		defer conn.Close(websocket.StatusNormalClosure, "")

		for range 2 {
			if _, _, err := conn.Read(r.Context()); err != nil {
				t.Error(err)
				return
			}
		}
		event, _ := json.Marshal(eventPayload{Type: "subscribed", CanInput: false})
		if err := conn.Write(r.Context(), websocket.MessageBinary, encodeFrame(frame{
			messageType: messageEvent,
			sessionID:   "IS-read-only",
			payload:     event,
		})); err != nil {
			t.Error(err)
			return
		}
		if err := conn.Write(r.Context(), websocket.MessageBinary, encodeFrame(frame{
			messageType: messageOutput,
			sessionID:   "IS-read-only",
			payload:     []byte("read-only\n"),
		})); err != nil {
			t.Error(err)
			return
		}
		_, payload, err := conn.Read(r.Context())
		if err != nil {
			t.Error(err)
			return
		}
		ack, err := decodeFrame(payload)
		if err != nil {
			t.Error(err)
			return
		}
		if ack.messageType != messageAck {
			t.Errorf("read-only client sent message type = %d", ack.messageType)
			return
		}
		acknowledged <- binary.LittleEndian.Uint32(ack.payload)
		closed, _ := json.Marshal(eventPayload{Type: "closed"})
		_ = conn.Write(r.Context(), websocket.MessageBinary, encodeFrame(frame{
			messageType: messageEvent,
			sessionID:   "IS-read-only",
			payload:     closed,
		}))
	}))
	defer server.Close()

	endpoint, err := Endpoint(server.URL)
	if err != nil {
		t.Fatal(err)
	}
	client, err := Dial(context.Background(), endpoint, "IS-read-only", Options{})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	if client.canInput.Load() {
		t.Fatal("read-only subscription unexpectedly has input control")
	}
	inputReader, inputWriter := io.Pipe()
	defer inputReader.Close()
	defer inputWriter.Close()
	terminal := &readWriter{reader: inputReader, closer: inputReader}
	resizes := make(chan Size, 1)
	resizes <- Size{Cols: 132, Rows: 43}
	if err := client.Attach(context.Background(), terminal, resizes); err != nil {
		t.Fatal(err)
	}
	if terminal.String() != "read-only\n" {
		t.Fatalf("output = %q", terminal.String())
	}
	if bytes := <-acknowledged; bytes != uint32(len("read-only\n")) {
		t.Fatalf("acknowledged = %d", bytes)
	}
}

func TestClientReadOnlyAttachReturnsOnTerminalEOF(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := websocket.Accept(w, r, nil)
		if err != nil {
			t.Error(err)
			return
		}
		defer conn.Close(websocket.StatusNormalClosure, "")
		for range 2 {
			if _, _, err := conn.Read(r.Context()); err != nil {
				t.Error(err)
				return
			}
		}
		event, _ := json.Marshal(eventPayload{Type: "subscribed", CanInput: false})
		if err := conn.Write(r.Context(), websocket.MessageBinary, encodeFrame(frame{
			messageType: messageEvent,
			sessionID:   "IS-read-only-eof",
			payload:     event,
		})); err != nil {
			t.Error(err)
			return
		}
		_, _, _ = conn.Read(r.Context())
	}))
	defer server.Close()

	endpoint, err := Endpoint(server.URL)
	if err != nil {
		t.Fatal(err)
	}
	client, err := Dial(context.Background(), endpoint, "IS-read-only-eof", Options{})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()

	done := make(chan error, 1)
	go func() {
		done <- client.Attach(context.Background(), &readWriter{reader: bytes.NewReader(nil)}, nil)
	}()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("read-only attach did not return after terminal EOF")
	}
}

func TestClientContinuesReadOnlyAndResumesControl(t *testing.T) {
	resumedSize := make(chan Size, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := websocket.Accept(w, r, nil)
		if err != nil {
			t.Error(err)
			return
		}
		defer conn.Close(websocket.StatusNormalClosure, "")
		for range 2 {
			if _, _, err := conn.Read(r.Context()); err != nil {
				t.Error(err)
				return
			}
		}
		subscribed, _ := json.Marshal(eventPayload{Type: "subscribed", CanInput: true})
		if err := conn.Write(r.Context(), websocket.MessageBinary, encodeFrame(frame{
			messageType: messageEvent,
			sessionID:   "IS-live-control",
			payload:     subscribed,
		})); err != nil {
			t.Error(err)
			return
		}
		if err := conn.Write(r.Context(), websocket.MessageBinary, encodeFrame(frame{
			messageType: messageControlRevoked,
			sessionID:   "IS-live-control",
		})); err != nil {
			t.Error(err)
			return
		}
		if err := conn.Write(r.Context(), websocket.MessageBinary, encodeFrame(frame{
			messageType: messageOutput,
			sessionID:   "IS-live-control",
			payload:     []byte("read-only\n"),
		})); err != nil {
			t.Error(err)
			return
		}
		if _, payload, err := conn.Read(r.Context()); err != nil {
			t.Error(err)
			return
		} else if ack, decodeErr := decodeFrame(payload); decodeErr != nil || ack.messageType != messageAck {
			t.Errorf("read-only acknowledgement = %#v, %v", ack, decodeErr)
			return
		}
		if err := conn.Write(r.Context(), websocket.MessageBinary, encodeFrame(frame{
			messageType: messageControlGranted,
			sessionID:   "IS-live-control",
		})); err != nil {
			t.Error(err)
			return
		}
		_, payload, err := conn.Read(r.Context())
		if err != nil {
			t.Error(err)
			return
		}
		resize, err := decodeFrame(payload)
		if err != nil || resize.messageType != messageResize {
			t.Errorf("resumed resize = %#v, %v", resize, err)
			return
		}
		resumedSize <- Size{
			Cols: binary.LittleEndian.Uint32(resize.payload[0:4]),
			Rows: binary.LittleEndian.Uint32(resize.payload[4:8]),
		}
		if err := conn.Write(r.Context(), websocket.MessageBinary, encodeFrame(frame{
			messageType: messageOutput,
			sessionID:   "IS-live-control",
			payload:     []byte("live\n"),
		})); err != nil {
			t.Error(err)
			return
		}
		if _, _, err := conn.Read(r.Context()); err != nil {
			t.Error(err)
			return
		}
		closed, _ := json.Marshal(eventPayload{Type: "closed"})
		_ = conn.Write(r.Context(), websocket.MessageBinary, encodeFrame(frame{
			messageType: messageEvent,
			sessionID:   "IS-live-control",
			payload:     closed,
		}))
	}))
	defer server.Close()

	endpoint, err := Endpoint(server.URL)
	if err != nil {
		t.Fatal(err)
	}
	client, err := Dial(context.Background(), endpoint, "IS-live-control", Options{
		Cols: 132,
		Rows: 43,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	inputReader, inputWriter := io.Pipe()
	defer inputReader.Close()
	defer inputWriter.Close()
	terminal := &readWriter{reader: inputReader, closer: inputReader}
	if err := client.Attach(context.Background(), terminal, nil); err != nil {
		t.Fatal(err)
	}
	if terminal.String() != "read-only\nlive\n" {
		t.Fatalf("output = %q", terminal.String())
	}
	if size := <-resumedSize; size != (Size{Cols: 132, Rows: 43}) {
		t.Fatalf("resumed size = %#v", size)
	}
	if !client.canInput.Load() {
		t.Fatal("client did not resume input control")
	}
}

func waitForPendingAttachmentFrames(t *testing.T, client *Client, count int) {
	t.Helper()
	deadline := time.Now().Add(time.Second)
	for {
		client.stateMu.Lock()
		pending := len(client.pendingAttachmentFrames)
		client.stateMu.Unlock()
		if pending == count {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("pending attachment frames = %d", pending)
		}
		time.Sleep(time.Millisecond)
	}
}

type readWriter struct {
	reader io.Reader
	closer io.Closer
	bytes.Buffer
}

func (rw *readWriter) Read(payload []byte) (int, error) {
	return rw.reader.Read(payload)
}

func (rw *readWriter) CancelRead() error {
	if rw.closer == nil {
		return nil
	}
	return rw.closer.Close()
}

type blockingTerminal struct {
	closed    chan struct{}
	once      sync.Once
	started   chan struct{}
	startOnce sync.Once
	bytes.Buffer
}

func newBlockingTerminal() *blockingTerminal {
	return &blockingTerminal{
		closed:  make(chan struct{}),
		started: make(chan struct{}),
	}
}

func (terminal *blockingTerminal) Read(_ []byte) (int, error) {
	terminal.startOnce.Do(func() {
		close(terminal.started)
	})
	<-terminal.closed
	return 0, io.ErrClosedPipe
}

func (terminal *blockingTerminal) CancelRead() error {
	terminal.once.Do(func() {
		close(terminal.closed)
	})
	return nil
}
