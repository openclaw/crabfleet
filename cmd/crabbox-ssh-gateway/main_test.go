package main

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/binary"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
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
	create, err := parseCreate(
		context.Background(),
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
	if err != nil {
		t.Fatal(err)
	}
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
	message, err := parseMessage([]string{"--no-enter", "hello", "child"})
	if err != nil {
		t.Fatal(err)
	}
	if !message.noEnter {
		t.Fatal("expected no-enter")
	}
	if got, want := message.text, "hello child"; got != want {
		t.Fatalf("text = %q, want %q", got, want)
	}

	message, err = parseMessage([]string{"--help", "is", "terminal", "text"})
	if err != nil {
		t.Fatal(err)
	}
	if got, want := message.text, "--help is terminal text"; got != want {
		t.Fatalf("text = %q, want %q", got, want)
	}

	message, err = parseMessage([]string{"--no-enter=true", "hello"})
	if err != nil {
		t.Fatal(err)
	}
	if !message.noEnter || message.text != "hello" {
		t.Fatalf("message = %#v", message)
	}
}

func TestParseSummaryKeepsDashPrefixedText(t *testing.T) {
	summary, err := parseSummary([]string{"--looks-like-flag", "but", "is", "text"})
	if err != nil {
		t.Fatal(err)
	}
	if got, want := summary.summary, "--looks-like-flag but is text"; got != want {
		t.Fatalf("summary = %q, want %q", got, want)
	}

	summary, err = parseSummary([]string{"--purpose", "handoff", "--", "--summary-start"})
	if err != nil {
		t.Fatal(err)
	}
	if got, want := summary.purpose, "handoff"; got != want {
		t.Fatalf("purpose = %q, want %q", got, want)
	}
	if got, want := summary.summary, "--summary-start"; got != want {
		t.Fatalf("summary = %q, want %q", got, want)
	}

	summary, err = parseSummary([]string{"--purpose=handoff", "done"})
	if err != nil {
		t.Fatal(err)
	}
	if got, want := summary.purpose, "handoff"; got != want {
		t.Fatalf("purpose = %q, want %q", got, want)
	}
	if got, want := summary.summary, "done"; got != want {
		t.Fatalf("summary = %q, want %q", got, want)
	}

	summary, err = parseSummary([]string{"-purpose", "handoff", "done"})
	if err != nil {
		t.Fatal(err)
	}
	if got, want := summary.purpose, "handoff"; got != want {
		t.Fatalf("purpose = %q, want %q", got, want)
	}
	if got, want := summary.summary, "done"; got != want {
		t.Fatalf("summary = %q, want %q", got, want)
	}
}

