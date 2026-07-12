package terminalws

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
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

func TestSendInputConfirmedDoesNotTreatControlRevocationAsInputRejection(t *testing.T) {
	revokedSent := make(chan struct{})
	releaseAcceptance := make(chan struct{})
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
		if err := conn.Write(r.Context(), websocket.MessageBinary, encodeFrame(frame{
			messageType: messageControlRevoked,
			sessionID:   "IS-revoked",
			payload:     revoked,
		})); err != nil {
			t.Error(err)
			return
		}
		close(revokedSent)
		select {
		case <-releaseAcceptance:
		case <-r.Context().Done():
			return
		}
		accepted, _ := json.Marshal(eventPayload{Type: "input-accepted"})
		_ = conn.Write(r.Context(), websocket.MessageBinary, encodeFrame(frame{
			messageType: messageEvent,
			sessionID:   "IS-revoked",
			payload:     accepted,
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
	done := make(chan error, 1)
	go func() {
		done <- client.SendInputConfirmed(context.Background(), []byte("forwarded\n"))
	}()
	<-revokedSent
	select {
	case err := <-done:
		t.Fatalf("control revocation completed forwarded input: %v", err)
	case <-time.After(50 * time.Millisecond):
	}
	if client.canInput.Load() {
		t.Fatal("control revocation did not remove input capability")
	}
	close(releaseAcceptance)
	if err := <-done; err != nil {
		t.Fatalf("later input acceptance = %v", err)
	}
}

func TestSendInputConfirmedReportsUnknownDelivery(t *testing.T) {
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
			sessionID:   "IS-delivery-unknown",
			payload:     subscribed,
		})); err != nil {
			t.Error(err)
			return
		}
		if _, _, err := conn.Read(r.Context()); err != nil {
			t.Error(err)
			return
		}
		unknown, _ := json.Marshal(eventPayload{
			Type:  "input-delivery-unknown",
			Error: ErrInputDeliveryUnknown.Error(),
		})
		_ = conn.Write(r.Context(), websocket.MessageBinary, encodeFrame(frame{
			messageType: messageEvent,
			sessionID:   "IS-delivery-unknown",
			payload:     unknown,
		}))
	}))
	defer server.Close()

	endpoint, err := Endpoint(server.URL)
	if err != nil {
		t.Fatal(err)
	}
	client, err := Dial(context.Background(), endpoint, "IS-delivery-unknown", Options{})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()

	err = client.SendInputConfirmed(context.Background(), []byte("possibly-delivered\n"))
	if !errors.Is(err, ErrInputDeliveryUnknown) {
		t.Fatalf("error = %v", err)
	}
	if err.Error() != ErrInputDeliveryUnknown.Error() {
		t.Fatalf("error text = %q", err)
	}
	if !client.canInput.Load() {
		t.Fatal("ambiguous delivery revoked input capability")
	}
}

func TestSendInputConfirmedAcknowledgesOutputWithoutAttachment(t *testing.T) {
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
			sessionID:   "IS-message",
			payload:     subscribed,
		})); err != nil {
			t.Error(err)
			return
		}
		if _, _, err := conn.Read(r.Context()); err != nil {
			t.Error(err)
			return
		}
		if err := conn.Write(r.Context(), websocket.MessageBinary, encodeFrame(frame{
			messageType: messageOutput,
			sessionID:   "IS-message",
			payload:     []byte("prompt\n"),
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
		if err != nil || ack.messageType != messageAck {
			t.Errorf("output acknowledgement = %#v, %v", ack, err)
			return
		}
		acknowledged <- binary.LittleEndian.Uint32(ack.payload)
		accepted, _ := json.Marshal(eventPayload{Type: "input-accepted"})
		_ = conn.Write(r.Context(), websocket.MessageBinary, encodeFrame(frame{
			messageType: messageEvent,
			sessionID:   "IS-message",
			payload:     accepted,
		}))
	}))
	defer server.Close()

	endpoint, err := Endpoint(server.URL)
	if err != nil {
		t.Fatal(err)
	}
	client, err := Dial(context.Background(), endpoint, "IS-message", Options{})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()

	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := client.SendInputConfirmed(ctx, []byte("echo ready\n")); err != nil {
		t.Fatal(err)
	}
	if bytes := <-acknowledged; bytes != uint32(len("prompt\n")) {
		t.Fatalf("acknowledged = %d", bytes)
	}
}

