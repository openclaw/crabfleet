package rfb

import (
	"bytes"
	"context"
	"encoding/binary"
	"fmt"
	"net"
	"os"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/openclaw/crabfleet/internal/connect"
)

type parameterVideoFixture struct {
	mu               sync.Mutex
	version, content byte
}

func (v *parameterVideoFixture) Encode(_ context.Context, _ connect.Frame, codec string) ([]byte, error) {
	v.mu.Lock()
	defer v.mu.Unlock()
	v.content++
	if codec == "h264" {
		return []byte{0, 0, 0, 1, 0x67, 0x64, v.version, 0x80, 0, 0, 1, 0x68, 0xce, 0x80, 0, 0, 1, 0x65, v.content, 0x80}, nil
	}
	return []byte{0, 0, 1, 0x40, 1, v.version, 0x80, 0, 0, 0, 1, 0x42, 1, v.version, 0x80, 0, 0, 1, 0x44, 1, 0x80, 0, 0, 1, 0x26, 1, v.content, 0x80}, nil
}
func (v *parameterVideoFixture) changeContext() { v.mu.Lock(); v.version++; v.mu.Unlock() }

type videoDropConnection struct {
	net.Conn
	drop atomic.Bool
}

func (c *videoDropConnection) Write(p []byte) (int, error) {
	if len(p) >= 24 && p[0] == 0 && binary.BigEndian.Uint16(p[2:]) == 1 {
		encoding := int32(binary.BigEndian.Uint32(p[12:]))
		if (encoding == EncodingH264 || encoding == EncodingHEVC) && c.drop.Swap(false) {
			return 0, os.ErrDeadlineExceeded
		}
	}
	return c.Conn.Write(p)
}
func startVideoDesktopSession(t *testing.T, backend connect.Backend, video connect.VideoEncoder) (net.Conn, *videoDropConnection) {
	t.Helper()
	server, client := net.Pipe()
	wrapped := &videoDropConnection{Conn: server}
	_ = client.SetDeadline(time.Now().Add(3 * time.Second))
	done := make(chan error, 1)
	go func() {
		defer server.Close()
		done <- ServeConn(context.Background(), wrapped, SessionConfig{Backend: backend, Video: video, Password: "fixture", AllowResize: true})
	}()
	t.Cleanup(func() {
		client.Close()
		select {
		case <-done:
		case <-time.After(time.Second):
			t.Error("video session did not close")
		}
	})
	completeHandshake(t, client, "fixture")
	header := readExactly(t, client, 24)
	readExactly(t, client, int(binary.BigEndian.Uint32(header[20:])))
	return client, wrapped
}
func readVideoDesktop(t *testing.T, client net.Conn, encoding int32, width, height int, flags uint32) {
	t.Helper()
	assertRead(t, client, []byte{0, 0, 0, 1})
	header := readExactly(t, client, 20)
	if int32(binary.BigEndian.Uint32(header[8:])) != encoding || int(binary.BigEndian.Uint16(header[4:])) != width || int(binary.BigEndian.Uint16(header[6:])) != height || binary.BigEndian.Uint32(header[16:]) != flags {
		t.Fatalf("video rectangle=%x, want encoding=%d size=%dx%d flags=%d", header, encoding, width, height, flags)
	}
	readExactly(t, client, int(binary.BigEndian.Uint32(header[12:])))
}

func TestVideoResetIsPerViewerAcrossDesktopAndEncoderChanges(t *testing.T) {
	t.Parallel()
	for _, encoding := range []int32{EncodingH264, EncodingHEVC} {
		t.Run(fmt.Sprint(encoding), func(t *testing.T) {
			backend := &desktopFixture{layout: fixtureLayout(8, 6)}
			encoder := new(parameterVideoFixture)
			first, _ := startVideoDesktopSession(t, backend, encoder)
			second, _ := startVideoDesktopSession(t, backend, encoder)
			viewers := []net.Conn{first, second}
			for _, viewer := range viewers {
				assertWrite(t, viewer, encodeSetEncodings([]int32{encoding, EncodingExtendedDesktopSize}))
				requestDesktopFrame(t, viewer, false, 8, 6)
				assertDesktopUpdate(t, viewer, fixtureLayout(8, 6), true, 0, 0)
				readVideoDesktop(t, viewer, encoding, 8, 6, 2)
				requestDesktopFrame(t, viewer, true, 8, 6)
				readVideoDesktop(t, viewer, encoding, 8, 6, 0)
			}
			// Change the actual capture backend through the negotiated resize request.
			assertWrite(t, first, desktopRequest(fixtureLayout(10, 8)))
			assertDesktopUpdate(t, first, fixtureLayout(10, 8), true, 1, 0)
			for index, viewer := range viewers {
				width, height := 10, 8
				if index == 1 {
					width, height = 8, 6
				}
				requestDesktopFrame(t, viewer, true, width, height)
				if index == 1 {
					assertDesktopUpdate(t, viewer, fixtureLayout(10, 8), true, 0, 0)
				}
				readVideoDesktop(t, viewer, encoding, 10, 8, 2)
				requestDesktopFrame(t, viewer, true, 10, 8)
				readVideoDesktop(t, viewer, encoding, 10, 8, 0)
			}
			// Both viewers must observe the shared encoder's changed parameter sets.
			encoder.changeContext()
			for _, viewer := range viewers {
				requestDesktopFrame(t, viewer, true, 10, 8)
				readVideoDesktop(t, viewer, encoding, 10, 8, 2)
				requestDesktopFrame(t, viewer, true, 10, 8)
				readVideoDesktop(t, viewer, encoding, 10, 8, 0)
			}
			// Same-size layout metadata also fences the first subsequent video frame.
			assertWrite(t, first, desktopRequest(fixtureLayout(10, 8)))
			assertDesktopUpdate(t, first, fixtureLayout(10, 8), true, 1, 0)
			requestDesktopFrame(t, first, true, 10, 8)
			readVideoDesktop(t, first, encoding, 10, 8, 2)
			requestDesktopFrame(t, first, true, 10, 8)
			readVideoDesktop(t, first, encoding, 10, 8, 0)
		})
	}
}

