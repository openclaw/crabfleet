package rfb

import (
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"image/jpeg"
	"io"
	"net"
	"testing"
	"time"

	"github.com/openclaw/crabfleet/internal/connect"
)

func TestSyntheticBackendEndToEnd(t *testing.T) {
	t.Parallel()
	backend, err := connect.NewSynthetic(connect.SyntheticOptions{Width: 32, Height: 18})
	if err != nil {
		t.Fatal(err)
	}
	server, client := net.Pipe()
	serverDone := make(chan error, 1)
	go func() {
		serverDone <- ServeConn(context.Background(), server, SessionConfig{
			Backend:          backend,
			Password:         sessionFixturePassword(),
			DesktopName:      "Synthetic Linux",
			ChallengeReader:  bytes.NewReader(sequence(16)),
			HandshakeTimeout: time.Second,
			MediaTimeout:     time.Second,
		})
	}()
	defer server.Close()

	assertRead(t, client, Version38Banner)
	assertWrite(t, client, Version38Banner)
	assertRead(t, client, []byte{2, SecurityARD, SecurityVNC})
	assertWrite(t, client, []byte{SecurityVNC})
	challenge := readExactly(t, client, 16)
	response, err := VNCChallengeResponse(challenge, sessionFixturePassword())
	if err != nil {
		t.Fatal(err)
	}
	assertWrite(t, client, response)
	assertRead(t, client, []byte{0, 0, 0, 0})
	assertWrite(t, client, []byte{1})

	serverInit := readExactly(t, client, 24)
	if binary.BigEndian.Uint16(serverInit) != 32 || binary.BigEndian.Uint16(serverInit[2:]) != 18 {
		t.Fatalf("server dimensions = %dx%d", binary.BigEndian.Uint16(serverInit), binary.BigEndian.Uint16(serverInit[2:]))
	}
	nameLength := binary.BigEndian.Uint32(serverInit[20:])
	assertRead(t, client, []byte("Synthetic Linux")[:nameLength])

	assertWrite(t, client, encodeSetEncodings([]int32{
		0x48455631, EncodingTight, EncodingCursorWithAlpha, EncodingPointerPosition,
	}))
	assertWrite(t, client, []byte{3, 0, 0, 0, 0, 0, 0, 32, 0, 18})

	updateHeader := readExactly(t, client, 4)
	if !bytes.Equal(updateHeader[:2], []byte{0, 0}) || binary.BigEndian.Uint16(updateHeader[2:]) != 3 {
		t.Fatalf("update header = %x", updateHeader)
	}
	videoHeader := readExactly(t, client, 13)
	if int32(binary.BigEndian.Uint32(videoHeader[8:])) != EncodingTight || videoHeader[12] != 0x90 {
		t.Fatalf("video header = %x", videoHeader)
	}
	jpegLength := readCompactFromConn(t, client)
	jpegPayload := readExactly(t, client, jpegLength)
	if _, err := jpeg.Decode(bytes.NewReader(jpegPayload)); err != nil {
		t.Fatalf("decode JPEG: %v", err)
	}
	cursorHeader := readExactly(t, client, 16)
	if int32(binary.BigEndian.Uint32(cursorHeader[8:])) != EncodingCursorWithAlpha || binary.BigEndian.Uint32(cursorHeader[12:]) != 0 {
		t.Fatalf("cursor header = %x", cursorHeader)
	}
	cursorWidth := int(binary.BigEndian.Uint16(cursorHeader[4:]))
	cursorHeight := int(binary.BigEndian.Uint16(cursorHeader[6:]))
	_ = readExactly(t, client, cursorWidth*cursorHeight*4)
	pointerHeader := readExactly(t, client, 12)
	if int32(binary.BigEndian.Uint32(pointerHeader[8:])) != EncodingPointerPosition {
		t.Fatalf("pointer header = %x", pointerHeader)
	}

	assertWrite(t, client, []byte{5, 1, 0, 7, 0, 8})
	assertWrite(t, client, []byte{4, 1, 0, 0, 0, 0, 0, 65})
	if err := client.Close(); err != nil {
		t.Fatal(err)
	}
	if err := <-serverDone; err == nil || (!errors.Is(err, io.EOF) && !errors.Is(err, net.ErrClosed)) {
		t.Fatalf("session result = %v", err)
	}
	events := backend.Events()
	if len(events) != 4 || events[0].Pointer == nil || events[1].Key == nil ||
		events[2].Key == nil || events[2].Key.Down || events[3].Pointer == nil || events[3].Pointer.ButtonMask != 0 {
		t.Fatalf("input events = %+v", events)
	}
}

