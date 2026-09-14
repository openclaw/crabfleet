package rfb

import (
	"bytes"
	"compress/zlib"
	"context"
	"encoding/binary"
	"strings"
	"testing"
)

type fixtureClipboard struct{ text string }

func (c *fixtureClipboard) ReadClipboard(context.Context) (string, error) { return c.text, nil }
func (c *fixtureClipboard) WriteClipboard(_ context.Context, text string) error {
	c.text = text
	return nil
}
func TestClipboardUnicodeNegotiationAndViewOnly(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	source := &fixtureClipboard{text: "private initial clipboard"}
	s := clipboardSession{source: source, extended: true}
	if p, _ := s.poll(ctx); p != nil {
		t.Fatal("exported preexisting clipboard without a change")
	}
	if s.last != "" {
		t.Fatal("preexisting clipboard can be requested by the viewer")
	}
	peer := clipboardSession{last: "Hello 🦞\nΚαλημέρα", peerMaximum: maxLegacyClipboardBytes}
	message, err := peer.provide()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.receive(ctx, bytes.NewReader(message[1:])); err != nil {
		t.Fatal(err)
	}
	if source.text != peer.last {
		t.Fatal("UTF-8 clipboard did not round trip")
	}
	s.viewOnly = true
	peer.last = "remote overwrite"
	message, _ = peer.provide()
	if _, err := s.receive(ctx, bytes.NewReader(message[1:])); err != nil {
		t.Fatal(err)
	}
	if source.text == peer.last {
		t.Fatal("view-only clipboard wrote locally")
	}
	s.extended = false
	if _, err := s.receive(ctx, bytes.NewReader(message[1:])); err == nil {
		t.Fatal("accepted unnegotiated extended clipboard")
	}
}
func TestClipboardRejectsOversizedInflation(t *testing.T) {
	t.Parallel()
	peer := clipboardSession{last: strings.Repeat("x", maxLegacyClipboardBytes-1), peerMaximum: maxLegacyClipboardBytes}
	message, err := peer.provide()
	if err != nil {
		t.Fatal(err)
	}
	s := clipboardSession{extended: true, source: &fixtureClipboard{}}
	if _, err := s.receive(context.Background(), bytes.NewReader(message[1:])); err != nil {
		t.Fatal(err)
	}
	bad := make([]byte, 7)
	binary.BigEndian.PutUint32(bad[3:], 0x80000000)
	if _, err := s.receive(context.Background(), bytes.NewReader(bad)); err == nil {
		t.Fatal("accepted huge declared clipboard")
	}
	var compressed bytes.Buffer
	w := zlib.NewWriter(&compressed)
	_, _ = w.Write(binary.BigEndian.AppendUint32(nil, uint32(maxLegacyClipboardBytes+1)))
	_, _ = w.Write(bytes.Repeat([]byte{'x'}, maxLegacyClipboardBytes))
	_, _ = w.Write([]byte{0})
	_ = w.Close()
	message = clipboardFrame(append(binary.BigEndian.AppendUint32(nil, clipboardProvide|clipboardText), compressed.Bytes()...), true)
	if _, err := s.receive(context.Background(), bytes.NewReader(message[1:])); err == nil {
		t.Fatal("accepted compressed clipboard exceeding the inflated limit")
	}
}