func TestParseCreateLeavesRuntimeToDeploymentDefault(t *testing.T) {
	create, err := parseCreate(context.Background(), []string{"--repo", "openclaw/crabfleet", "fix it"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if create.request.Runtime != "" {
		t.Fatalf("runtime = %q, want deployment default", create.request.Runtime)
	}

	create, err = parseCreate(
		context.Background(),
		[]string{"--repo", "openclaw/crabfleet", "--runtime", "container", "fix it"},
		nil,
	)
	if err != nil {
		t.Fatal(err)
	}
	if create.request.Runtime != "container" {
		t.Fatalf("runtime = %q, want explicit override", create.request.Runtime)
	}
}

func TestParseCreateAcceptsProfileOverride(t *testing.T) {
	create, err := parseCreate(
		context.Background(),
		[]string{"--repo", "openclaw/crabfleet", "--profile", "desktop-a", "fix it"},
		nil,
	)
	if err != nil {
		t.Fatal(err)
	}
	if create.request.Profile != "desktop-a" {
		t.Fatalf("profile = %q, want explicit override", create.request.Profile)
	}
}

func TestDeleteCommandUsesWorkspaceStopAction(t *testing.T) {
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
	var output bytes.Buffer
	if exit := runCommand(context.Background(), &output, permissions, client, "delete IS-7", sessionPTY{}); exit != 0 {
		t.Fatalf("exit=%d output=%q", exit, output.String())
	}
	if action != "stop" {
		t.Fatalf("action=%q, want stop", action)
	}
	if got := output.String(); !strings.Contains(got, "session: IS-7\nstatus: stopping\n") {
		t.Fatalf("output=%q", got)
	}
	for _, command := range []string{"delete", "delete IS-7 extra"} {
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
	var stopOutput bytes.Buffer
	if exit := runCommand(context.Background(), &stopOutput, permissions, client, "stop IS-7", sessionPTY{}); exit != 2 {
		t.Fatalf("stop alias exit=%d output=%q", exit, stopOutput.String())
	}
	if action != "" {
		t.Fatalf("stop alias unexpectedly submitted action=%q", action)
	}
	if got := stopOutput.String(); !strings.HasPrefix(got, "unknown command: stop\n") {
		t.Fatalf("stop alias output=%q", got)
	}
}

func TestInvalidSubcommandFlagsDoNotCallControlPlane(t *testing.T) {
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer server.Close()

	client := &apiClient{baseURL: server.URL, token: "gateway-token", client: server.Client()}
	permissions := &ssh.Permissions{Extensions: map[string]string{
		"authorized":  "true",
		"fingerprint": "SHA256:test",
		"login":       "operator",
		"role":        "owner",
	}}
	for _, command := range []string{
		"new --repo",
		"new --bogus value",
		"message IS-7 --no-enter",
		"summary IS-7 --purpose",
	} {
		var output bytes.Buffer
		if exit := runCommand(context.Background(), &output, permissions, client, command, sessionPTY{}); exit != 2 {
			t.Fatalf("command=%q exit=%d output=%q", command, exit, output.String())
		}
		if !strings.Contains(output.String(), "usage:") {
			t.Fatalf("command=%q output=%q", command, output.String())
		}
	}
	if calls != 0 {
		t.Fatalf("control plane calls = %d, want 0", calls)
	}
}

func TestHandleConnClosesStalledHandshake(t *testing.T) {
	previous := sshHandshakeTimeout
	sshHandshakeTimeout = 20 * time.Millisecond
	defer func() { sshHandshakeTimeout = previous }()

	server, client := net.Pipe()
	defer client.Close()
	done := make(chan struct{})
	go func() {
		handleConn(server, &ssh.ServerConfig{}, nil)
		close(done)
	}()

	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("stalled handshake was not closed")
	}
}

func TestAcceptConnRejectsWhenHandshakeSlotsFull(t *testing.T) {
	previous := sshHandshakeSlots
	sshHandshakeSlots = newConnectionLimiter(1)
	if !sshHandshakeSlots.acquire() {
		t.Fatal("failed to occupy handshake slot")
	}
	defer func() {
		sshHandshakeSlots.release()
		sshHandshakeSlots = previous
	}()

	server, client := net.Pipe()
	defer client.Close()
	acceptConn(server, &ssh.ServerConfig{}, nil)

	done := make(chan error, 1)
	go func() {
		var buf [1]byte
		_, err := client.Read(buf[:])
		done <- err
	}()
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("connection remained open after handshake slot exhaustion")
		}
	case <-time.After(time.Second):
		t.Fatal("connection remained open after handshake slot exhaustion")
	}
}

