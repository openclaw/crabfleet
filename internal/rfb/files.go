package rfb

import (
	"crypto/rand"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"io"
	"io/fs"
	"os"
	"path"
	"sort"
	"strings"
	"unicode/utf8"
)

const (
	EncodingFileSharing int32 = 0x46534831
	maxFileBytes              = 512 << 20
	maxFileChunk              = 256 << 10
	maxFileEntries            = 1024
	uploadPrefix              = ".crabfleet-upload-"
)

// SharedFolder pins an explicitly selected directory. All client paths are
// resolved by os.Root, including symlinks and concurrent directory renames.
type SharedFolder struct {
	root        *os.Root
	Name        string
	AllowWrites bool
}

func OpenSharedFolder(directory string, allowWrites bool) (*SharedFolder, error) {
	r, err := os.OpenRoot(directory)
	if err != nil {
		return nil, err
	}
	name := path.Base(strings.ReplaceAll(directory, "\\", "/"))
	if name == "." || name == "/" || name == "" {
		name = "Shared folder"
	}
	if len(name) > 4096 || !utf8.ValidString(name) {
		_ = r.Close()
		return nil, errors.New("invalid shared folder name")
	}
	return &SharedFolder{root: r, Name: name, AllowWrites: allowWrites}, nil
}
func (f *SharedFolder) Close() error { return f.root.Close() }
func (f *SharedFolder) capability(viewOnly bool) []byte {
	p := []byte{202, 1, 0, 0}
	if f.AllowWrites && !viewOnly {
		p[2] = 1
	}
	return appendText(p, f.Name)
}

type upload struct {
	file              *os.File
	temporary, target string
	size, written     uint64
	id                uint32
}
type fileSession struct {
	folder   *SharedFolder
	viewOnly bool
	upload   *upload
}

