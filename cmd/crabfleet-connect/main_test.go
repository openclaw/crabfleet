package main

import (
	"bytes"
	"context"
	"strings"
	"testing"
)

func TestVersion(t *testing.T) {
	t.Parallel()
	var stdout, stderr bytes.Buffer
	if err := run(context.Background(), []string{"--version"}, &stdout, &stderr); err != nil {
		t.Fatal(err)
	}
	if stdout.String() != "crabfleet-connect dev\n" || stderr.Len() != 0 {
		t.Fatalf("stdout=%q stderr=%q", stdout.String(), stderr.String())
	}
}

func TestHelpIsSuccessful(t *testing.T) {
	t.Parallel()
	var stdout, stderr bytes.Buffer
	if err := run(context.Background(), []string{"--help"}, &stdout, &stderr); err != nil {
		t.Fatal(err)
	}
	if stdout.Len() != 0 || !strings.Contains(stderr.String(), "Usage of crabfleet-connect:") {
		t.Fatalf("stdout=%q stderr=%q", stdout.String(), stderr.String())
	}
}

func TestGenerateSharePassword(t *testing.T) {
	t.Parallel()
	first, err := generateSharePassword()
	if err != nil {
		t.Fatal(err)
	}
	second, err := generateSharePassword()
	if err != nil {
		t.Fatal(err)
	}
	const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789"
	if len(first) != 8 || strings.Trim(first, alphabet) != "" || first == second {
		t.Fatalf("generated passwords %q and %q", first, second)
	}
}

func TestRejectsInvalidPort(t *testing.T) {
	t.Parallel()
	var stdout, stderr bytes.Buffer
	if err := run(context.Background(), []string{"--port", "0"}, &stdout, &stderr); err == nil {
		t.Fatal("accepted invalid port")
	}
}

func TestRejectsEmptyBindAddress(t *testing.T) {
	t.Parallel()
	var stdout, stderr bytes.Buffer
	if err := run(context.Background(), []string{"--bind="}, &stdout, &stderr); err == nil {
		t.Fatal("accepted empty bind address")
	}
}