func TestAcceptConnHoldsConnectionSlotUntilClose(t *testing.T) {
	previousConnections := sshConnectionSlots
	previousHandshakes := sshHandshakeSlots
	sshConnectionSlots = newConnectionLimiter(1)
	sshHandshakeSlots = newConnectionLimiter(1)
	defer func() {
		sshConnectionSlots = previousConnections
		sshHandshakeSlots = previousHandshakes
	}()

	addr, cleanup := serveTestSSHGateway(t, testSSHServerConfig(t), nil)
	defer cleanup()
	clientConfig := testSSHClientConfig()
	first, err := ssh.Dial("tcp", addr, clientConfig)
	if err != nil {
		t.Fatal(err)
	}
	defer first.Close()

	if second, err := ssh.Dial("tcp", addr, clientConfig); err == nil {
		second.Close()
		t.Fatal("second connection succeeded while connection slot was occupied")
	}

	first.Close()
	deadline := time.Now().Add(time.Second)
	for {
		third, err := ssh.Dial("tcp", addr, clientConfig)
		if err == nil {
			third.Close()
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("connection slot was not released after close: %v", err)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestSessionChannelsAreBoundedPerConnection(t *testing.T) {
	previousChannels := sshSessionChannels
	previousIdle := sshSessionIdleTimer
	sshSessionChannels = 1
	sshSessionIdleTimer = time.Second
	defer func() {
		sshSessionChannels = previousChannels
		sshSessionIdleTimer = previousIdle
	}()

	addr, cleanup := serveTestSSHGateway(t, testSSHServerConfig(t), nil)
	defer cleanup()
	client, err := ssh.Dial("tcp", addr, testSSHClientConfig())
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	first, err := client.NewSession()
	if err != nil {
		t.Fatal(err)
	}
	defer first.Close()
	if second, err := client.NewSession(); err == nil {
		second.Close()
		t.Fatal("second session channel succeeded while per-connection slot was occupied")
	}
}

func TestIdleConnectionClosesWithoutSessionChannel(t *testing.T) {
	previousIdle := sshConnectionIdle
	previousConnections := sshConnectionSlots
	sshConnectionIdle = 20 * time.Millisecond
	sshConnectionSlots = newConnectionLimiter(1)
	defer func() {
		sshConnectionIdle = previousIdle
		sshConnectionSlots = previousConnections
	}()

	addr, cleanup := serveTestSSHGateway(t, testSSHServerConfig(t), nil)
	defer cleanup()
	clientConfig := testSSHClientConfig()
	first, err := ssh.Dial("tcp", addr, clientConfig)
	if err != nil {
		t.Fatal(err)
	}
	defer first.Close()

	time.Sleep(100 * time.Millisecond)
	if session, err := first.NewSession(); err == nil {
		session.Close()
		t.Fatal("idle connection still accepted a session channel")
	}
	second, err := ssh.Dial("tcp", addr, clientConfig)
	if err != nil {
		t.Fatalf("connection slot was not released after idle close: %v", err)
	}
	second.Close()
}

func TestIdleConnectionClosesAfterLastSessionChannel(t *testing.T) {
	previousIdle := sshConnectionIdle
	previousSessionIdle := sshSessionIdleTimer
	sshConnectionIdle = 20 * time.Millisecond
	sshSessionIdleTimer = time.Second
	defer func() {
		sshConnectionIdle = previousIdle
		sshSessionIdleTimer = previousSessionIdle
	}()

	addr, cleanup := serveTestSSHGateway(t, testSSHServerConfig(t), nil)
	defer cleanup()
	client, err := ssh.Dial("tcp", addr, testSSHClientConfig())
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	session, err := client.NewSession()
	if err != nil {
		t.Fatal(err)
	}
	if err := session.Close(); err != nil && !strings.Contains(err.Error(), "EOF") {
		t.Fatal(err)
	}

	time.Sleep(100 * time.Millisecond)
	if next, err := client.NewSession(); err == nil {
		next.Close()
		t.Fatal("idle connection still accepted a session after the last channel closed")
	}
}

func TestIdleSessionChannelClosesWithoutCommand(t *testing.T) {
	previousIdle := sshSessionIdleTimer
	sshSessionIdleTimer = 20 * time.Millisecond
	defer func() { sshSessionIdleTimer = previousIdle }()

	addr, cleanup := serveTestSSHGateway(t, testSSHServerConfig(t), nil)
	defer cleanup()
	client, err := ssh.Dial("tcp", addr, testSSHClientConfig())
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	session, err := client.NewSession()
	if err != nil {
		t.Fatal(err)
	}
	defer session.Close()

	time.Sleep(100 * time.Millisecond)
	if err := session.Shell(); err == nil {
		t.Fatal("idle session channel still accepted a shell request")
	}
}

func TestMalformedExecRequestIsRejected(t *testing.T) {
	addr, cleanup := serveTestSSHGateway(t, testSSHServerConfig(t), nil)
	defer cleanup()
	client, err := ssh.Dial("tcp", addr, testSSHClientConfig())
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	channel, _, err := client.OpenChannel("session", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer channel.Close()

	ok, err := channel.SendRequest("exec", true, []byte{0, 0, 0, 8, 'h', 'e', 'l', 'p'})
	if err != nil {
		t.Fatal(err)
	}
	if ok {
		t.Fatal("malformed exec request was accepted")
	}
}

func TestRunCommandCancelsControlPlaneRequest(t *testing.T) {
	entered := make(chan struct{})
	cancelled := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/ssh/state" {
			t.Errorf("path = %q", r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
			return
		}
		close(entered)
		select {
		case <-r.Context().Done():
			close(cancelled)
		case <-time.After(time.Second):
			t.Error("request context was not cancelled")
		}
	}))
	defer server.Close()

	client := &apiClient{baseURL: server.URL, token: "gateway-token", client: server.Client()}
	permissions := &ssh.Permissions{Extensions: map[string]string{
		"authorized":  "true",
		"fingerprint": "SHA256:test",
		"login":       "operator",
		"role":        "owner",
	}}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan uint32, 1)
	var output bytes.Buffer
	go func() {
		done <- runCommand(ctx, &output, permissions, client, "whoami", sessionPTY{})
	}()

	select {
	case <-entered:
	case <-time.After(time.Second):
		t.Fatal("control-plane request was not started")
	}
	cancel()
	select {
	case <-cancelled:
	case <-time.After(time.Second):
		t.Fatal("control-plane request was not cancelled")
	}
	select {
	case exit := <-done:
		if exit != 1 {
			t.Fatalf("exit = %d, want 1", exit)
		}
	case <-time.After(time.Second):
		t.Fatalf("runCommand did not return after cancellation; output=%q", output.String())
	}
}