func TestSendInputConfirmedWakesOutputWaitingForAttachment(t *testing.T) {
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
			sessionID:   "IS-output-first",
			payload:     subscribed,
		})); err != nil {
			t.Error(err)
			return
		}
		if err := conn.Write(r.Context(), websocket.MessageBinary, encodeFrame(frame{
			messageType: messageOutput,
			sessionID:   "IS-output-first",
			payload:     []byte("prompt\n"),
		})); err != nil {
			t.Error(err)
			return
		}
		close(outputSent)

		seenInput := false
		seenAcknowledgement := false
		for !seenInput || !seenAcknowledgement {
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
				seenInput = true
			case messageAck:
				seenAcknowledgement = true
			default:
				t.Errorf("message type = %d", current.messageType)
				return
			}
		}
		accepted, _ := json.Marshal(eventPayload{Type: "input-accepted"})
		_ = conn.Write(r.Context(), websocket.MessageBinary, encodeFrame(frame{
			messageType: messageEvent,
			sessionID:   "IS-output-first",
			payload:     accepted,
		}))
	}))
	defer server.Close()

	endpoint, err := Endpoint(server.URL)
	if err != nil {
		t.Fatal(err)
	}
	client, err := Dial(context.Background(), endpoint, "IS-output-first", Options{})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	<-outputSent

	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := client.SendInputConfirmed(ctx, []byte("echo ready\n")); err != nil {
		t.Fatal(err)
	}
}

func TestSendInputConfirmedFailsWhenConnectionClosesBeforeAcknowledgement(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := websocket.Accept(w, r, nil)
		if err != nil {
			t.Error(err)
			return
		}
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
			sessionID:   "IS-close-before-ack",
			payload:     subscribed,
		})); err != nil {
			t.Error(err)
			return
		}
		if _, _, err := conn.Read(r.Context()); err != nil {
			t.Error(err)
			return
		}
		_ = conn.Close(websocket.StatusNormalClosure, "")
	}))
	defer server.Close()

	endpoint, err := Endpoint(server.URL)
	if err != nil {
		t.Fatal(err)
	}
	client, err := Dial(context.Background(), endpoint, "IS-close-before-ack", Options{})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()

	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	err = client.SendInputConfirmed(ctx, []byte("echo ready\n"))
	if err == nil {
		t.Fatal("normal close before acknowledgement reported success")
	}
}

func TestSendInputConfirmedPrefersAcceptanceBeforeReaderClose(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := websocket.Accept(w, r, nil)
		if err != nil {
			t.Error(err)
			return
		}
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
			sessionID:   "IS-accepted-before-close",
			payload:     subscribed,
		})); err != nil {
			t.Error(err)
			return
		}
		if _, _, err := conn.Read(r.Context()); err != nil {
			t.Error(err)
			return
		}
		accepted, _ := json.Marshal(eventPayload{Type: "input-accepted"})
		if err := conn.Write(r.Context(), websocket.MessageBinary, encodeFrame(frame{
			messageType: messageEvent,
			sessionID:   "IS-accepted-before-close",
			payload:     accepted,
		})); err != nil {
			t.Error(err)
			return
		}
		_ = conn.Close(websocket.StatusNormalClosure, "")
	}))
	defer server.Close()

	endpoint, err := Endpoint(server.URL)
	if err != nil {
		t.Fatal(err)
	}
	client, err := Dial(context.Background(), endpoint, "IS-accepted-before-close", Options{})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()

	if err := client.SendInputConfirmed(context.Background(), []byte("echo ready\n")); err != nil {
		t.Fatal(err)
	}
}

