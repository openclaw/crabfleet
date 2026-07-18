package rfb

import (
	"bytes"
	"encoding/binary"
	"encoding/hex"
	"image/jpeg"
	"io"
	"testing"

	"github.com/openclaw/crabfleet/internal/connect"
)

func TestSetEncodingsMatchesRecordedBrowserAndSwiftBytes(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name    string
		values  []int32
		fixture []byte
	}{
		{
			name: "browser client",
			values: []int32{
				0x48455631, 0x43343434, 50, 7, 0x43414631, 0x5143544c,
				-314, -232, -308, -1063131698,
			},
			fixture: mustHex("0200000a48455631433434340000003200000007434146315143544cfffffec6ffffff18fffffeccc0a1e5ce"),
		},
		{
			name: "Swift native client",
			values: []int32{
				1, 0x48455631, 0x43343434, 50, 7, 5, 0x43414631, 0x5143544c, 0,
				-224, -312, -313, -308, -223, -307, -314, -239, -232, -251,
				-1063131698, -26,
			},
			fixture: mustHex("02000015000000014845563143343434000000320000000700000005434146315143544c00000000ffffff20fffffec8fffffec7fffffeccffffff21fffffecdfffffec6ffffff11ffffff18ffffff05c0a1e5ceffffffe6"),
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			encoded := encodeSetEncodings(test.values)
			if !bytes.Equal(encoded, test.fixture) {
				t.Fatalf("recorded bytes differ\n got %x\nwant %x", encoded, test.fixture)
			}
			negotiated, err := parseSetEncodings(bytes.NewReader(encoded[1:]))
			if err != nil {
				t.Fatal(err)
			}
			if !negotiated.Tight || !negotiated.CursorWithAlpha || !negotiated.PointerPosition {
				t.Fatalf("missing negotiated capabilities: %+v", negotiated)
			}
			if test.name == "Swift native client" && !negotiated.Cursor {
				t.Fatal("classic cursor was not negotiated")
			}
		})
	}
}

func TestTightJPEGFramingRoundTrip(t *testing.T) {
	t.Parallel()
	frame := connect.Frame{
		Width:  2,
		Height: 1,
		Stride: 8,
		Pixels: []byte{255, 0, 0, 255, 0, 255, 0, 255},
	}
	payload, err := EncodeJPEG(frame, 90)
	if err != nil {
		t.Fatal(err)
	}
	rectangle, err := tightJPEGRectangle(frame.Width, frame.Height, payload)
	if err != nil {
		t.Fatal(err)
	}
	update, err := framebufferUpdate(rectangle)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(update[:17], mustHex("0000000100000000000200010000000790")) {
		t.Fatalf("unexpected Tight prefix: %x", update[:17])
	}
	length, lengthBytes := decodeCompactForTest(t, update[17:])
	if length != len(payload) {
		t.Fatalf("length = %d, want %d", length, len(payload))
	}
	decoded, err := jpeg.Decode(bytes.NewReader(update[17+lengthBytes:]))
	if err != nil {
		t.Fatal(err)
	}
	if decoded.Bounds().Dx() != 2 || decoded.Bounds().Dy() != 1 {
		t.Fatalf("decoded bounds = %v", decoded.Bounds())
	}
}

func TestTightCompactLengthGoldenBytes(t *testing.T) {
	t.Parallel()
	for length, expected := range map[int]string{
		0:         "00",
		127:       "7f",
		128:       "8001",
		16_383:    "ff7f",
		16_384:    "808001",
		4_194_303: "ffffff",
	} {
		actual, err := TightCompactLength(length)
		if err != nil {
			t.Fatal(err)
		}
		if string(actual) != string(mustHex(expected)) {
			t.Fatalf("length %d = %x", length, actual)
		}
	}
	if _, err := TightCompactLength(MaxTightJPEGLength); err == nil {
		t.Fatal("accepted oversized Tight length")
	}
}