func TestRunCommandCancelsDefaultRepoLookup(t *testing.T) {
	entered := make(chan struct{})
	cancelled := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/ssh/state" {
			t.Errorf("path = %q", r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
			return
		}
		close(entered)
		select {
		case <-r.Context().Done():
			close(cancelled)
		case <-time.After(time.Second):
			t.Error("request context was not cancelled")
		}
	}))
	defer server.Close()

	client := &apiClient{baseURL: server.URL, token: "gateway-token", client: server.Client()}
	permissions := &ssh.Permissions{Extensions: map[string]string{
		"authorized":  "true",
		"fingerprint": "SHA256:test",
		"login":       "operator",
		"role":        "owner",
	}}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan uint32, 1)
	var output bytes.Buffer
	go func() {
		done <- runCommand(ctx, &output, permissions, client, "new fix it", sessionPTY{})
	}()

	select {
	case <-entered:
	case <-time.After(time.Second):
		t.Fatal("default repo lookup was not started")
	}
	cancel()
	select {
	case <-cancelled:
	case <-time.After(time.Second):
		t.Fatal("default repo lookup was not cancelled")
	}
	select {
	case exit := <-done:
		if exit != 2 {
			t.Fatalf("exit = %d, want 2", exit)
		}
	case <-time.After(time.Second):
		t.Fatalf("runCommand did not return after cancellation; output=%q", output.String())
	}
}

func TestRunCommandStopsAfterDefaultRepoLookupFailure(t *testing.T) {
	createCalled := false
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/ssh/state":
			w.WriteHeader(http.StatusInternalServerError)
			_, _ = w.Write([]byte("state unavailable"))
		case "/api/ssh/interactive-sessions":
			createCalled = true
			w.WriteHeader(http.StatusCreated)
		default:
			t.Errorf("path = %q", r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer server.Close()

	client := &apiClient{baseURL: server.URL, token: "gateway-token", client: server.Client()}
	permissions := &ssh.Permissions{Extensions: map[string]string{
		"authorized":  "true",
		"fingerprint": "SHA256:test",
		"login":       "operator",
		"role":        "owner",
	}}
	var output bytes.Buffer
	if exit := runCommand(context.Background(), &output, permissions, client, "new fix it", sessionPTY{}); exit != 2 {
		t.Fatalf("exit=%d output=%q", exit, output.String())
	}
	if createCalled {
		t.Fatal("create session was called after default repo lookup failed")
	}
	if !strings.Contains(output.String(), "state unavailable") {
		t.Fatalf("output = %q", output.String())
	}
}

func TestRunCommandSanitizesControlPlaneErrors(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/ssh/state" {
			t.Errorf("path = %q", r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
			return
		}
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte("bad\x1b]52;c;secret\x07state"))
	}))
	defer server.Close()

	client := &apiClient{baseURL: server.URL, token: "gateway-token", client: server.Client()}
	permissions := &ssh.Permissions{Extensions: map[string]string{
		"authorized":  "true",
		"fingerprint": "SHA256:test",
		"login":       "operator",
		"role":        "owner",
	}}
	var output bytes.Buffer
	if exit := runCommand(context.Background(), &output, permissions, client, "whoami", sessionPTY{}); exit != 1 {
		t.Fatalf("exit=%d output=%q", exit, output.String())
	}
	got := output.String()
	if strings.ContainsAny(got, "\x1b\x07") {
		t.Fatalf("error output retained terminal controls: %q", got)
	}
	if strings.Contains(got, "secret") || strings.Contains(got, "]52") {
		t.Fatalf("error output retained terminal payload: %q", got)
	}
	if !strings.Contains(got, "badstate") {
		t.Fatalf("error output = %q", got)
	}
}

