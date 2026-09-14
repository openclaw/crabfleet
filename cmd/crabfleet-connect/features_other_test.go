//go:build !linux

package main

import (
	"context"
	"io"
	"strings"
	"testing"
)

func TestNonLinuxRejectsQuietWithoutPasswordStorage(t *testing.T) {
	cleanup, err := configureFeatures(context.Background(), "synthetic", &shareOptions{quiet: true}, featureOptions{video: "auto"}, io.Discard)
	if cleanup != nil {
		cleanup()
	}
	if err == nil || !strings.Contains(err.Error(), "--quiet requires Linux password storage") {
		t.Fatalf("unsupported quiet share: %v", err)
	}
}
