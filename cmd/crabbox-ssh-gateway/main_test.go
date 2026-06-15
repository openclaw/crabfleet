package main

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	"github.com/openclaw/crabfleet/internal/fleetapi"
	"golang.org/x/crypto/ssh"
)

func TestSplitCommandKeepsQuotedValues(t *testing.T) {
	args, err := splitCommand(`new --repo openclaw/crabfleet --command 'codex --yolo' 'fix the failing check'`)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{
		"new",
		"--repo",
		"openclaw/crabfleet",
		"--command",
		"codex --yolo",
		"fix the failing check",
	}
	if !reflect.DeepEqual(args, want) {
		t.Fatalf("args = %#v, want %#v", args, want)
	}
}

func TestSessionPTYPublishesLatestLiveResize(t *testing.T) {
	pty := sessionPTY{
		cols:    120,
		rows:    34,
		resizes: make(chan fleetapi.TerminalSize, 1),
	}
	pty.resize(100, 40, false)
	select {
	case size := <-pty.resizes:
		t.Fatalf("resize published before attach: %#v", size)
	default:
	}

	pty.resize(132, 43, true)
	pty.resize(144, 50, true)
	if size := <-pty.resizes; size != (fleetapi.TerminalSize{Cols: 144, Rows: 50}) {
		t.Fatalf("resize = %#v", size)
	}
}

func TestSplitCommandPreservesBackslashesInSingleQuotes(t *testing.T) {
	args, err := splitCommand(`new 'fix regex \d+ in parser'`)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"new", `fix regex \d+ in parser`}
	if !reflect.DeepEqual(args, want) {
		t.Fatalf("args = %#v, want %#v", args, want)
	}
}

func TestParseCreateKeepsLineageAndSummaryFlags(t *testing.T) {
	create := parseCreate(
		[]string{
			"--repo", "openclaw/crabfleet",
			"--parent", "IS-1",
			"--root", "IS-root",
			"--purpose", "inspect sibling",
			"--summary", "summary text",
			"continue work",
		},
		nil,
	)
	if got, want := create.request.ParentSessionID, "IS-1"; got != want {
		t.Fatalf("parent = %q, want %q", got, want)
	}
	if got, want := create.request.RootSessionID, "IS-root"; got != want {
		t.Fatalf("root = %q, want %q", got, want)
	}
	if got, want := create.request.Purpose, "inspect sibling"; got != want {
		t.Fatalf("purpose = %q, want %q", got, want)
	}
	if got, want := create.request.Summary, "summary text"; got != want {
		t.Fatalf("summary = %q, want %q", got, want)
	}
	if got, want := create.request.Prompt, "continue work"; got != want {
		t.Fatalf("prompt = %q, want %q", got, want)
	}
}

func TestParseMessageKeepsNoEnterAndText(t *testing.T) {
	message := parseMessage([]string{"--no-enter", "hello", "child"})
	if !message.noEnter {
		t.Fatal("expected no-enter")
	}
	if got, want := message.text, "hello child"; got != want {
		t.Fatalf("text = %q, want %q", got, want)
	}
}

func TestParseCreateLeavesRuntimeToDeploymentDefault(t *testing.T) {
	create := parseCreate([]string{"--repo", "openclaw/crabfleet", "fix it"}, nil)
	if create.request.Runtime != "" {
		t.Fatalf("runtime = %q, want deployment default", create.request.Runtime)
	}

	create = parseCreate(
		[]string{"--repo", "openclaw/crabfleet", "--runtime", "container", "fix it"},
		nil,
	)
	if create.request.Runtime != "container" {
		t.Fatalf("runtime = %q, want explicit override", create.request.Runtime)
	}
}

func TestParseCreateAcceptsProfileOverride(t *testing.T) {
	create := parseCreate(
		[]string{"--repo", "openclaw/crabfleet", "--profile", "desktop-a", "fix it"},
		nil,
	)
	if create.request.Profile != "desktop-a" {
		t.Fatalf("profile = %q, want explicit override", create.request.Profile)
	}
}