func TestHandshakeRejectsSecurityNoneAndARDStub(t *testing.T) {
	t.Parallel()
	for _, selection := range []byte{1, SecurityARD} {
		selection := selection
		t.Run(string(rune(selection)), func(t *testing.T) {
			t.Parallel()
			backend, err := connect.NewSynthetic(connect.SyntheticOptions{Width: 4, Height: 4})
			if err != nil {
				t.Fatal(err)
			}
			server, client := net.Pipe()
			done := make(chan error, 1)
			go func() {
				done <- ServeConn(context.Background(), server, SessionConfig{
					Backend: backend, Password: "fake", HandshakeTimeout: time.Second,
				})
			}()
			assertRead(t, client, Version38Banner)
			assertWrite(t, client, Version38Banner)
			assertRead(t, client, []byte{2, SecurityARD, SecurityVNC})
			assertWrite(t, client, []byte{selection})
			if selection == SecurityARD {
				status := readExactly(t, client, 4)
				if binary.BigEndian.Uint32(status) != 1 {
					t.Fatalf("ARD failure status = %x", status)
				}
				length := binary.BigEndian.Uint32(readExactly(t, client, 4))
				_ = readExactly(t, client, int(length))
			}
			_ = client.Close()
			if err := <-done; err == nil {
				t.Fatal("security selection was accepted")
			}
		})
	}
}

func TestSessionRejectsMalformedSetEncodings(t *testing.T) {
	t.Parallel()
	backend, err := connect.NewSynthetic(connect.SyntheticOptions{Width: 4, Height: 4})
	if err != nil {
		t.Fatal(err)
	}
	server, client := net.Pipe()
	done := make(chan error, 1)
	go func() {
		done <- ServeConn(context.Background(), server, SessionConfig{
			Backend: backend, Password: "fake", ChallengeReader: bytes.NewReader(sequence(16)), HandshakeTimeout: time.Second,
		})
	}()
	completeHandshake(t, client, "fake")
	serverInit := readExactly(t, client, 24)
	nameLength := binary.BigEndian.Uint32(serverInit[20:])
	_ = readExactly(t, client, int(nameLength))
	assertWrite(t, client, []byte{2, 0, 1, 1})
	_ = client.Close()
	if err := <-done; err == nil {
		t.Fatal("malformed SetEncodings was accepted")
	}
}

func TestSessionConfigurationRejectsLongVNCPassword(t *testing.T) {
	t.Parallel()
	backend, err := connect.NewSynthetic(connect.SyntheticOptions{Width: 4, Height: 4})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := (SessionConfig{Backend: backend, Password: forkFixturePassword()}).normalized(); err == nil {
		t.Fatal("accepted VNC password longer than eight characters")
	}
}

func completeHandshake(t *testing.T, client net.Conn, password string) {
	t.Helper()
	assertRead(t, client, Version38Banner)
	assertWrite(t, client, Version38Banner)
	assertRead(t, client, []byte{2, SecurityARD, SecurityVNC})
	assertWrite(t, client, []byte{SecurityVNC})
	challenge := readExactly(t, client, 16)
	response, err := VNCChallengeResponse(challenge, password)
	if err != nil {
		t.Fatal(err)
	}
	assertWrite(t, client, response)
	assertRead(t, client, []byte{0, 0, 0, 0})
	assertWrite(t, client, []byte{1})
}

func assertRead(t *testing.T, reader io.Reader, expected []byte) {
	t.Helper()
	actual := readExactly(t, reader, len(expected))
	if !bytes.Equal(actual, expected) {
		t.Fatalf("read %x, want %x", actual, expected)
	}
}

func assertWrite(t *testing.T, writer io.Writer, payload []byte) {
	t.Helper()
	if err := writeFull(writer, payload); err != nil {
		t.Fatal(err)
	}
}

func readExactly(t *testing.T, reader io.Reader, count int) []byte {
	t.Helper()
	result := make([]byte, count)
	if _, err := io.ReadFull(reader, result); err != nil {
		t.Fatal(err)
	}
	return result
}

func readCompactFromConn(t *testing.T, reader io.Reader) int {
	t.Helper()
	first := readExactly(t, reader, 1)[0]
	result := int(first & 0x7f)
	if first&0x80 == 0 {
		return result
	}
	second := readExactly(t, reader, 1)[0]
	result |= int(second&0x7f) << 7
	if second&0x80 == 0 {
		return result
	}
	return result | int(readExactly(t, reader, 1)[0])<<14
}

func sequence(count int) []byte {
	result := make([]byte, count)
	for index := range result {
		result[index] = byte(index)
	}
	return result
}

func sessionFixturePassword() string {
	return "1234" + "5678"
}
