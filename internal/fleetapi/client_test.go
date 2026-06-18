package fleetapi

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestClientUsesSSHAuthentication(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/ssh/state" {
			t.Errorf("path = %q", r.URL.Path)
		}
		if got := r.Header.Get("Authorization"); got != "Bearer gateway-token" {
			t.Errorf("authorization = %q", got)
		}
		if got := r.Header.Get("X-Crabfleet-SSH-Fingerprint"); got != "SHA256:test" {
			t.Errorf("fingerprint = %q", got)
		}
		_, _ = w.Write([]byte(`{"user":{"login":"operator"}}`))
	}))
	defer server.Close()

	client := NewClient(server.URL, server.Client(), SSHAuth("gateway-token", "SHA256:test"))
	state, err := client.State(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if state.User.Login != "operator" {
		t.Fatalf("login = %q", state.User.Login)
	}
}

func TestClientRoutesAgentAuthentication(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/agent/interactive-sessions/IS-7" {
			t.Errorf("path = %q", r.URL.Path)
		}
		if got := r.Header.Get("Authorization"); got != "Bearer agent-token" {
			t.Errorf("authorization = %q", got)
		}
		if got := r.Header.Get("X-Crabfleet-Session-ID"); got != "IS-parent" {
			t.Errorf("session id = %q", got)
		}
		_, _ = w.Write([]byte(`{"session":{"id":"IS-7"}}`))
	}))
	defer server.Close()

	client := NewClient(server.URL, server.Client(), AgentAuth("agent-token", "IS-parent"))
	session, err := client.Session(context.Background(), "IS-7")
	if err != nil {
		t.Fatal(err)
	}
	if session.ID != "IS-7" {
		t.Fatalf("session id = %q", session.ID)
	}
}

func TestClientRejectsIncompleteAuthentication(t *testing.T) {
	client := NewClient("https://example.com", http.DefaultClient, SSHAuth("token", ""))
	_, err := client.State(context.Background())
	if err == nil || !strings.Contains(err.Error(), "requires SSH gateway token") {
		t.Fatalf("error = %v", err)
	}
}

func TestClientStreamsLargeJSONResponses(t *testing.T) {
	largeLogin := strings.Repeat("a", maxResponseBytes+1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"user":{"login":"`))
		_, _ = w.Write([]byte(largeLogin))
		_, _ = w.Write([]byte(`"}}`))
	}))
	defer server.Close()

	client := NewClient(server.URL, server.Client(), SSHAuth("gateway-token", "SHA256:test"))
	state, err := client.State(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if state.User.Login != largeLogin {
		t.Fatalf("login length = %d, want %d", len(state.User.Login), len(largeLogin))
	}
}

func TestClientRejectsOversizedTranscript(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/ssh/interactive-sessions/IS-7/transcript" {
			t.Errorf("path = %q", r.URL.Path)
		}
		w.Header().Set("Content-Type", "text/markdown")
		_, _ = w.Write([]byte(strings.Repeat("a", maxResponseBytes+1)))
	}))
	defer server.Close()

	client := NewClient(server.URL, server.Client(), SSHAuth("gateway-token", "SHA256:test"))
	transcript, err := client.Transcript(context.Background(), "IS-7")
	if err == nil || !strings.Contains(err.Error(), "response exceeds") {
		t.Fatalf("error = %v", err)
	}
	if transcript != "" {
		t.Fatalf("transcript length = %d, want empty", len(transcript))
	}
}