func TestProtocolRejectsMalformedBounds(t *testing.T) {
	t.Parallel()
	tooMany := []byte{0, 1, 1}
	if _, err := parseSetEncodings(bytes.NewReader(tooMany)); err == nil {
		t.Fatal("accepted too many encodings")
	}
	outside := []byte{0, 0, 9, 0, 0, 0, 2, 0, 1}
	if _, err := parseFramebufferRequest(bytes.NewReader(outside), 10, 10); err != nil {
		t.Fatalf("oversized framebuffer request was not cropped: %v", err)
	}
	invalidFormat := append([]byte{0, 0, 0}, bgra8888...)
	invalidFormat[3] = 16
	if err := parseSetPixelFormat(bytes.NewReader(invalidFormat)); err == nil {
		t.Fatal("accepted unsupported pixel format")
	}
	nonCanonicalTrue := append([]byte{0, 0, 0}, bgra8888...)
	nonCanonicalTrue[6] = 0xff
	if err := parseSetPixelFormat(bytes.NewReader(nonCanonicalTrue)); err != nil {
		t.Fatalf("rejected nonzero true-color boolean: %v", err)
	}
}

func TestRFBBooleanFieldsAcceptAnyNonzeroValue(t *testing.T) {
	t.Parallel()
	down, keysym, err := parseKeyEvent(bytes.NewReader([]byte{0xff, 0, 0, 0, 0, 0, 65}))
	if err != nil {
		t.Fatal(err)
	}
	if !down || keysym != 65 {
		t.Fatalf("key event = %v, %d", down, keysym)
	}
}

func TestClientCutTextIsConsumedWithStrictBounds(t *testing.T) {
	t.Parallel()
	legacy := append([]byte{0, 0, 0, 0, 0, 0, 3}, []byte("abc")...)
	legacy = append(legacy, 0xaa)
	reader := bytes.NewReader(legacy)
	if err := consumeClientCutText(reader); err != nil {
		t.Fatal(err)
	}
	remaining, err := io.ReadAll(reader)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(remaining, []byte{0xaa}) {
		t.Fatalf("remaining bytes = %x", remaining)
	}

	extended := []byte{0, 0, 0, 0xff, 0xff, 0xff, 0xfc, 0, 0, 0, 1, 0xbb}
	reader = bytes.NewReader(extended)
	if err := consumeClientCutText(reader); err != nil {
		t.Fatal(err)
	}
	remaining, err = io.ReadAll(reader)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(remaining, []byte{0xbb}) {
		t.Fatalf("remaining extended bytes = %x", remaining)
	}

	oversized := []byte{0, 0, 0, 0, 0x10, 0, 1}
	if err := consumeClientCutText(bytes.NewReader(oversized)); err == nil {
		t.Fatal("accepted oversized clipboard payload")
	}
}

func TestCursorShapeComparisonDetectsVisibilityAndPixels(t *testing.T) {
	t.Parallel()
	first := connect.Cursor{Visible: true, Width: 1, Height: 1, RGBA: []byte{1, 1, 1, 1}}
	second := first
	second.RGBA = append([]byte(nil), first.RGBA...)
	if !sameCursorShape(first, second) {
		t.Fatal("equal cursor shapes differ")
	}
	second.Visible = false
	if sameCursorShape(first, second) {
		t.Fatal("cursor visibility change was ignored")
	}
	second = first
	second.RGBA = []byte{0, 0, 0, 0}
	if sameCursorShape(first, second) {
		t.Fatal("cursor pixel change was ignored")
	}
}

func encodeSetEncodings(values []int32) []byte {
	result := make([]byte, 4+len(values)*4)
	result[0] = 2
	binary.BigEndian.PutUint16(result[2:], uint16(len(values)))
	for index, value := range values {
		binary.BigEndian.PutUint32(result[4+index*4:], uint32(value))
	}
	return result
}

func decodeCompactForTest(t *testing.T, bytes []byte) (int, int) {
	t.Helper()
	result := int(bytes[0] & 0x7f)
	if bytes[0]&0x80 == 0 {
		return result, 1
	}
	result |= int(bytes[1]&0x7f) << 7
	if bytes[1]&0x80 == 0 {
		return result, 2
	}
	return result | int(bytes[2])<<14, 3
}

func mustHex(value string) []byte {
	result, err := hex.DecodeString(value)
	if err != nil {
		panic(err)
	}
	return result
}
