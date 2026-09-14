//go:build linux

package connector

import (
	"os"
	"path/filepath"
	"testing"
)

func TestStateIsPrivateAtomicAndExclusive(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "connector")
	store, err := OpenStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	state, err := store.Load()
	if err != nil {
		t.Fatal(err)
	}
	state.AccessToken = "fixture-secret"
	if err := store.Save(state); err != nil {
		t.Fatal(err)
	}
	if second, err := OpenStore(dir); err == nil {
		_ = second.Close()
		t.Fatal("two publishers obtained the state lock")
	}
	loaded, err := ReadState(dir)
	if err != nil || loaded.AccessToken != state.AccessToken {
		t.Fatal("state did not persist")
	}
	info, _ := os.Stat(filepath.Join(dir, "state.json"))
	if info.Mode().Perm() != 0600 {
		t.Fatal("state was not private")
	}
	if err := os.Chmod(filepath.Join(dir, "state.json"), 0644); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Load(); err == nil {
		t.Fatal("read non-private credentials")
	}
}