func TestDeleteCommandAndStopAliasUseWorkspaceStopAction(t *testing.T) {
	var action string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/api/ssh/interactive-sessions/IS-7/actions" {
			t.Errorf("request = %s %s", r.Method, r.URL.Path)
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		if got := r.Header.Get("X-Crabfleet-SSH-Fingerprint"); got != "SHA256:test" {
			t.Errorf("fingerprint = %q", got)
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		var body map[string]string
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		action = body["action"]
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"session":{"id":"IS-7","status":"stopping"}}`))
	}))
	defer server.Close()

	client := &apiClient{baseURL: server.URL, token: "gateway-token", client: server.Client()}
	permissions := &ssh.Permissions{Extensions: map[string]string{
		"authorized":  "true",
		"fingerprint": "SHA256:test",
		"login":       "operator",
		"role":        "owner",
	}}
	for _, command := range []string{"delete IS-7", "stop IS-7"} {
		action = ""
		var output bytes.Buffer
		if exit := runCommand(context.Background(), &output, permissions, client, command, sessionPTY{}); exit != 0 {
			t.Fatalf("command=%q exit=%d output=%q", command, exit, output.String())
		}
		if action != "stop" {
			t.Fatalf("command=%q action=%q, want stop", command, action)
		}
		if !strings.Contains(output.String(), "provider deletion was not confirmed") {
			t.Fatalf("command=%q missing legacy cleanup warning: %q", command, output.String())
		}
		if got := output.String(); !strings.Contains(got, "session: IS-7\nstatus: stopping\n") {
			t.Fatalf("command=%q output=%q", command, got)
		}
	}
	for _, command := range []string{"delete", "delete IS-7 extra", "stop", "stop IS-7 extra"} {
		action = ""
		var output bytes.Buffer
		if exit := runCommand(context.Background(), &output, permissions, client, command, sessionPTY{}); exit != 2 {
			t.Fatalf("command=%q exit=%d output=%q", command, exit, output.String())
		}
		if action != "" {
			t.Fatalf("command=%q unexpectedly submitted action=%q", command, action)
		}
		if got := output.String(); got != "usage: delete SESSION_ID\n" {
			t.Fatalf("command=%q output=%q", command, got)
		}
	}
}

func TestHelpNamesDeleteAsCanonicalCommand(t *testing.T) {
	var output bytes.Buffer
	printHelp(&output, fleetapi.User{Login: "operator", Role: "owner"})
	if got := output.String(); !strings.Contains(got, "delete SESSION_ID") || strings.Contains(got, "stop SESSION_ID") {
		t.Fatalf("help = %q", got)
	}
}

func TestHelpDocumentsProfileOverride(t *testing.T) {
	var output bytes.Buffer
	printHelp(&output, fleetapi.User{Login: "operator", Role: "owner"})
	if got := output.String(); !strings.Contains(got, "[--profile name]") ||
		!strings.Contains(got, "--profile overrides the deployment default") {
		t.Fatalf("help = %q", got)
	}
}

func TestPrintListShowsOwnersAndSessionTree(t *testing.T) {
	var out bytes.Buffer
	printList(&out, fleetapi.State{
		User:  fleetapi.User{Login: "steipete", Role: "owner"},
		Repos: []string{"openclaw/crabfleet"},
		InteractiveSessions: []fleetapi.Session{
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
		},
	})

	text := out.String()
	for _, want := range []string{
		"sessions:",
		"  steipete:",
		"    IS-1  ready  container  openclaw/crabfleet  - root mission",
		"      IS-2  ready  container  openclaw/crabfleet  - child mission",
	} {
		if !strings.Contains(text, want) {
			t.Fatalf("output missing %q:\n%s", want, text)
		}
	}
}