func TestAttachRejectsSessionClosedBeforeAttachment(t *testing.T) {
	closedSent := make(chan struct{})
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
			sessionID:   "IS-closed-before-attach",
			payload:     subscribed,
		})); err != nil {
			t.Error(err)
			return
		}
		closed, _ := json.Marshal(eventPayload{Type: "closed"})
		if err := conn.Write(r.Context(), websocket.MessageBinary, encodeFrame(frame{
			messageType: messageEvent,
			sessionID:   "IS-closed-before-attach",
			payload:     closed,
		})); err != nil {
			t.Error(err)
			return
		}
		close(closedSent)
		<-r.Context().Done()
	}))
	defer server.Close()

	endpoint, err := Endpoint(server.URL)
	if err != nil {
		t.Fatal(err)
	}
	client, err := Dial(context.Background(), endpoint, "IS-closed-before-attach", Options{})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	<-closedSent
	deadline := time.Now().Add(time.Second)
	for {
		client.stateMu.Lock()
		terminalErr := client.terminalErr
		client.stateMu.Unlock()
		if terminalErr != nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("terminal close was not retained")
		}
		time.Sleep(time.Millisecond)
	}

	err = client.Attach(context.Background(), newBlockingTerminal(), nil)
	if err == nil || !strings.Contains(err.Error(), "terminal closed") {
		t.Fatalf("error = %v", err)
	}
}

func TestRetiredAttachmentCannotAcceptBufferedFrames(t *testing.T) {
	attachment := &terminalAttachment{
		frames: make(chan attachmentDelivery),
		done:   make(chan struct{}),
	}
	close(attachment.done)
	client := &Client{attachment: attachment}

	for range 100 {
		if client.deliverAttachment(context.Background(), frame{messageType: messageOutput}) {
			t.Fatal("retired attachment accepted output")
		}
	}
}

func TestRetiredAttachmentRejectsReceivedDelivery(t *testing.T) {
	oldAttachment := &terminalAttachment{
		frames: make(chan attachmentDelivery),
		done:   make(chan struct{}),
	}
	replacement := &terminalAttachment{
		frames: make(chan attachmentDelivery),
		done:   make(chan struct{}),
	}
	client := &Client{attachment: replacement}
	close(oldAttachment.done)

	for range 1_000 {
		delivery := attachmentDelivery{
			frame:    frame{messageType: messageOutput, payload: []byte("replacement output\n")},
			accepted: make(chan bool, 1),
		}
		if client.acceptAttachmentDelivery(oldAttachment, delivery) {
			t.Fatal("retired attachment accepted a received delivery")
		}
		if accepted := <-delivery.accepted; accepted {
			t.Fatal("retired attachment acknowledged a received delivery")
		}
	}
}

