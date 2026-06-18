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
	closed chan struct{}
	once   sync.Once
	bytes.Buffer
}

func newBlockingTerminal() *blockingTerminal {
	return &blockingTerminal{closed: make(chan struct{})}
}

func (terminal *blockingTerminal) Read(_ []byte) (int, error) {
	<-terminal.closed
	return 0, io.ErrClosedPipe
}

func (terminal *blockingTerminal) CancelRead() error {
	terminal.once.Do(func() {
		close(terminal.closed)
	})
	return nil
}
