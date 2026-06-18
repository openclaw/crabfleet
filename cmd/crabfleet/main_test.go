package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
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

func TestShellQuoteQuotesMetacharacters(t *testing.T) {
	values := []string{
		"$(touch /tmp/pwned)",
		";id",
		"&",
		"`id`",
		">file",
		"*",
		"line\nnext",
	}
	for _, value := range values {
		quoted := shellQuote(value)
		if !strings.HasPrefix(quoted, "'") || !strings.HasSuffix(quoted, "'") {
			t.Fatalf("shellQuote(%q) = %q, want single-quoted", value, quoted)
		}
		args, err := splitForTest("message IS-1 " + quoted)
		if err != nil {
			t.Fatal(err)
		}
		if got := args[2]; got != value {
			t.Fatalf("round trip = %q, want %q", got, value)
		}
	}
}

func TestRunSSHQuotesRemoteCommandArguments(t *testing.T) {
	argsPath := installFakeSSH(t)
	app := &cli{SSHHost: "crabd.test"}
	if err := runSSH(app, "attach", "IS-1; touch /tmp/pwned"); err != nil {
		t.Fatal(err)
	}
	output := readFakeSSHArgs(t, argsPath)
	if got, want := output, "--\ncrabd.test\nattach 'IS-1; touch /tmp/pwned'\n"; got != want {
		t.Fatalf("ssh args = %q, want %q", got, want)
	}
}

func TestRunSSHRejectsOptionLikeHost(t *testing.T) {
	installFakeSSH(t)
	app := &cli{SSHHost: "-oProxyCommand=bad"}
	err := runSSH(app, "whoami")
	if err == nil || !strings.Contains(err.Error(), "invalid SSH host") {
		t.Fatalf("error = %v", err)
	}
}

func TestMutatingAPIFailureDoesNotFallbackToSSH(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/api/ssh/interactive-sessions" {
			t.Errorf("request = %s %s", r.Method, r.URL.Path)
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		conn, _, err := w.(http.Hijacker).Hijack()
		if err != nil {
			t.Error(err)
			return
		}
		_ = conn.Close()
	}))
	defer server.Close()

	app := &cli{API: server.URL, SSHHost: defaultSSHHost, Token: "gateway-token", Fingerprint: "SHA256:test"}
	err := (newCmd{Branch: "main", Command: "codex --yolo"}).Run(app, app.apiClient())
	if err == nil {
		t.Fatal("expected ambiguous mutation error")
	}
	if got := err.Error(); !strings.Contains(got, "not retrying through SSH") {
		t.Fatalf("error = %q", got)
	}
}

func TestPreRequestAPIFailureStillFallsBackToSSH(t *testing.T) {
	argsPath := installFakeSSH(t)
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	apiURL := "http://" + listener.Addr().String()
	if err := listener.Close(); err != nil {
		t.Fatal(err)
	}

	app := &cli{
		API:         apiURL,
		SSHHost:     "crabd.test",
		Token:       "gateway-token",
		Fingerprint: "SHA256:test",
	}
	if err := (newCmd{Branch: "main", Command: "codex --yolo", Repo: "openclaw/crabfleet"}).Run(app, app.apiClient()); err != nil {
		t.Fatal(err)
	}
	output := readFakeSSHArgs(t, argsPath)
	if !strings.Contains(output, "crabd.test\n") || !strings.Contains(output, "new --branch main --repo openclaw/crabfleet") {
		t.Fatalf("ssh args = %q", output)
	}
}

func TestAmbiguousTLSMutationFailureDoesNotFallbackToSSH(t *testing.T) {
	err := &url.Error{
		Op:  "Post",
		URL: "https://crabfleet.test/api/ssh/interactive-sessions",
		Err: errors.New("tls: bad record MAC"),
	}
	if canFallbackToSSH(&cli{SSHHost: "crabd.test"}, err) {
		t.Fatal("generic TLS failure was treated as safe to retry")
	}
}

func TestLocalAuthFailureStillFallsBackToSSH(t *testing.T) {
	argsPath := installFakeSSH(t)

	app := &cli{API: defaultAPIURL, SSHHost: "crabd.test"}
	if err := (newCmd{Branch: "main", Command: "codex --yolo", Repo: "openclaw/crabfleet"}).Run(app, app.apiClient()); err != nil {
		t.Fatal(err)
	}
	output := readFakeSSHArgs(t, argsPath)
	if !strings.Contains(output, "crabd.test\n") || !strings.Contains(output, "new --branch main --repo openclaw/crabfleet") {
		t.Fatalf("ssh args = %q", output)
	}
}