func TestStaleAttachmentDeliveryRetriesReplacement(t *testing.T) {
	oldAttachment := &terminalAttachment{
		frames: make(chan attachmentDelivery),
		done:   make(chan struct{}),
	}
	replacement := &terminalAttachment{
		frames: make(chan attachmentDelivery),
		done:   make(chan struct{}),
	}
	client := &Client{
		attachment:      oldAttachment,
		attachmentReady: make(chan struct{}),
	}

	staleCaptured := make(chan struct{})
	releaseStale := make(chan struct{})
	go func() {
		delivery := <-oldAttachment.frames
		close(staleCaptured)
		<-releaseStale
		client.acceptAttachmentDelivery(oldAttachment, delivery)
	}()

	delivered := make(chan error, 1)
	go func() {
		delivered <- client.deliverOrQueueOutput(context.Background(), frame{
			messageType: messageOutput,
			payload:     []byte("replacement output\n"),
		})
	}()
	<-staleCaptured

	client.stateMu.Lock()
	client.attachment = replacement
	close(oldAttachment.done)
	client.stateMu.Unlock()

	replacementReceived := make(chan frame, 1)
	go func() {
		delivery := <-replacement.frames
		if client.acceptAttachmentDelivery(replacement, delivery) {
			replacementReceived <- delivery.frame
		}
	}()
	close(releaseStale)

	select {
	case err := <-delivered:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("stale delivery did not retry the replacement attachment")
	}
	select {
	case current := <-replacementReceived:
		if got := string(current.payload); got != "replacement output\n" {
			t.Fatalf("replacement payload = %q", got)
		}
	case <-time.After(time.Second):
		t.Fatal("replacement attachment did not receive retried output")
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

func TestSendInputDrainsAcknowledgementBeforeConfirmedSend(t *testing.T) {
	rawReceived := make(chan struct{})
	confirmedReceived := make(chan struct{})
	releaseRawAcknowledgement := make(chan struct{})
	releaseConfirmedAcknowledgement := make(chan struct{})
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
			sessionID:   "IS-raw-confirmed",
			payload:     subscribed,
		})); err != nil {
			t.Error(err)
			return
		}

		inputs := make(chan frame, 2)
		go func() {
			for range 2 {
				_, payload, readErr := conn.Read(r.Context())
				if readErr != nil {
					return
				}
				current, decodeErr := decodeFrame(payload)
				if decodeErr != nil {
					t.Error(decodeErr)
					return
				}
				inputs <- current
			}
		}()

		raw := <-inputs
		if raw.messageType != messageInput || string(raw.payload) != "raw\n" {
			t.Errorf("raw input = %#v", raw)
			return
		}
		close(rawReceived)
		select {
		case confirmed := <-inputs:
			if confirmed.messageType != messageInput || string(confirmed.payload) != "confirmed\n" {
				t.Errorf("confirmed input = %#v", confirmed)
				return
			}
			close(confirmedReceived)
		case <-releaseRawAcknowledgement:
		}

		accepted, _ := json.Marshal(eventPayload{Type: "input-accepted"})
		if err := conn.Write(r.Context(), websocket.MessageBinary, encodeFrame(frame{
			messageType: messageEvent,
			sessionID:   "IS-raw-confirmed",
			payload:     accepted,
		})); err != nil {
			t.Error(err)
			return
		}
		select {
		case <-confirmedReceived:
		default:
			confirmed := <-inputs
			if confirmed.messageType != messageInput || string(confirmed.payload) != "confirmed\n" {
				t.Errorf("confirmed input = %#v", confirmed)
				return
			}
			close(confirmedReceived)
		}
		<-releaseConfirmedAcknowledgement
		if err := conn.Write(r.Context(), websocket.MessageBinary, encodeFrame(frame{
			messageType: messageEvent,
			sessionID:   "IS-raw-confirmed",
			payload:     accepted,
		})); err != nil {
			t.Error(err)
		}
	}))
	defer server.Close()

	endpoint, err := Endpoint(server.URL)
	if err != nil {
		t.Fatal(err)
	}
	client, err := Dial(context.Background(), endpoint, "IS-raw-confirmed", Options{})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()

	if err := client.SendInput(context.Background(), []byte("raw\n")); err != nil {
		t.Fatal(err)
	}
	<-rawReceived

	confirmedStarted := make(chan struct{})
	confirmedDone := make(chan error, 1)
	go func() {
		close(confirmedStarted)
		confirmedDone <- client.SendInputConfirmed(context.Background(), []byte("confirmed\n"))
	}()
	<-confirmedStarted
	select {
	case <-confirmedReceived:
		t.Fatal("confirmed input was written before the raw acknowledgement")
	case <-time.After(100 * time.Millisecond):
	}

	close(releaseRawAcknowledgement)
	<-confirmedReceived
	select {
	case err := <-confirmedDone:
		t.Fatalf("confirmed send completed from the raw acknowledgement: %v", err)
	case <-time.After(100 * time.Millisecond):
	}

	close(releaseConfirmedAcknowledgement)
	if err := <-confirmedDone; err != nil {
		t.Fatal(err)
	}
}