func TestAttachSanitizesTerminalErrors(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/terminal/ws" {
			t.Errorf("path = %q", r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
			return
		}
		conn, err := websocket.Accept(w, r, nil)
		if err != nil {
			t.Error(err)
			return
		}
		defer conn.Close(websocket.StatusNormalClosure, "")

		for range 2 {
			if _, _, err := conn.Read(r.Context()); err != nil {
				t.Error(err)
				return
			}
		}
		subscribed, _ := json.Marshal(map[string]any{"type": "subscribed", "canInput": true})
		if err := conn.Write(r.Context(), websocket.MessageBinary, testTerminalFrame(22, "IS-7", subscribed)); err != nil {
			t.Error(err)
			return
		}
		failure, _ := json.Marshal(map[string]string{"error": "bad\x1b]52;c;secret\x07state\x1b[31m"})
		_ = conn.Write(r.Context(), websocket.MessageBinary, testTerminalFrame(23, "IS-7", failure))
	}))
	defer server.Close()

	client := fleetapi.NewClient(server.URL, server.Client(), fleetapi.SSHAuth("gateway-token", "SHA256:test"))
	terminal := newBlockingTestTerminal()
	exit := attach(context.Background(), terminal, client, "IS-7", sessionPTY{cols: 80, rows: 24})
	if exit != 1 {
		t.Fatalf("exit=%d output=%q", exit, terminal.String())
	}
	output := terminal.String()
	if strings.ContainsAny(output, "\x1b\x07") || strings.Contains(output, "secret") || strings.Contains(output, "]52") {
		t.Fatalf("attach output retained terminal controls: %q", output)
	}
	if !strings.Contains(output, "attach closed: badstate") {
		t.Fatalf("attach output = %q", output)
	}
}

func TestRunCommandSanitizesLinkURL(t *testing.T) {
	permissions := &ssh.Permissions{Extensions: map[string]string{
		"authorized": "false",
		"link_url":   "https://example.test/link\x1b]52;c;secret\x07",
	}}
	var output bytes.Buffer
	if exit := runCommand(context.Background(), &output, permissions, nil, "whoami", sessionPTY{}); exit != 1 {
		t.Fatalf("exit=%d output=%q", exit, output.String())
	}
	got := output.String()
	if strings.ContainsAny(got, "\x1b\x07") {
		t.Fatalf("link output retained terminal controls: %q", got)
	}
	if !strings.Contains(got, "https://example.test/link]52;c;secret") {
		t.Fatalf("link output = %q", got)
	}
}

type blockingTestTerminal struct {
	mu     sync.Mutex
	output bytes.Buffer
	done   chan struct{}
}

func newBlockingTestTerminal() *blockingTestTerminal {
	return &blockingTestTerminal{done: make(chan struct{})}
}

func (t *blockingTestTerminal) Read(_ []byte) (int, error) {
	<-t.done
	return 0, io.EOF
}

func (t *blockingTestTerminal) Write(data []byte) (int, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.output.Write(data)
}

func (t *blockingTestTerminal) CancelRead() error {
	close(t.done)
	return nil
}

