package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
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

func TestNewRuntimeAndProfileOverridesAreOptional(t *testing.T) {
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
	if req.Profile != "" {
		t.Fatalf("profile = %q, want deployment default", req.Profile)
	}
	encoded, err := json.Marshal(req)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(encoded, []byte(`"runtime"`)) {
		t.Fatalf("omitted runtime was serialized: %s", encoded)
	}
	if bytes.Contains(encoded, []byte(`"profile"`)) {
		t.Fatalf("omitted profile was serialized: %s", encoded)
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

	cmd = parse("new", "--profile", "desktop-a").New
	req = cmd.sessionRequest(&cli{})
	if req.Profile != "desktop-a" {
		t.Fatalf("profile = %q, want explicit override", req.Profile)
	}
	args = cmd.sshCreateArgs(req)
	found = false
	for index := 0; index+1 < len(args); index++ {
		if args[index] == "--profile" && args[index+1] == "desktop-a" {
			found = true
		}
	}
	if !found {
		t.Fatalf("explicit profile missing from SSH fallback: %q", args)
	}
}

func TestDeleteCommandUsesProviderStopAction(t *testing.T) {
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

	app := &cli{
		API:         server.URL,
		Token:       "gateway-token",
		Fingerprint: "SHA256:test",
		NoInput:     true,
	}
	if err := (deleteCmd{ID: "IS-7"}).Run(app, app.apiClient()); err != nil {
		t.Fatal(err)
	}
	if action != "stop" {
		t.Fatalf("action = %q, want stop", action)
	}
}

func TestCLIUsesDeleteCanonicalNameWithoutStopAlias(t *testing.T) {
	var app cli
	parser, err := kong.New(&app, kong.Name("crabfleet"), kong.Vars{"version": version})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := parser.Parse([]string{"delete", "IS-7"}); err != nil {
		t.Fatal(err)
	}
	if app.Delete.ID != "IS-7" {
		t.Fatalf("delete id = %q", app.Delete.ID)
	}
	var rejected cli
	rejectedParser, err := kong.New(&rejected, kong.Name("crabfleet"), kong.Vars{"version": version})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := rejectedParser.Parse([]string{"stop", "IS-8"}); err == nil {
		t.Fatal("stop alias unexpectedly parsed")
	}
}

func TestCLIUsesListCanonicalNameWithoutAlias(t *testing.T) {
	var app cli
	parser, err := kong.New(&app, kong.Name("crabfleet"), kong.Vars{"version": version})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := parser.Parse([]string{"list"}); err != nil {
		t.Fatal(err)
	}

	var rejected cli
	rejectedParser, err := kong.New(&rejected, kong.Name("crabfleet"), kong.Vars{"version": version})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := rejectedParser.Parse([]string{"ls"}); err == nil {
		t.Fatal("list alias unexpectedly parsed")
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