func TestDroppedVideoDoesNotConsumeDecoderReset(t *testing.T) {
	t.Parallel()
	for _, encoding := range []int32{EncodingH264, EncodingHEVC} {
		t.Run(fmt.Sprint(encoding), func(t *testing.T) {
			backend := &desktopFixture{layout: fixtureLayout(8, 6)}
			encoder := new(parameterVideoFixture)
			viewer, wire := startVideoDesktopSession(t, backend, encoder)
			assertWrite(t, viewer, encodeSetEncodings([]int32{encoding, EncodingExtendedDesktopSize}))
			wire.drop.Store(true)
			requestDesktopFrame(t, viewer, false, 8, 6)
			assertDesktopUpdate(t, viewer, fixtureLayout(8, 6), true, 0, 0)
			assertRead(t, viewer, []byte{0, 0, 0, 0})
			requestDesktopFrame(t, viewer, true, 8, 6)
			readVideoDesktop(t, viewer, encoding, 8, 6, 2)
			requestDesktopFrame(t, viewer, true, 8, 6)
			readVideoDesktop(t, viewer, encoding, 8, 6, 0)
			assertWrite(t, viewer, desktopRequest(fixtureLayout(10, 8)))
			assertDesktopUpdate(t, viewer, fixtureLayout(10, 8), true, 1, 0)
			wire.drop.Store(true)
			requestDesktopFrame(t, viewer, true, 10, 8)
			assertRead(t, viewer, []byte{0, 0, 0, 0})
			requestDesktopFrame(t, viewer, true, 10, 8)
			readVideoDesktop(t, viewer, encoding, 10, 8, 2)
			// Even unchanged geometry needs its metadata-triggered reset to
			// survive a dropped frame, independently of context comparison.
			assertWrite(t, viewer, desktopRequest(fixtureLayout(10, 8)))
			assertDesktopUpdate(t, viewer, fixtureLayout(10, 8), true, 1, 0)
			wire.drop.Store(true)
			requestDesktopFrame(t, viewer, true, 10, 8)
			assertRead(t, viewer, []byte{0, 0, 0, 0})
			requestDesktopFrame(t, viewer, true, 10, 8)
			readVideoDesktop(t, viewer, encoding, 10, 8, 2)
			// A dropped same-size encoder change also must not advance delivered state.
			encoder.changeContext()
			wire.drop.Store(true)
			requestDesktopFrame(t, viewer, true, 10, 8)
			assertRead(t, viewer, []byte{0, 0, 0, 0})
			requestDesktopFrame(t, viewer, true, 10, 8)
			readVideoDesktop(t, viewer, encoding, 10, 8, 2)
			requestDesktopFrame(t, viewer, true, 10, 8)
			readVideoDesktop(t, viewer, encoding, 10, 8, 0)
		})
	}
}

func TestVideoEncodingTransitionsResetDecoder(t *testing.T) {
	t.Parallel()
	backend := &desktopFixture{layout: fixtureLayout(8, 6)}
	viewer, _ := startVideoDesktopSession(t, backend, new(parameterVideoFixture))
	for _, encoding := range []int32{EncodingH264, EncodingHEVC, EncodingRaw, EncodingHEVC, EncodingH264} {
		assertWrite(t, viewer, encodeSetEncodings([]int32{encoding}))
		requestDesktopFrame(t, viewer, true, 8, 6)
		if encoding == EncodingRaw {
			readRawDesktop(t, viewer, 8, 6)
			continue
		}
		readVideoDesktop(t, viewer, encoding, 8, 6, 2)
		requestDesktopFrame(t, viewer, true, 8, 6)
		readVideoDesktop(t, viewer, encoding, 8, 6, 0)
	}
}

func TestVideoParameterFingerprintIgnoresFramingAndSlices(t *testing.T) {
	for _, codec := range []struct {
		name     string
		encoding int32
	}{{"h264", EncodingH264}, {"hevc", EncodingHEVC}} {
		t.Run(codec.name, func(t *testing.T) {
			encoder := new(parameterVideoFixture)
			first, _ := encoder.Encode(context.Background(), connect.Frame{}, codec.name)
			second, _ := encoder.Encode(context.Background(), connect.Frame{}, codec.name)
			second = bytes.ReplaceAll(second, []byte{0, 0, 0, 1}, []byte{0, 0, 1})
			second = append(second, 0, 0)
			if videoParameterFingerprint(first, codec.encoding) != videoParameterFingerprint(second, codec.encoding) {
				t.Fatal("slice or start-code changes reset decoder")
			}
			encoder.changeContext()
			changed, _ := encoder.Encode(context.Background(), connect.Frame{}, codec.name)
			if videoParameterFingerprint(first, codec.encoding) == videoParameterFingerprint(changed, codec.encoding) {
				t.Fatal("parameter change did not reset decoder")
			}
		})
	}
}