func TestSendInputConfirmedCanCancelWhileWaitingForPreviousConfirmation(t *testing.T) {
	firstInput := make(chan struct{})
	releaseFirst := make(chan struct{})
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
			sessionID:   "IS-cancel-wait",
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
				<-releaseFirst
			}
			if err := conn.Write(r.Context(), websocket.MessageBinary, encodeFrame(frame{
				messageType: messageEvent,
				sessionID:   "IS-cancel-wait",
				payload:     accepted,
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
	client, err := Dial(context.Background(), endpoint, "IS-cancel-wait", Options{})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()

	firstCtx, firstCancel := context.WithTimeout(context.Background(), time.Second)
	defer firstCancel()
	firstDone := make(chan error, 1)
	go func() {
		firstDone <- client.SendInputConfirmed(firstCtx, []byte("first\n"))
	}()
	<-firstInput

	waitCtx, waitCancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer waitCancel()
	started := time.Now()
	err = client.SendInputConfirmed(waitCtx, []byte("canceled\n"))
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("error = %v", err)
	}
	if elapsed := time.Since(started); elapsed > 250*time.Millisecond {
		t.Fatalf("waiting cancellation took %s", elapsed)
	}

	close(releaseFirst)
	if err := <-firstDone; err != nil {
		t.Fatal(err)
	}
	finalCtx, finalCancel := context.WithTimeout(context.Background(), time.Second)
	defer finalCancel()
	if err := client.SendInputConfirmed(finalCtx, []byte("final\n")); err != nil {
		t.Fatal(err)
	}
}

func TestSendInputConfirmedReturnsImmediatelyForEmptyInput(t *testing.T) {
	client := &Client{supportsInputAcknowledgement: true}
	if err := client.SendInputConfirmed(context.Background(), nil); err != nil {
		t.Fatal(err)
	}
}

func TestSendInputConfirmedClosesAfterConfirmationTimeout(t *testing.T) {
	inputReceived := make(chan struct{})
	releaseServer := make(chan struct{})
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
			sessionID:   "IS-confirm-timeout",
			payload:     subscribed,
		})); err != nil {
			t.Error(err)
			return
		}
		if _, _, err := conn.Read(r.Context()); err != nil {
			t.Error(err)
			return
		}
		close(inputReceived)
		<-releaseServer
	}))
	defer func() {
		close(releaseServer)
		server.Close()
	}()

	endpoint, err := Endpoint(server.URL)
	if err != nil {
		t.Fatal(err)
	}
	client, err := Dial(context.Background(), endpoint, "IS-confirm-timeout", Options{})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	started := time.Now()
	err = client.SendInputConfirmed(ctx, []byte("first\n"))
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("error = %v", err)
	}
	if elapsed := time.Since(started); elapsed > 250*time.Millisecond {
		t.Fatalf("confirmation deadline took %s", elapsed)
	}
	<-inputReceived
	if err := client.SendInputConfirmed(context.Background(), []byte("second\n")); err == nil {
		t.Fatal("timed-out client accepted another input")
	}
}

func TestAttachBoundsInputConfirmationAndRetiresConnection(t *testing.T) {
	inputReceived := make(chan struct{})
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
			sessionID:   "IS-attach-confirm-timeout",
			payload:     subscribed,
		})); err != nil {
			t.Error(err)
			return
		}
		if _, _, err := conn.Read(r.Context()); err != nil {
			t.Error(err)
			return
		}
		close(inputReceived)
		_, _, _ = conn.Read(r.Context())
	}))
	defer server.Close()

	endpoint, err := Endpoint(server.URL)
	if err != nil {
		t.Fatal(err)
	}
	client, err := Dial(context.Background(), endpoint, "IS-attach-confirm-timeout", Options{})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	client.confirmationTimeout = 20 * time.Millisecond

	terminal := &readWriter{reader: strings.NewReader("blocked\n")}
	started := time.Now()
	err = client.Attach(context.Background(), terminal, nil)
	if err == nil {
		t.Fatal("attachment succeeded without input confirmation")
	}
	if elapsed := time.Since(started); elapsed > 250*time.Millisecond {
		t.Fatalf("attachment confirmation timeout took %s", elapsed)
	}
	<-inputReceived
	if err := client.SendInputConfirmed(context.Background(), []byte("second\n")); err == nil {
		t.Fatal("timed-out attachment left the connection reusable")
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

func TestAttachReturnsWhenContextCancelsAnUncancelableRead(t *testing.T) {
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
			sessionID:   "IS-cancel",
			payload:     subscribed,
		})); err != nil {
			t.Error(err)
			return
		}
		<-r.Context().Done()
	}))
	defer server.Close()

	endpoint, err := Endpoint(server.URL)
	if err != nil {
		t.Fatal(err)
	}
	client, err := Dial(context.Background(), endpoint, "IS-cancel", Options{})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()

	terminal := newUncancelableTerminal()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		done <- client.Attach(ctx, terminal, nil)
	}()
	<-terminal.started
	cancel()
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("error = %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("Attach did not return after context cancellation")
	}
	close(terminal.release)
}

