package fleetapi

import (
	"strings"
	"testing"
)

func TestSessionAttachableRequiresAuthoritativePTYAvailability(t *testing.T) {
	if !(Session{Status: "ready", PtyAvailable: true}).Attachable() {
		t.Fatal("ready session with an available PTY should be attachable")
	}
	for _, session := range []Session{
		{Status: "provisioning", PtyAvailable: true},
		{Status: "ready", AttachURL: "/api/terminal/ws"},
		{
			Status:       "ready",
			PtyAvailable: true,
			Capabilities: &SessionCapabilities{Terminal: false},
		},
	} {
		if session.Attachable() {
			t.Fatalf("session %#v must not be attachable", session)
		}
	}
}

func TestSessionLifecycleStopNote(t *testing.T) {
	if got := (Session{Status: "stopped"}).LifecycleStopNote(); !strings.Contains(got, "provider deletion") {
		t.Fatalf("legacy stop note = %q", got)
	}
	for _, session := range []Session{
		{Status: "failed"},
		{Status: "stopped", Adapter: "runtime-v1"},
	} {
		if got := session.LifecycleStopNote(); got != "" {
			t.Fatalf("session %#v note = %q", session, got)
		}
	}
	if got := (Session{Status: "stopped", Runtime: "github_actions"}).LifecycleStopNote(); !strings.Contains(got, "not canceled") {
		t.Fatalf("GitHub Actions note = %q", got)
	}
}

func TestSessionSummaryTextPrefersSummaryThenPurpose(t *testing.T) {
	session := Session{Summary: "summary", Purpose: "purpose", LastEvent: "event"}
	if got := session.SummaryText(); got != "summary" {
		t.Fatalf("summary = %q", got)
	}
	session.Summary = ""
	if got := session.SummaryText(); got != "purpose" {
		t.Fatalf("purpose = %q", got)
	}
	session.Purpose = ""
	if got := session.SummaryText(); got != "event" {
		t.Fatalf("event = %q", got)
	}
}