func (s *fileSession) close() {
	if s.upload != nil {
		_ = s.upload.file.Close()
		_ = s.folder.root.Remove(s.upload.temporary)
		s.upload = nil
	}
}
func (s *fileSession) handle(r io.Reader) ([]byte, error) {
	var header [7]byte
	if _, err := io.ReadFull(r, header[:]); err != nil {
		return nil, err
	}
	kind, id := header[0], binary.BigEndian.Uint32(header[3:])
	if header[1] != 0 || header[2] != 0 || kind < 1 || kind > 7 {
		return nil, errors.New("invalid FSH1 request")
	}
	var name string
	var offset, size uint64
	var length uint32
	var chunk []byte
	var pathErr error
	if kind == 1 || kind == 2 || kind == 3 || kind == 6 {
		var n [2]byte
		if _, err := io.ReadFull(r, n[:]); err != nil {
			return nil, err
		}
		if binary.BigEndian.Uint16(n[:]) > 4096 {
			return nil, errors.New("FSH1 path too long")
		}
		p := make([]byte, int(binary.BigEndian.Uint16(n[:])))
		if _, err := io.ReadFull(r, p); err != nil {
			return nil, err
		}
		name = string(p)
		if name == "" {
			name = "."
		}
		if !validFilePath(name) {
			pathErr = errors.New("invalid relative path")
		}
	}
	if kind == 2 {
		var p [12]byte
		if _, err := io.ReadFull(r, p[:]); err != nil {
			return nil, err
		}
		offset = binary.BigEndian.Uint64(p[:])
		length = binary.BigEndian.Uint32(p[8:])
		if offset > maxFileBytes || length == 0 || length > maxFileChunk {
			return nil, errors.New("invalid FSH1 download bounds")
		}
	}
	if kind == 3 {
		var p [8]byte
		if _, err := io.ReadFull(r, p[:]); err != nil {
			return nil, err
		}
		size = binary.BigEndian.Uint64(p[:])
		if size > maxFileBytes {
			return nil, errors.New("FSH1 file too large")
		}
	}
	if kind == 4 {
		var p [4]byte
		if _, err := io.ReadFull(r, p[:]); err != nil {
			return nil, err
		}
		length = binary.BigEndian.Uint32(p[:])
		if length == 0 || length > maxFileChunk {
			return nil, errors.New("invalid FSH1 upload chunk")
		}
		chunk = make([]byte, int(length))
		if _, err := io.ReadFull(r, chunk); err != nil {
			return nil, err
		}
	}
	if pathErr != nil {
		return fileError(id, "Invalid relative path."), nil
	}
	if s.folder == nil {
		return nil, errors.New("file sharing is unavailable")
	}
	if kind >= 3 && (!s.folder.AllowWrites || s.viewOnly) {
		return fileError(id, "This shared folder is read only."), nil
	}
	response, err := s.execute(kind, id, name, offset, size, length, chunk)
	if err != nil {
		if s.upload != nil && s.upload.id == id {
			s.close()
		}
		// Filesystem errors contain local paths; expose only a stable public reason.
		message := "File operation failed."
		if errors.Is(err, fs.ErrNotExist) {
			message = "File not found."
		}
		if errors.Is(err, fs.ErrExist) {
			message = "A file with this name already exists."
		}
		if errors.Is(err, fs.ErrPermission) {
			message = "Permission denied."
		}
		return fileError(id, message), nil
	}
	return response, nil
}
func (s *fileSession) execute(kind byte, id uint32, name string, offset, size uint64, length uint32, chunk []byte) ([]byte, error) {
	r := s.folder.root
	switch kind {
	case 1:
		f, err := r.OpenFile(name, os.O_RDONLY|fileNonblock, 0)
		if err != nil {
			return nil, err
		}
		defer f.Close()
		info, err := f.Stat()
		if err != nil {
			return nil, err
		}
		if !info.IsDir() {
			return nil, errors.New("not a directory")
		}
		entries, err := f.ReadDir(maxFileEntries + 1)
		if err != nil && !errors.Is(err, io.EOF) {
			return nil, err
		}
		if len(entries) > maxFileEntries {
			return nil, errors.New("too many entries")
		}
		sort.Slice(entries, func(i, j int) bool { return entries[i].Name() < entries[j].Name() })
		p := fileHeader(2, id)
		p = append(p, 0, 0)
		count := uint16(0)
		for _, entry := range entries {
			if strings.HasPrefix(entry.Name(), uploadPrefix) || !validFilePath(entry.Name()) {
				continue
			}
			info, err := entry.Info()
			if err != nil {
				continue
			}
			if !info.Mode().IsRegular() && !info.IsDir() {
				continue
			}
			if info.Size() < 0 || info.Size() > maxFileBytes {
				continue
			}
			p = appendText(p, entry.Name())
			metadata := make([]byte, 20)
			if info.IsDir() {
				metadata[0] = 1
			} else {
				binary.BigEndian.PutUint64(metadata[4:], uint64(info.Size()))
			}
			binary.BigEndian.PutUint64(metadata[12:], uint64(max(0, info.ModTime().UnixMilli())))
			p = append(p, metadata...)
			count++
		}
		binary.BigEndian.PutUint16(p[8:], count)
		return p, nil
	case 2:
		f, err := r.OpenFile(name, os.O_RDONLY|fileNonblock, 0)
		if err != nil {
			return nil, err
		}
		defer f.Close()
		info, err := f.Stat()
		if err != nil {
			return nil, err
		}
		if !info.Mode().IsRegular() || info.Size() < 0 || info.Size() > maxFileBytes || offset > uint64(info.Size()) {
			return nil, errors.New("invalid file")
		}
		data := make([]byte, min(uint64(length), uint64(info.Size())-offset))
		n, err := f.ReadAt(data, int64(offset))
		if err != nil && !errors.Is(err, io.EOF) {
			return nil, err
		}
		data = data[:n]
		p := fileHeader(3, id)
		if offset+uint64(n) >= uint64(info.Size()) {
			p[3] = 1
		}
		p = binary.BigEndian.AppendUint64(p, offset)
		p = binary.BigEndian.AppendUint32(p, uint32(n))
		return append(p, data...), nil
	case 3:
		if s.upload != nil {
			return nil, errors.New("upload already active")
		}
		var nonce [16]byte
		if _, err := rand.Read(nonce[:]); err != nil {
			return nil, err
		}
		temporary := path.Join(path.Dir(name), uploadPrefix+hex.EncodeToString(nonce[:]))
		f, err := r.OpenFile(temporary, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
		if err != nil {
			return nil, err
		}
		s.upload = &upload{file: f, temporary: temporary, target: name, size: size, id: id}
	case 4:
		u := s.upload
		if u == nil || u.id != id || uint64(len(chunk)) > u.size-u.written {
			return nil, errors.New("invalid upload")
		}
		if err := writeFull(u.file, chunk); err != nil {
			return nil, err
		}
		u.written += uint64(len(chunk))
	case 5:
		u := s.upload
		if u == nil || u.id != id || u.written != u.size {
			return nil, errors.New("incomplete upload")
		}
		if err := u.file.Sync(); err != nil {
			return nil, err
		}
		if err := u.file.Close(); err != nil {
			return nil, err
		}
		// Link publishes atomically without overwriting an existing destination.
		if err := r.Link(u.temporary, u.target); err != nil {
			return nil, err
		}
		s.close()
	case 6:
		if err := r.Mkdir(name, 0700); err != nil {
			return nil, err
		}
	case 7:
		if s.upload == nil || s.upload.id != id {
			return nil, errors.New("unknown upload")
		}
		s.close()
	}
	p := fileHeader(4, id)
	p[3] = kind
	return append(p, 0, 0), nil
}
func validFilePath(name string) bool {
	if len(name) > 4096 || !utf8.ValidString(name) || strings.ContainsAny(name, "\\\x00\r\n") || !fs.ValidPath(name) {
		return false
	}
	for _, part := range strings.Split(name, "/") {
		if strings.HasPrefix(part, uploadPrefix) {
			return false
		}
	}
	return true
}
func fileHeader(kind byte, id uint32) []byte {
	return binary.BigEndian.AppendUint32([]byte{202, kind, 0, 0}, id)
}
func appendText(p []byte, s string) []byte {
	p = binary.BigEndian.AppendUint16(p, uint16(len(s)))
	return append(p, s...)
}
func fileError(id uint32, message string) []byte {
	p := fileHeader(255, id)
	p[2] = 1
	return appendText(p, message)
}
