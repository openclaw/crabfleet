package fleettext

import (
	"bytes"
	"strings"
	"testing"

	"github.com/openclaw/crabfleet/internal/fleetapi"
)

func TestWriteSessionGroupsShowsOwnerTreesAndSummaries(t *testing.T) {
	var out bytes.Buffer
	written := WriteSessionGroups(&out, []fleetapi.Session{
		{
			ID:              "IS-2",
			Owner:           "steipete",
			Repo:            "openclaw/crabfleet",
			Runtime:         "container",
			Status:          "ready",
			Summary:         "child mission",
			ParentSessionID: "IS-1",
		},
		{
			ID:      "IS-1",
			Owner:   "steipete",
			Repo:    "openclaw/crabfleet",
			Runtime: "container",
			Status:  "ready",
			Purpose: "root mission",
		},
	}, "  ")
	if !written {
		t.Fatal("expected sessions to be written")
	}
	for _, want := range []string{
		"  steipete:",
		"    IS-1  ready  container  openclaw/crabfleet  - root mission",
		"      IS-2  ready  container  openclaw/crabfleet  - child mission",
	} {
		if !strings.Contains(out.String(), want) {
			t.Fatalf("output missing %q:\n%s", want, out.String())
		}
	}
}

func TestSafeRemovesTerminalControlCharacters(t *testing.T) {
	if got, want := Safe("hello\nworld\x1b"), "hello world"; got != want {
		t.Fatalf("safe = %q, want %q", got, want)
	}
}