func (t *blockingTestTerminal) String() string {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.output.String()
}

func testTerminalFrame(messageType byte, sessionID string, data []byte) []byte {
	session := []byte(sessionID)
	payload := make([]byte, 12+len(session)+len(data))
	binary.LittleEndian.PutUint16(payload[0:2], 0x5943)
	payload[2] = 2
	payload[3] = messageType
	binary.LittleEndian.PutUint32(payload[4:8], uint32(len(session)))
	copy(payload[8:], session)
	offset := 8 + len(session)
	binary.LittleEndian.PutUint32(payload[offset:offset+4], uint32(len(data)))
	copy(payload[offset+4:], data)
	return payload
}

func TestTranscriptCommandSanitizesTerminalControls(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/ssh/interactive-sessions/IS-7/transcript" {
			t.Errorf("path = %q", r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
			return
		}
		_, _ = w.Write([]byte("hello\n\x1b]52;c;bad\x07world\x1b[31m!\n"))
	}))
	defer server.Close()

	client := &apiClient{baseURL: server.URL, token: "gateway-token", client: server.Client()}
	permissions := &ssh.Permissions{Extensions: map[string]string{
		"authorized":  "true",
		"fingerprint": "SHA256:test",
		"login":       "operator",
		"role":        "owner",
	}}
	var output bytes.Buffer
	if exit := runCommand(context.Background(), &output, permissions, client, "transcript IS-7", sessionPTY{}); exit != 0 {
		t.Fatalf("exit=%d output=%q", exit, output.String())
	}
	got := output.String()
	if strings.ContainsAny(got, "\x1b\x07") || strings.Contains(got, "]52") {
		t.Fatalf("transcript retained terminal controls: %q", got)
	}
	if got != "hello\nworld!\n" {
		t.Fatalf("transcript = %q", got)
	}
}

func TestNewCommandSanitizesTerminalControls(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/api/ssh/interactive-sessions" {
			t.Errorf("request = %s %s", r.Method, r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"session":{"id":"IS-7\u001b]52;c;bad\u0007","repo":"openclaw/crabfleet\u001b[31m","status":"ready","ptyAvailable":true}}`))
	}))
	defer server.Close()

	client := &apiClient{baseURL: server.URL, token: "gateway-token", client: server.Client()}
	permissions := &ssh.Permissions{Extensions: map[string]string{
		"authorized":  "true",
		"fingerprint": "SHA256:test",
		"login":       "operator",
		"role":        "owner",
	}}
	var output bytes.Buffer
	if exit := runCommand(context.Background(), &output, permissions, client, "new --detach --repo openclaw/crabfleet fix", sessionPTY{}); exit != 0 {
		t.Fatalf("exit=%d output=%q", exit, output.String())
	}
	got := output.String()
	if strings.ContainsAny(got, "\x1b\x07\r") {
		t.Fatalf("new output retained terminal controls: %q", got)
	}
	for _, want := range []string{
		"session: IS-7]52;c;bad\n",
		"repo: openclaw/crabfleet[31m\n",
		"status: ready\n",
		"attach: ssh crabfleet attach IS-7]52;c;bad\n",
	} {
		if !strings.Contains(got, want) {
			t.Fatalf("new output missing %q:\n%s", want, got)
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

func testSSHServerConfig(t *testing.T) *ssh.ServerConfig {
	t.Helper()
	_, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	signer, err := ssh.NewSignerFromKey(privateKey)
	if err != nil {
		t.Fatal(err)
	}
	config := &ssh.ServerConfig{NoClientAuth: true}
	config.AddHostKey(signer)
	return config
}

func testSSHClientConfig() *ssh.ClientConfig {
	return &ssh.ClientConfig{
		User:            "link",
		HostKeyCallback: ssh.InsecureIgnoreHostKey(),
		Timeout:         time.Second,
	}
}

func serveTestSSHGateway(t *testing.T, config *ssh.ServerConfig, client *apiClient) (string, func()) {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	done := make(chan struct{})
	go func() {
		defer close(done)
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			acceptConn(conn, config, client)
		}
	}()
	return listener.Addr().String(), func() {
		listener.Close()
		<-done
	}
}
