//go:build !linux

package main

import (
	"context"
	"errors"
	"io"
	"net"
)

func serveWayland(context.Context, net.Listener, shareOptions, string, string, io.Writer) error {
	return errors.New("the Wayland backend is only available on Linux")
}
