package connector

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"sync"
)

type State struct {
	Version        int    `json:"version"`
	Server         string `json:"server,omitempty"`
	AccessToken    string `json:"accessToken,omitempty"`
	ExpiresAt      int64  `json:"expiresAt,omitempty"`
	HostID         string `json:"hostId"`
	PublicationID  string `json:"publicationId,omitempty"`
	OwnershipToken string `json:"ownershipToken,omitempty"`
	RestoreToken   string `json:"restoreToken,omitempty"`
	DirectPassword string `json:"directPassword,omitempty"`
}
type Store struct {
	path string
	mu   sync.Mutex
	lock *os.File
}

func DefaultDirectory() (string, error) {
	dir, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "crabfleet-connect"), nil
}
func OpenStore(directory string) (*Store, error) {
	if !filepath.IsAbs(directory) {
		return nil, errors.New("configuration directory must be absolute")
	}
	if err := os.MkdirAll(directory, 0700); err != nil {
		return nil, err
	}
	info, err := os.Lstat(directory)
	if err != nil {
		return nil, err
	}
	if !info.IsDir() || info.Mode().Perm()&0077 != 0 {
		return nil, errors.New("connector configuration directory must be private (mode 0700)")
	}
	lock, err := lockStore(directory)
	if err != nil {
		return nil, err
	}
	return &Store{path: filepath.Join(directory, "state.json"), lock: lock}, nil
}
func (s *Store) Close() error { return s.lock.Close() }

func ReadState(directory string) (State, error) {
	return (&Store{path: filepath.Join(directory, "state.json")}).Load()
}
func (s *Store) Load() (State, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var state State
	info, err := os.Lstat(s.path)
	if os.IsNotExist(err) {
		id, err := RandomID()
		return State{Version: 1, HostID: "linux-" + id}, err
	}
	if err != nil {
		return state, err
	}
	if !info.Mode().IsRegular() || info.Mode().Perm()&0077 != 0 || info.Size() > 16<<10 {
		return state, errors.New("connector state must be a private regular file (mode 0600)")
	}
	f, err := os.Open(s.path)
	if err != nil {
		return state, err
	}
	defer f.Close()
	if err := json.NewDecoder(io.LimitReader(f, 16<<10)).Decode(&state); err != nil {
		return state, errors.New("invalid connector state")
	}
	if state.Version != 1 || state.HostID == "" {
		return state, errors.New("unsupported connector state")
	}
	return state, nil
}
func (s *Store) Save(state State) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	p, err := json.MarshalIndent(state, "", "  ")
	if err != nil {
		return err
	}
	if len(p) > 16<<10 {
		return errors.New("connector state too large")
	}
	f, err := os.CreateTemp(filepath.Dir(s.path), ".state-")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	defer f.Close()
	if _, err = f.Write(append(p, '\n')); err != nil {
		return err
	}
	if err = f.Sync(); err != nil {
		return err
	}
	if err = f.Close(); err != nil {
		return err
	}
	if err = os.Rename(f.Name(), s.path); err != nil {
		return err
	}
	dir, err := os.Open(filepath.Dir(s.path))
	if err != nil {
		return err
	}
	defer dir.Close()
	return dir.Sync()
}
func RandomID() (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(b[:]), nil
}