func TestAttachBoundsBlockedFrameConsumerShutdown(t *testing.T) {
	client := &Client{
		readerDone:                make(chan struct{}),
		attachmentReady:           make(chan struct{}),
		attachmentShutdownTimeout: 10 * time.Millisecond,
	}
	terminal := newUncancelableReadBlockingWriteTerminal()
	ctx, cancel := context.WithCancel(context.Background())
	attachDone := make(chan error, 1)
	go func() {
		attachDone <- client.Attach(ctx, terminal, nil)
	}()

	<-terminal.readStarted
	client.stateMu.Lock()
	attachment := client.attachment
	client.stateMu.Unlock()
	if attachment == nil {
		t.Fatal("attachment was not registered")
	}
	delivered := make(chan bool, 1)
	go func() {
		delivered <- client.deliverAttachment(context.Background(), frame{
			messageType: messageOutput,
			payload:     []byte("old output\n"),
		})
	}()
	<-terminal.writeStarted
	if !<-delivered {
		t.Fatal("output was not delivered to the attachment")
	}

	cancel()
	select {
	case err := <-attachDone:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("error = %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("Attach did not retire the blocked frame consumer")
	}

	replacement := newBlockingTerminal()
	replacementCtx, replacementCancel := context.WithCancel(context.Background())
	replacementDone := make(chan error, 1)
	go func() {
		replacementDone <- client.Attach(replacementCtx, replacement, nil)
	}()
	<-replacement.started
	replacementCancel()
	if err := <-replacementDone; !errors.Is(err, context.Canceled) {
		t.Fatalf("replacement error = %v", err)
	}

	close(terminal.releaseWrite)
	select {
	case <-terminal.writeDone:
	case <-time.After(time.Second):
		t.Fatal("blocked frame consumer did not exit after terminal shutdown")
	}
	close(terminal.releaseRead)
}

func TestRetiredBlockedAttachmentAcknowledgementKeepsReplacementConnectionOpen(t *testing.T) {
	firstAcknowledged := make(chan struct{})
	secondAcknowledged := make(chan struct{})
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
			sessionID:   "IS-stale-ack",
			payload:     subscribed,
		})); err != nil {
			t.Error(err)
			return
		}
		if err := conn.Write(r.Context(), websocket.MessageBinary, encodeFrame(frame{
			messageType: messageOutput,
			sessionID:   "IS-stale-ack",
			payload:     []byte("old output\n"),
		})); err != nil {
			t.Error(err)
			return
		}
		if err := readOutputAcknowledgement(r.Context(), conn, len("old output\n")); err != nil {
			t.Error(err)
			return
		}
		close(firstAcknowledged)
		if err := conn.Write(r.Context(), websocket.MessageBinary, encodeFrame(frame{
			messageType: messageOutput,
			sessionID:   "IS-stale-ack",
			payload:     []byte("replacement output\n"),
		})); err != nil {
			t.Error(err)
			return
		}
		if err := readOutputAcknowledgement(r.Context(), conn, len("replacement output\n")); err != nil {
			t.Error(err)
			return
		}
		close(secondAcknowledged)
		<-r.Context().Done()
	}))
	defer server.Close()

	endpoint, err := Endpoint(server.URL)
	if err != nil {
		t.Fatal(err)
	}
	client, err := Dial(context.Background(), endpoint, "IS-stale-ack", Options{})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	client.attachmentShutdownTimeout = 10 * time.Millisecond

	oldTerminal := newUncancelableReadBlockingSuccessfulWriteTerminal()
	oldCtx, oldCancel := context.WithCancel(context.Background())
	oldDone := make(chan error, 1)
	go func() {
		oldDone <- client.Attach(oldCtx, oldTerminal, nil)
	}()
	<-oldTerminal.readStarted
	<-oldTerminal.writeStarted
	oldCancel()
	if err := <-oldDone; !errors.Is(err, context.Canceled) {
		t.Fatalf("old attachment error = %v", err)
	}

	replacement := newBlockingTerminal()
	replacementCtx, replacementCancel := context.WithCancel(context.Background())
	replacementDone := make(chan error, 1)
	go func() {
		replacementDone <- client.Attach(replacementCtx, replacement, nil)
	}()
	<-replacement.started

	close(oldTerminal.releaseWrite)
	select {
	case <-firstAcknowledged:
	case <-time.After(time.Second):
		t.Fatal("retired attachment did not acknowledge completed output")
	}
	select {
	case <-secondAcknowledged:
	case <-time.After(time.Second):
		t.Fatal("replacement connection did not acknowledge subsequent output")
	}
	replacementCancel()
	if err := <-replacementDone; !errors.Is(err, context.Canceled) {
		t.Fatalf("replacement error = %v", err)
	}
	if got := replacement.String(); got != "replacement output\n" {
		t.Fatalf("replacement output = %q", got)
	}
	close(oldTerminal.releaseRead)
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
	if client.canInput.Load() {
		t.Fatal("closed terminal retained input control")
	}
}

