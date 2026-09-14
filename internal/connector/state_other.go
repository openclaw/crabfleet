//go:build !linux

package connector

import (
	"errors"
	"os"
)

func lockStore(string) (*os.File, error) {
	return nil, errors.New("Fleet connector state is supported on Linux")
}
