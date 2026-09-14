//go:build !linux

package main

import (
	"context"
	"errors"
	"io"
	"net"
)

func platformBackendSelection(selected string) string { return selected }
func configureFeatures(_ context.Context, _ string, options *shareOptions, features featureOptions, _ io.Writer) (func(), error) {
	if options.quiet {
		return nil, errors.New("--quiet requires Linux password storage")
	}
	if features.audio || features.fleet || features.folder != "" || features.video != "auto" {
		return nil, errors.New("these connector features require Linux")
	}
	return func() {}, nil
}
func servePortal(context.Context, net.Listener, shareOptions, string, string, io.Writer) error {
	return errors.New("desktop portals require Linux")
}
func runPlatformCommand(context.Context, []string, io.Writer, io.Writer) error {
	return errors.New("connector account and service commands require Linux")
}
