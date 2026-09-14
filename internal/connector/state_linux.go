//go:build linux

package connector

import (
	"errors"
	"os"
	"path/filepath"

	"golang.org/x/sys/unix"
)

func lockStore(directory string) (*os.File, error) {
	fd, err := unix.Open(filepath.Join(directory, "state.lock"), unix.O_CLOEXEC|unix.O_NOFOLLOW|unix.O_CREAT|unix.O_RDWR, 0600)
	if err != nil {
		return nil, err
	}
	f := os.NewFile(uintptr(fd), "connector-state-lock")
	if err := unix.Flock(fd, unix.LOCK_EX|unix.LOCK_NB); err != nil {
		_ = f.Close()
		return nil, errors.New("another connector command is running; stop sharing before changing sign-in")
	}
	return f, nil
}
