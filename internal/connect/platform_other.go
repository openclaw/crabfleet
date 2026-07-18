//go:build !linux

package connect

import "errors"

func NewPlatformBackend(string) (Backend, error) {
	return nil, errors.New("no native capture backend is available on this platform")
}
