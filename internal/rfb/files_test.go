package rfb

import (
	"bytes"
	"context"
	"encoding/binary"
	"net"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/openclaw/crabfleet/internal/connect"
)

func fileRequest(kind byte, id uint32, name string) []byte {
	p := binary.BigEndian.AppendUint32([]byte{kind, 0, 0}, id)
	if kind == 1 || kind == 2 || kind == 3 || kind == 6 {
		p = appendText(p, name)
	}
	return p
}

func TestSharedFolderSurvivesCodecRenegotiation(t *testing.T) {
	t.Parallel()
	backend, err := connect.NewSynthetic(connect.SyntheticOptions{Width: 4, Height: 4})
	if err != nil {
		t.Fatal(err)
	}
	defer backend.Close()
	folder, err := OpenSharedFolder(t.TempDir(), false)
	if err != nil {
		t.Fatal(err)
	}
	defer folder.Close()
	server, client := net.Pipe()
	defer server.Close()
	defer client.Close()
	_ = client.SetDeadline(time.Now().Add(3 * time.Second))
	done := make(chan error, 1)
	go func() {
		done <- ServeConn(context.Background(), server, SessionConfig{
			Backend: backend, Password: "fixture", SharedFolder: folder,
			HandshakeTimeout: time.Second, MediaTimeout: time.Second,
		})
	}()
	completeHandshake(t, client, "fixture")
	init := readExactly(t, client, 24)
	_ = readExactly(t, client, int(binary.BigEndian.Uint32(init[20:])))
	assertWrite(t, client, encodeSetEncodings([]int32{EncodingH264, EncodingTight, EncodingFileSharing}))
	header := readExactly(t, client, 6)
	if !bytes.Equal(header[:4], []byte{202, 1, 0, 0}) {
		t.Fatalf("file capability = %v", header)
	}
	_ = readExactly(t, client, int(binary.BigEndian.Uint16(header[4:])))
	assertWrite(t, client, encodeSetEncodings([]int32{EncodingTight, EncodingFileSharing}))
	assertWrite(t, client, append([]byte{202}, fileRequest(1, 7, "")...))
	// Codec fallback must not send a second capability before this list response.
	assertRead(t, client, []byte{202, 2, 0, 0, 0, 0, 0, 7, 0, 0})
	_ = client.Close()
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("file-sharing session did not stop")
	}
}
func TestSharedFolderUploadDownloadAndAbort(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	folder, err := OpenSharedFolder(dir, true)
	if err != nil {
		t.Fatal(err)
	}
	defer folder.Close()
	s := &fileSession{folder: folder}
	defer s.close()
	call := func(request []byte) []byte {
		t.Helper()
		p, err := s.handle(bytes.NewReader(request))
		if err != nil {
			t.Fatal(err)
		}
		if p[1] == 255 {
			t.Fatalf("file operation failed: %q", p)
		}
		return p
	}
	call(binary.BigEndian.AppendUint64(fileRequest(3, 7, "hello.txt"), 5))
	if _, err := os.Stat(filepath.Join(dir, "hello.txt")); !os.IsNotExist(err) {
		t.Fatal("incomplete upload was visible")
	}
	call(append(binary.BigEndian.AppendUint32(fileRequest(4, 7, ""), 5), []byte("hello")...))
	call(fileRequest(5, 7, ""))
	p := call(binary.BigEndian.AppendUint32(binary.BigEndian.AppendUint64(fileRequest(2, 9, "hello.txt"), 1), 3))
	if string(p[20:]) != "ell" || p[3] != 0 || binary.BigEndian.Uint64(p[8:]) != 1 {
		t.Fatalf("invalid download: %v", p)
	}
	p = call(binary.BigEndian.AppendUint32(binary.BigEndian.AppendUint64(fileRequest(2, 10, "hello.txt"), 4), 3))
	if string(p[20:]) != "o" || p[3] != 1 {
		t.Fatal("EOF not reported")
	}
	call(binary.BigEndian.AppendUint64(fileRequest(3, 8, "cancel.txt"), 100))
	call(fileRequest(7, 8, ""))
	entries, _ := os.ReadDir(dir)
	if len(entries) != 1 {
		t.Fatalf("temporary files leaked: %v", entries)
	}
	p = call(fileRequest(1, 11, ""))
	if binary.BigEndian.Uint16(p[8:]) != 1 {
		t.Fatal("listing omitted completed file")
	}
}
func TestSharedFolderBoundariesAndNoOverwrite(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	outside := t.TempDir()
	if err := os.WriteFile(filepath.Join(outside, "secret"), []byte("private"), 0600); err != nil {
		t.Fatal(err)
	}
	folder, err := OpenSharedFolder(dir, true)
	if err != nil {
		t.Fatal(err)
	}
	defer folder.Close()
	s := &fileSession{folder: folder}
	defer s.close()
	if err := os.Symlink(outside, filepath.Join(dir, "escape")); err != nil {
		t.Skip("symlinks unavailable")
	}
	for _, name := range []string{"../secret", "/secret", "escape/secret", "a/../../secret", "a\\secret", uploadPrefix + "hidden"} {
		p, err := s.handle(bytes.NewReader(binary.BigEndian.AppendUint32(binary.BigEndian.AppendUint64(fileRequest(2, 1, name), 0), 32)))
		if err != nil {
			t.Fatal(err)
		}
		if p[1] != 255 || bytes.Contains(p, []byte(outside)) || bytes.Contains(p, []byte("private")) {
			t.Fatalf("unsafe path response for %q", name)
		}
	}
	if err := os.WriteFile(filepath.Join(dir, "keep"), []byte("original"), 0600); err != nil {
		t.Fatal(err)
	}
	_, err = s.handle(bytes.NewReader(binary.BigEndian.AppendUint64(fileRequest(3, 2, "keep"), 0)))
	if err != nil {
		t.Fatal(err)
	}
	p, err := s.handle(bytes.NewReader(fileRequest(5, 2, "")))
	if err != nil || p[1] != 255 {
		t.Fatal("overwrote existing file")
	}
	got, _ := os.ReadFile(filepath.Join(dir, "keep"))
	if string(got) != "original" {
		t.Fatal("existing file changed")
	}
	s.viewOnly = true
	p, err = s.handle(bytes.NewReader(fileRequest(6, 3, "forbidden")))
	if err != nil || p[1] != 255 {
		t.Fatal("view-only session wrote a folder")
	}
	if _, err := s.handle(bytes.NewReader(binary.BigEndian.AppendUint32(fileRequest(4, 1, ""), maxFileChunk+1))); err == nil {
		t.Fatal("accepted oversized chunk")
	}
}