func readOutputAcknowledgement(
	ctx context.Context,
	conn *websocket.Conn,
	expectedBytes int,
) error {
	_, payload, err := conn.Read(ctx)
	if err != nil {
		return err
	}
	current, err := decodeFrame(payload)
	if err != nil {
		return err
	}
	if current.messageType != messageAck {
		return fmt.Errorf("acknowledgement message type = %d", current.messageType)
	}
	if len(current.payload) != 4 {
		return fmt.Errorf("acknowledgement payload length = %d", len(current.payload))
	}
	if acknowledged := binary.LittleEndian.Uint32(current.payload); acknowledged != uint32(expectedBytes) {
		return fmt.Errorf("acknowledged bytes = %d, want %d", acknowledged, expectedBytes)
	}
	return nil
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

type uncancelableTerminal struct {
	started   chan struct{}
	startOnce sync.Once
	release   chan struct{}
	bytes.Buffer
}

var errBlockedTerminalWrite = errors.New("blocked terminal write")

type uncancelableReadBlockingWriteTerminal struct {
	readStarted  chan struct{}
	readOnce     sync.Once
	releaseRead  chan struct{}
	writeStarted chan struct{}
	writeOnce    sync.Once
	releaseWrite chan struct{}
	writeDone    chan struct{}
	writeErr     error
}

func newUncancelableReadBlockingWriteTerminal() *uncancelableReadBlockingWriteTerminal {
	return &uncancelableReadBlockingWriteTerminal{
		readStarted:  make(chan struct{}),
		releaseRead:  make(chan struct{}),
		writeStarted: make(chan struct{}),
		releaseWrite: make(chan struct{}),
		writeDone:    make(chan struct{}),
		writeErr:     errBlockedTerminalWrite,
	}
}

func newUncancelableReadBlockingSuccessfulWriteTerminal() *uncancelableReadBlockingWriteTerminal {
	terminal := newUncancelableReadBlockingWriteTerminal()
	terminal.writeErr = nil
	return terminal
}

func (terminal *uncancelableReadBlockingWriteTerminal) Read(_ []byte) (int, error) {
	terminal.readOnce.Do(func() {
		close(terminal.readStarted)
	})
	<-terminal.releaseRead
	return 0, io.EOF
}

func (terminal *uncancelableReadBlockingWriteTerminal) Write(payload []byte) (int, error) {
	defer close(terminal.writeDone)
	terminal.writeOnce.Do(func() {
		close(terminal.writeStarted)
	})
	<-terminal.releaseWrite
	if terminal.writeErr != nil {
		return 0, terminal.writeErr
	}
	return len(payload), nil
}

func newUncancelableTerminal() *uncancelableTerminal {
	return &uncancelableTerminal{
		started: make(chan struct{}),
		release: make(chan struct{}),
	}
}

func (terminal *uncancelableTerminal) Read(_ []byte) (int, error) {
	terminal.startOnce.Do(func() {
		close(terminal.started)
	})
	<-terminal.release
	return 0, io.EOF
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
