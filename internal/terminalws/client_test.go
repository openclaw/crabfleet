package terminalws

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/coder/websocket"
)

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

		_, inputPayload, err := conn.Read(r.Context())
		if err != nil {
			t.Error(err)
			return
		}
		input, err := decodeFrame(inputPayload)
		if err != nil {
			t.Error(err)
			return
		}
		receivedInput <- append([]byte(nil), input.payload...)

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
	terminal := &readWriter{reader: inputReader}
	go func() {
		_, _ = inputWriter.Write([]byte("hello\n"))
	}()
	if err := client.Attach(context.Background(), terminal); err != nil {
		t.Fatal(err)
	}
	if input := <-receivedInput; string(input) != "hello\n" {
		t.Fatalf("input = %q", input)
	}
	if terminal.String() != "ready\n" {
		t.Fatalf("output = %q", terminal.String())
	}
	if bytes := <-acknowledged; bytes != uint32(len("ready\n")) {
		t.Fatalf("acknowledged = %d", bytes)
	}
}

type readWriter struct {
	reader io.Reader
	bytes.Buffer
}

func (rw *readWriter) Read(payload []byte) (int, error) {
	return rw.reader.Read(payload)
}