func TestAPIAuthRejectionStillFallsBackToSSH(t *testing.T) {
	argsPath := installFakeSSH(t)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte("bad token"))
	}))
	defer server.Close()

	app := &cli{
		API:         server.URL,
		SSHHost:     "crabd.test",
		Token:       "stale-token",
		Fingerprint: "SHA256:stale",
	}
	if err := (newCmd{Branch: "main", Command: "codex --yolo", Repo: "openclaw/crabfleet"}).Run(app, app.apiClient()); err != nil {
		t.Fatal(err)
	}
	output := readFakeSSHArgs(t, argsPath)
	if !strings.Contains(output, "crabd.test\n") || !strings.Contains(output, "new --branch main --repo openclaw/crabfleet") {
		t.Fatalf("ssh args = %q", output)
	}
}

func TestMessageWebSocketAuthRejectionStillFallsBackToSSH(t *testing.T) {
	argsPath := installFakeSSH(t)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusForbidden)
		_, _ = w.Write([]byte("bad websocket token"))
	}))
	defer server.Close()

	app := &cli{
		API:         server.URL,
		SSHHost:     "crabd.test",
		Token:       "stale-token",
		Fingerprint: "SHA256:stale",
	}
	if err := (messageCmd{ID: "IS-1", Text: []string{"hello"}}).Run(app, app.apiClient()); err != nil {
		t.Fatal(err)
	}
	output := readFakeSSHArgs(t, argsPath)
	if !strings.Contains(output, "crabd.test\n") || !strings.Contains(output, "message IS-1 hello") {
		t.Fatalf("ssh args = %q", output)
	}
}

