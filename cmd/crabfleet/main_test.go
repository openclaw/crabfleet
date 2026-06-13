package main

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"

	"github.com/alecthomas/kong"
)

func TestVersionIsSet(t *testing.T) {
	if version == "" {
		t.Fatal("version is empty")
	}
}

func TestJSONModeDoesNotDelegateToSSH(t *testing.T) {
	app := &cli{JSON: true, API: defaultAPIURL, SSHHost: defaultSSHHost}
	err := listCmd{}.Run(app, app.apiClient())
	if err == nil {
		t.Fatal("expected API credential error")
	}
}

func TestShellQuoteMatchesGatewaySplitter(t *testing.T) {
	remote := "new --command " + shellQuote("codex --yolo") + " " + shellQuote("fix John's bug")
	args, err := splitForTest(remote)
	if err != nil {
		t.Fatal(err)
	}
	if got, want := args[2], "codex --yolo"; got != want {
		t.Fatalf("command = %q, want %q", got, want)
	}
	if got, want := args[3], "fix John's bug"; got != want {
		t.Fatalf("prompt = %q, want %q", got, want)
	}
}

func TestFirstLineSkipsBlankLines(t *testing.T) {
	if got, want := firstLine("\n\n https://example.com/vnc\nignored\n"), "https://example.com/vnc"; got != want {
		t.Fatalf("firstLine = %q, want %q", got, want)
	}
}

func TestNewRuntimeOverrideIsOptional(t *testing.T) {
	t.Setenv("CRABFLEET_ROOT_SESSION_ID", "")
	parse := func(args ...string) cli {
		var app cli
		parser, err := kong.New(
			&app,
			kong.Name("crabfleet"),
			kong.Vars{"version": version},
		)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := parser.Parse(args); err != nil {
			t.Fatal(err)
		}
		return app
	}

	app := parse("new")
	cmd := app.New
	req := cmd.sessionRequest(&cli{})
	if req.Runtime != "" {
		t.Fatalf("runtime = %q, want deployment default", req.Runtime)
	}
	encoded, err := json.Marshal(req)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(encoded, []byte(`"runtime"`)) {
		t.Fatalf("omitted runtime was serialized: %s", encoded)
	}
	for _, arg := range cmd.sshCreateArgs(req) {
		if arg == "--runtime" {
			t.Fatal("SSH fallback forced a runtime override")
		}
	}

	cmd = parse("new", "--runtime", "container").New
	req = cmd.sessionRequest(&cli{})
	if req.Runtime != "container" {
		t.Fatalf("runtime = %q, want explicit override", req.Runtime)
	}
	args := cmd.sshCreateArgs(req)
	found := false
	for index := 0; index+1 < len(args); index++ {
		if args[index] == "--runtime" && args[index+1] == "container" {
			found = true
		}
	}
	if !found {
		t.Fatalf("explicit runtime missing from SSH fallback: %q", args)
	}
}

func TestAttachableRequiresReadySessionWithAttachURL(t *testing.T) {
	if !attachable(interactiveSession{Status: "ready", AttachURL: "/api/interactive-sessions/IS-1/pty"}) {
		t.Fatal("ready session with sandbox attach URL should be attachable")
	}
	if attachable(interactiveSession{Status: "pending_adapter", LeaseID: "sandbox:test"}) {
		t.Fatal("pending session should not be attachable")
	}
	if attachable(interactiveSession{Status: "ready", AttachURL: "https://example.com/console"}) {
		t.Fatal("http console URL should not be SSH attachable")
	}
	if attachable(interactiveSession{Status: "ready", AttachURL: "ws://example.com/terminal"}) {
		t.Fatal("insecure remote websocket should not be attachable")
	}
	if !attachable(interactiveSession{Status: "ready", AttachURL: "ws://127.0.0.1:9000/terminal"}) {
		t.Fatal("loopback websocket should be attachable")
	}
	if !attachable(interactiveSession{Status: "ready", LeaseID: "sandbox:test"}) {
		t.Fatal("sandbox lease should be attachable")
	}
	if attachable(interactiveSession{
		Status:       "ready",
		LeaseID:      "sandbox:test",
		AttachURL:    "/api/interactive-sessions/IS-1/pty",
		Capabilities: &sessionCapabilities{Terminal: false},
	}) {
		t.Fatal("session with withdrawn terminal capability should not be attachable")
	}
	available := false
	if attachable(interactiveSession{
		Status:       "ready",
		LeaseID:      "sandbox:test",
		PtyAvailable: &available,
	}) {
		t.Fatal("server PTY availability should be authoritative")
	}
}

func TestPrintFleetShowsOwnerSessionTreeAndSummaries(t *testing.T) {
	var out bytes.Buffer
	printFleet(&out, []interactiveSession{
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
	})

	text := out.String()
	for _, want := range []string{
		"steipete:",
		"  IS-1  ready  container  openclaw/crabfleet  - root mission",
		"    IS-2  ready  container  openclaw/crabfleet  - child mission",
	} {
		if !strings.Contains(text, want) {
			t.Fatalf("output missing %q:\n%s", want, text)
		}
	}
}

func splitForTest(command string) ([]string, error) {
	var args []string
	var current []rune
	var quote rune
	escaped := false
	hasValue := false
	for _, r := range command {
		if escaped {
			current = append(current, r)
			hasValue = true
			escaped = false
			continue
		}
		if r == '\\' {
			escaped = true
			continue
		}
		if quote != 0 {
			if r == quote {
				quote = 0
				hasValue = true
				continue
			}
			current = append(current, r)
			hasValue = true
			continue
		}
		if r == '\'' || r == '"' {
			quote = r
			hasValue = true
			continue
		}
		if r == ' ' {
			if hasValue {
				args = append(args, string(current))
				current = nil
				hasValue = false
			}
			continue
		}
		current = append(current, r)
		hasValue = true
	}
	if hasValue {
		args = append(args, string(current))
	}
	return args, nil
}