func installFakeSSH(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	argsPath := filepath.Join(dir, "ssh-args")
	sshPath := filepath.Join(dir, "ssh")
	if err := os.WriteFile(sshPath, []byte("#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$SSH_ARGS_PATH\"\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
	t.Setenv("SSH_ARGS_PATH", argsPath)
	return argsPath
}

func installOutputSSH(t *testing.T, output string) {
	t.Helper()
	dir := t.TempDir()
	sshPath := filepath.Join(dir, "ssh")
	if err := os.WriteFile(sshPath, []byte("#!/bin/sh\nprintf '%s' \"$SSH_OUTPUT\"\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
	t.Setenv("SSH_OUTPUT", output)
}

func readFakeSSHArgs(t *testing.T, argsPath string) string {
	t.Helper()
	data, err := os.ReadFile(argsPath)
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

func TestNewCommandSanitizesControlPlaneOutput(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"session":{"id":"IS-1\u001b]52;c;bad\u0007","repo":"openclaw/crabfleet\u001b[31m","status":"ready","vncUrl":"https://example.test/vnc\u001b[0m","ptyAvailable":true}}`))
	}))
	defer server.Close()

	app := &cli{API: server.URL, Token: "gateway-token", Fingerprint: "SHA256:test", NoInput: true}
	output := captureStdout(t, func() {
		if err := (newCmd{Branch: "main", Command: "codex --yolo", Detach: true}).Run(app, app.apiClient()); err != nil {
			t.Fatal(err)
		}
	})
	if strings.ContainsAny(output, "\x1b\x07") {
		t.Fatalf("output contains terminal controls: %q", output)
	}
	if !strings.Contains(output, "session: IS-1]52;c;bad") {
		t.Fatalf("output = %q", output)
	}
}

func TestDoctorSanitizesControlPlaneErrors(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/healthz" {
			_, _ = w.Write([]byte("ok"))
			return
		}
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte("bad\x1b]52;c;secret\x07state"))
	}))
	defer server.Close()

	app := &cli{API: server.URL, Token: "gateway-token", Fingerprint: "SHA256:test"}
	output := captureStdout(t, func() {
		if err := (doctorCmd{}).Run(app, app.apiClient()); err != nil {
			t.Fatal(err)
		}
	})
	if strings.ContainsAny(output, "\x1b\x07") {
		t.Fatalf("doctor output contains terminal controls: %q", output)
	}
	if !strings.Contains(output, "auth: failed: crabfleet API 500 Internal Server Error: bad]52;c;secretstate") {
		t.Fatalf("doctor output = %q", output)
	}
}

func TestTranscriptCommandSanitizesControlPlaneOutput(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/ssh/interactive-sessions/IS-7/transcript" {
			t.Errorf("path = %q", r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
			return
		}
		_, _ = w.Write([]byte("hello\n\x1b]52;c;bad\x07world\x1b[31m!\n"))
	}))
	defer server.Close()

	app := &cli{API: server.URL, Token: "gateway-token", Fingerprint: "SHA256:test", NoInput: true}
	output := captureStdout(t, func() {
		if err := (transcriptCmd{ID: "IS-7"}).Run(app, app.apiClient()); err != nil {
			t.Fatal(err)
		}
	})
	if strings.ContainsAny(output, "\x1b\x07") || strings.Contains(output, "]52") {
		t.Fatalf("output contains terminal controls: %q", output)
	}
	if output != "hello\nworld!\n" {
		t.Fatalf("output = %q", output)
	}
}

func TestMessageRejectsOversizedPipedInput(t *testing.T) {
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()

	previousStdin := os.Stdin
	reader, writer, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	os.Stdin = reader
	defer func() {
		os.Stdin = previousStdin
		reader.Close()
	}()
	go func() {
		_, _ = writer.Write([]byte(strings.Repeat("a", maxMessageBytes+1)))
		_ = writer.Close()
	}()

	app := &cli{API: server.URL, Token: "gateway-token", Fingerprint: "SHA256:test", NoInput: true}
	err = (messageCmd{ID: "IS-7"}).Run(app, app.apiClient())
	if err == nil || !strings.Contains(err.Error(), "message exceeds") {
		t.Fatalf("error = %v", err)
	}
	if calls != 0 {
		t.Fatalf("message request calls = %d, want 0", calls)
	}
}

func TestValidateWebVNCURL(t *testing.T) {
	tests := []struct {
		raw     string
		allowed bool
	}{
		{raw: "https://example.test/vnc", allowed: true},
		{raw: "http://localhost:6080/vnc", allowed: true},
		{raw: "http://127.0.0.1:6080/vnc", allowed: true},
		{raw: "http://example.test/vnc", allowed: false},
		{raw: "file:///tmp/vnc", allowed: false},
		{raw: "custom:vnc", allowed: false},
		{raw: "/relative/vnc", allowed: false},
		{raw: "https://user@example.test/vnc", allowed: false},
	}
	for _, tt := range tests {
		_, err := validateWebVNCURL(tt.raw)
		if tt.allowed && err != nil {
			t.Fatalf("validateWebVNCURL(%q) = %v", tt.raw, err)
		}
		if !tt.allowed && err == nil {
			t.Fatalf("validateWebVNCURL(%q) unexpectedly succeeded", tt.raw)
		}
	}
}

func TestNewVNCFallbackValidatesCapturedURL(t *testing.T) {
	installOutputSSH(t, "vnc: http://example.test/not-webvnc\n")
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	apiURL := "http://" + listener.Addr().String()
	if err := listener.Close(); err != nil {
		t.Fatal(err)
	}

	app := &cli{
		API:         apiURL,
		SSHHost:     "crabd.test",
		Token:       "gateway-token",
		Fingerprint: "SHA256:test",
	}
	err = (newCmd{Branch: "main", Command: "codex --yolo", Repo: "openclaw/crabfleet", VNC: true}).Run(app, app.apiClient())
	if err == nil || !strings.Contains(err.Error(), "invalid WebVNC URL scheme") {
		t.Fatalf("error = %v", err)
	}
}

func TestFirstLineSkipsBlankLines(t *testing.T) {
	if got, want := firstLine("\n\n https://example.com/vnc\nignored\n"), "https://example.com/vnc"; got != want {
		t.Fatalf("firstLine = %q, want %q", got, want)
	}
}

func captureStdout(t *testing.T, fn func()) string {
	t.Helper()
	previous := os.Stdout
	reader, writer, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	os.Stdout = writer
	defer func() {
		os.Stdout = previous
	}()
	fn()
	_ = writer.Close()
	data, err := io.ReadAll(reader)
	if err != nil {
		t.Fatal(err)
	}
	_ = reader.Close()
	return string(data)
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
	args := cmd.sshCreateArgs(req)
	for _, arg := range args {
		if arg == "--runtime" {
			t.Fatal("SSH fallback forced a runtime override")
		}
	}

	cmd = parse("new", "--repo", "openclaw/crabfleet", "--", "--starts-with-dash").New
	req = cmd.sessionRequest(&cli{})
	args = cmd.sshCreateArgs(req)
	if got, want := args[len(args)-2:], []string{"--", "--starts-with-dash"}; got[0] != want[0] || got[1] != want[1] {
		t.Fatalf("prompt separator tail = %q, want %q", got, want)
	}

	cmd = parse("new", "--runtime", "container").New
	req = cmd.sessionRequest(&cli{})
	if req.Runtime != "container" {
		t.Fatalf("runtime = %q, want explicit override", req.Runtime)
	}
	args = cmd.sshCreateArgs(req)
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
