package main

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/coder/websocket"
	"golang.org/x/crypto/ssh"
)

type apiClient struct {
	baseURL string
	token   string
	client  *http.Client
}

type authResponse struct {
	Authorized bool   `json:"authorized"`
	LinkURL    string `json:"linkUrl"`
	User       user   `json:"user"`
}

type user struct {
	Login   string `json:"login"`
	Email   string `json:"email"`
	Subject string `json:"subject"`
	Role    string `json:"role"`
}

type stateResponse struct {
	User                user                 `json:"user"`
	Repos               []string             `json:"repos"`
	InteractiveSessions []interactiveSession `json:"interactiveSessions"`
	Cards               []card               `json:"cards"`
}

type interactiveSession struct {
	ID              string               `json:"id"`
	ParentSessionID string               `json:"parentSessionId"`
	RootSessionID   string               `json:"rootSessionId"`
	Repo            string               `json:"repo"`
	Branch          string               `json:"branch"`
	Runtime         string               `json:"runtime"`
	Status          string               `json:"status"`
	Owner           string               `json:"owner"`
	CreatedBy       string               `json:"createdBy"`
	Purpose         string               `json:"purpose"`
	Summary         string               `json:"summary"`
	Capabilities    *sessionCapabilities `json:"capabilities"`
	PtyAvailable    *bool                `json:"ptyAvailable"`
	LeaseID         string               `json:"leaseId"`
	AttachURL       string               `json:"attachUrl"`
	VNCURL          string               `json:"vncUrl"`
	LastEvent       string               `json:"lastEvent"`
	LogArchive      logArchive           `json:"logArchive"`
}

type sessionCapabilities struct {
	Terminal bool `json:"terminal"`
}

type card struct {
	ID        string `json:"id"`
	Title     string `json:"title"`
	Repo      string `json:"repo"`
	Lane      string `json:"lane"`
	LastEvent string `json:"lastEvent"`
}

type createSessionRequest struct {
	Repo            string `json:"repo,omitempty"`
	Branch          string `json:"branch,omitempty"`
	Runtime         string `json:"runtime,omitempty"`
	Command         string `json:"command,omitempty"`
	Prompt          string `json:"prompt,omitempty"`
	ParentSessionID string `json:"parentSessionId,omitempty"`
	RootSessionID   string `json:"rootSessionId,omitempty"`
	Purpose         string `json:"purpose,omitempty"`
	Summary         string `json:"summary,omitempty"`
}

type createArgs struct {
	request createSessionRequest
	detach  bool
	vnc     bool
}

type createSessionResponse struct {
	Session interactiveSession `json:"session"`
}

type sessionResponse struct {
	Session interactiveSession `json:"session"`
}

type sessionLogResponse struct {
	Session interactiveSession `json:"session"`
	Events  []sessionLogEvent  `json:"events"`
	Archive logArchive         `json:"archive"`
}

type sessionLogEvent struct {
	Actor     string `json:"actor"`
	Message   string `json:"message"`
	CreatedAt int64  `json:"createdAt"`
}

type logArchive struct {
	SessionID     string `json:"sessionId"`
	EventCount    int    `json:"eventCount"`
	EventsKey     string `json:"eventsKey"`
	TranscriptKey string `json:"transcriptKey"`
	SummaryKey    string `json:"summaryKey"`
	ArchivedAt    int64  `json:"archivedAt"`
	UpdatedAt     int64  `json:"updatedAt"`
}

type keyAuth struct {
	authorized  bool
	fingerprint string
	publicKey   string
	linkURL     string
	user        user
}

type sessionPTY struct {
	cols uint32
	rows uint32
}

func main() {
	var addr string
	var apiURL string
	var token string
	var hostKeyPath string
	var ephemeralHostKey bool
	flag.StringVar(&addr, "addr", env(":2222", "CRABFLEET_SSH_ADDR", "CRABBOX_SSH_ADDR"), "SSH listen address")
	flag.StringVar(&apiURL, "api", env("http://127.0.0.1:8787", "CRABFLEET_API_URL", "CRABBOX_API_URL"), "Crabfleet Worker URL")
	flag.StringVar(&token, "token", env("", "CRABFLEET_SSH_GATEWAY_TOKEN", "CRABBOX_SSH_GATEWAY_TOKEN"), "Worker SSH gateway token")
	flag.StringVar(&hostKeyPath, "host-key", env("", "CRABFLEET_SSH_HOST_KEY", "CRABBOX_SSH_HOST_KEY"), "SSH host private key path")
	flag.BoolVar(&ephemeralHostKey, "ephemeral-host-key", false, "use a generated host key for local development only")
	flag.Parse()

	if token == "" {
		log.Fatal("CRABFLEET_SSH_GATEWAY_TOKEN is required")
	}

	signer, err := loadHostKey(hostKeyPath, ephemeralHostKey)
	if err != nil {
		log.Fatalf("host key: %v", err)
	}

	client := &apiClient{
		baseURL: strings.TrimRight(apiURL, "/"),
		token:   token,
		client:  &http.Client{Timeout: 5 * time.Minute},
	}

	config := &ssh.ServerConfig{
		ServerVersion: "SSH-2.0-Crabfleet",
		PublicKeyCallback: func(meta ssh.ConnMetadata, key ssh.PublicKey) (*ssh.Permissions, error) {
			linkMode := meta.User() == "link" || meta.User() == "onboard"
			auth, err := client.auth(
				context.Background(),
				key,
				meta.User(),
				remoteHost(meta.RemoteAddr()),
				linkMode,
			)
			if err != nil {
				log.Printf("auth %s: %v", meta.RemoteAddr(), err)
				return nil, err
			}
			if !auth.authorized && !linkMode {
				return nil, fmt.Errorf("SSH key is not linked; use ssh link@host to link it")
			}
			extensions := map[string]string{
				"authorized":  fmt.Sprintf("%t", auth.authorized),
				"fingerprint": auth.fingerprint,
				"public_key":  auth.publicKey,
				"link_url":    auth.linkURL,
				"login":       auth.user.Login,
				"role":        auth.user.Role,
			}
			return &ssh.Permissions{Extensions: extensions}, nil
		},
	}
	config.AddHostKey(signer)

	listener, err := net.Listen("tcp", addr)
	if err != nil {
		log.Fatal(err)
	}
	log.Printf("crabfleet ssh gateway listening on %s -> %s", addr, apiURL)

	for {
		conn, err := listener.Accept()
		if err != nil {
			log.Printf("accept: %v", err)
			continue
		}
		go handleConn(conn, config, client)
	}
}

func handleConn(raw net.Conn, config *ssh.ServerConfig, client *apiClient) {
	defer raw.Close()
	conn, chans, reqs, err := ssh.NewServerConn(raw, config)
	if err != nil {
		log.Printf("handshake %s: %v", raw.RemoteAddr(), err)
		return
	}
	defer conn.Close()
	go ssh.DiscardRequests(reqs)

	for ch := range chans {
		if ch.ChannelType() != "session" {
			ch.Reject(ssh.UnknownChannelType, "session channels only")
			continue
		}
		channel, requests, err := ch.Accept()
		if err != nil {
			log.Printf("channel accept: %v", err)
			continue
		}
		go handleSession(channel, requests, conn.Permissions, client)
	}
}

func handleSession(channel ssh.Channel, requests <-chan *ssh.Request, perms *ssh.Permissions, client *apiClient) {
	defer channel.Close()
	pty := sessionPTY{cols: 120, rows: 34}
	for req := range requests {
		switch req.Type {
		case "pty-req":
			var payload struct {
				Term   string
				Cols   uint32
				Rows   uint32
				Width  uint32
				Height uint32
				Modes  string
			}
			ssh.Unmarshal(req.Payload, &payload)
			if payload.Cols > 0 {
				pty.cols = payload.Cols
			}
			if payload.Rows > 0 {
				pty.rows = payload.Rows
			}
			req.Reply(true, nil)
		case "window-change":
			var payload struct {
				Cols   uint32
				Rows   uint32
				Width  uint32
				Height uint32
			}
			ssh.Unmarshal(req.Payload, &payload)
			if payload.Cols > 0 {
				pty.cols = payload.Cols
			}
			if payload.Rows > 0 {
				pty.rows = payload.Rows
			}
		case "shell":
			req.Reply(true, nil)
			exit := runCommand(context.Background(), channel, perms, client, "", pty)
			replyExit(channel, exit)
			return
		case "exec":
			var payload struct{ Command string }
			ssh.Unmarshal(req.Payload, &payload)
			req.Reply(true, nil)
			exit := runCommand(context.Background(), channel, perms, client, payload.Command, pty)
			replyExit(channel, exit)
			return
		default:
			req.Reply(false, nil)
		}
	}
}

func runCommand(ctx context.Context, out io.ReadWriter, perms *ssh.Permissions, client *apiClient, command string, pty sessionPTY) uint32 {
	auth := keyAuth{
		authorized:  perms.Extensions["authorized"] == "true",
		fingerprint: perms.Extensions["fingerprint"],
		publicKey:   perms.Extensions["public_key"],
		linkURL:     perms.Extensions["link_url"],
		user: user{
			Login: perms.Extensions["login"],
			Role:  perms.Extensions["role"],
		},
	}
	if !auth.authorized {
		fmt.Fprintf(out, "Crabfleet SSH key not linked.\n\nOpen this URL to connect it:\n%s\n\nThen run ssh again.\n", auth.linkURL)
		return 1
	}

	args, err := splitCommand(command)
	if err != nil {
		fmt.Fprintf(out, "error: %v\n", err)
		return 2
	}
	if len(args) == 0 {
		printHelp(out, auth.user)
		return 0
	}
	switch args[0] {
	case "help", "-h", "--help":
		printHelp(out, auth.user)
		return 0
	case "whoami":
		state, err := client.state(ctx, auth.fingerprint)
		if err != nil {
			fmt.Fprintf(out, "error: %v\n", err)
			return 1
		}
		fmt.Fprintf(
			out,
			"login: %s\nrole: %s\nfingerprint: %s\n",
			terminalSafe(displayUser(state.User)),
			terminalSafe(state.User.Role),
			terminalSafe(auth.fingerprint),
		)
		return 0
	case "list", "ls":
		state, err := client.state(ctx, auth.fingerprint)
		if err != nil {
			fmt.Fprintf(out, "error: %v\n", err)
			return 1
		}
		printList(out, state)
		return 0
	case "new":
		create := parseCreate(args[1:], client, auth.fingerprint)
		session, err := client.createSession(ctx, auth.fingerprint, create.request)
		if err != nil {
			fmt.Fprintf(out, "error: %v\n", err)
			return 1
		}
		fmt.Fprintf(out, "session: %s\nrepo: %s\nstatus: %s\n", session.ID, session.Repo, session.Status)
		if attachable(session) {
			fmt.Fprintf(out, "attach: ssh crabfleet attach %s\n", session.ID)
		}
		if session.VNCURL != "" {
			fmt.Fprintf(out, "vnc: %s\n", terminalSafe(session.VNCURL))
		}
		if create.vnc {
			if session.VNCURL == "" {
				fmt.Fprintln(out, "vnc: pending")
			}
			return 0
		}
		if create.detach || !attachable(session) {
			return 0
		}
		return client.attach(ctx, auth.fingerprint, session.ID, out, pty)
	case "attach":
		if len(args) < 2 {
			fmt.Fprintln(out, "usage: attach SESSION_ID")
			return 2
		}
		return client.attach(ctx, auth.fingerprint, args[1], out, pty)
	case "vnc":
		if len(args) < 2 {
			fmt.Fprintln(out, "usage: vnc SESSION_ID")
			return 2
		}
		state, err := client.state(ctx, auth.fingerprint)
		if err != nil {
			fmt.Fprintf(out, "error: %v\n", err)
			return 1
		}
		for _, session := range state.InteractiveSessions {
			if session.ID != args[1] {
				continue
			}
			if session.VNCURL == "" {
				fmt.Fprintf(out, "session %s has no WebVNC URL yet\n", terminalSafe(args[1]))
				return 1
			}
			fmt.Fprintln(out, terminalSafe(session.VNCURL))
			return 0
		}
		fmt.Fprintf(out, "session %s not found\n", terminalSafe(args[1]))
		return 1
	case "logs":
		if len(args) < 2 {
			fmt.Fprintln(out, "usage: logs SESSION_ID")
			return 2
		}
		logs, err := client.logs(ctx, auth.fingerprint, args[1])
		if err != nil {
			fmt.Fprintf(out, "error: %v\n", err)
			return 1
		}
		printSessionLogs(out, logs)
		return 0
	case "transcript":
		if len(args) < 2 {
			fmt.Fprintln(out, "usage: transcript SESSION_ID")
			return 2
		}
		transcript, err := client.transcript(ctx, auth.fingerprint, args[1])
		if err != nil {
			fmt.Fprintf(out, "error: %v\n", err)
			return 1
		}
		fmt.Fprint(out, transcript)
		if !strings.HasSuffix(transcript, "\n") {
			fmt.Fprintln(out)
		}
		return 0
	case "message":
		if len(args) < 3 {
			fmt.Fprintln(out, "usage: message SESSION_ID [--no-enter] TEXT")
			return 2
		}
		message := parseMessage(args[2:])
		if message.text == "" {
			fmt.Fprintln(out, "usage: message SESSION_ID [--no-enter] TEXT")
			return 2
		}
		if err := client.message(ctx, auth.fingerprint, args[1], message.text, !message.noEnter, pty); err != nil {
			fmt.Fprintf(out, "error: %v\n", err)
			return 1
		}
		fmt.Fprintf(out, "sent: %s\n", terminalSafe(args[1]))
		return 0
	case "summary":
		if len(args) < 2 {
			fmt.Fprintln(out, "usage: summary SESSION_ID [--purpose text] [summary text]")
			return 2
		}
		update := parseSummary(args[2:])
		if update.summary == "" && update.purpose == "" {
			state, err := client.state(ctx, auth.fingerprint)
			if err != nil {
				fmt.Fprintf(out, "error: %v\n", err)
				return 1
			}
			for _, session := range state.InteractiveSessions {
				if session.ID == args[1] {
					printSessionSummary(out, session)
					return 0
				}
			}
			fmt.Fprintf(out, "session %s not found\n", terminalSafe(args[1]))
			return 1
		}
		session, err := client.updateSummary(ctx, auth.fingerprint, args[1], update.summary, update.purpose)
		if err != nil {
			fmt.Fprintf(out, "error: %v\n", err)
			return 1
		}
		printSessionSummary(out, session)
		return 0
	case "open":
		fmt.Fprintf(out, "%s/app/\n", client.baseURL)
		return 0
	default:
		fmt.Fprintf(out, "unknown command: %s\n\n", args[0])
		printHelp(out, auth.user)
		return 2
	}
}

func terminalCapable(session interactiveSession) bool {
	return session.Capabilities == nil || session.Capabilities.Terminal
}

func attachable(session interactiveSession) bool {
	if !terminalCapable(session) || !ptyAttachable(session) {
		return false
	}
	switch session.Status {
	case "ready", "attached", "detached":
		return true
	default:
		return false
	}
}

func ptyAttachable(session interactiveSession) bool {
	if session.PtyAvailable != nil {
		return *session.PtyAvailable
	}
	if strings.HasPrefix(session.LeaseID, "sandbox:") || strings.HasPrefix(session.LeaseID, "cloudflare:") {
		return true
	}
	return strings.HasPrefix(session.AttachURL, "/api/interactive-sessions/") || validWebSocketAttachURL(session.AttachURL)
}

func validWebSocketAttachURL(raw string) bool {
	target, err := url.Parse(raw)
	if err != nil || target.Host == "" || target.User != nil {
		return false
	}
	if target.Scheme == "wss" {
		return true
	}
	host := target.Hostname()
	return target.Scheme == "ws" && (host == "localhost" || host == "127.0.0.1" || host == "::1")
}

func printHelp(out io.Writer, user user) {
	fmt.Fprintf(out, "Crabfleet SSH\nlogin: %s\nrole: %s\n\n", terminalSafe(displayUser(user)), terminalSafe(user.Role))
	fmt.Fprintln(out, "commands:")
	fmt.Fprintln(out, "  whoami")
	fmt.Fprintln(out, "  list")
	fmt.Fprintln(out, "  new [--repo owner/repo] [--branch main] [--runtime crabbox|container] [--parent id] [--purpose text] [--command codex] [--vnc] [prompt]")
	fmt.Fprintln(out, "      --runtime overrides the deployment default")
	fmt.Fprintln(out, "  attach SESSION_ID")
	fmt.Fprintln(out, "  vnc SESSION_ID")
	fmt.Fprintln(out, "  logs SESSION_ID")
	fmt.Fprintln(out, "  transcript SESSION_ID")
	fmt.Fprintln(out, "  message SESSION_ID [--no-enter] TEXT")
	fmt.Fprintln(out, "  summary SESSION_ID [--purpose text] [summary text]")
	fmt.Fprintln(out, "  open")
}

func printList(out io.Writer, state stateResponse) {
	fmt.Fprintf(out, "user: %s (%s)\n", terminalSafe(displayUser(state.User)), terminalSafe(state.User.Role))
	fmt.Fprintf(out, "repos: %s\n", compactList(state.Repos, 12))
	fmt.Fprintln(out, "\nsessions:")
	if len(state.InteractiveSessions) == 0 {
		fmt.Fprintln(out, "  none")
	} else {
		printSessionGroups(out, state.InteractiveSessions, "  ")
	}
	fmt.Fprintln(out, "\ncards:")
	if len(state.Cards) == 0 {
		fmt.Fprintln(out, "  none")
		return
	}
	for _, c := range state.Cards {
		fmt.Fprintf(
			out,
			"  %s: %s %s %s\n",
			terminalSafe(c.ID),
			terminalSafe(c.Lane),
			terminalSafe(c.Repo),
			terminalSafe(c.Title),
		)
	}
}

func printSessionGroups(out io.Writer, sessions []interactiveSession, indent string) {
	groups := map[string][]interactiveSession{}
	var owners []string
	for _, session := range sessions {
		owner := session.Owner
		if owner == "" {
			owner = "unassigned"
		}
		if _, ok := groups[owner]; !ok {
			owners = append(owners, owner)
		}
		groups[owner] = append(groups[owner], session)
	}
	sortStrings(owners)
	for _, owner := range owners {
		fmt.Fprintf(out, "%s%s:\n", indent, terminalSafe(owner))
		printSessionTree(out, groups[owner], indent+"  ")
	}
}

func printSessionTree(out io.Writer, sessions []interactiveSession, indent string) {
	byParent := map[string][]interactiveSession{}
	known := map[string]bool{}
	seen := map[string]bool{}
	for _, session := range sessions {
		known[session.ID] = true
		byParent[session.ParentSessionID] = append(byParent[session.ParentSessionID], session)
	}
	for parent := range byParent {
		sortSessions(byParent[parent])
	}
	var roots []interactiveSession
	for _, session := range sessions {
		if session.ParentSessionID == "" || !known[session.ParentSessionID] {
			roots = append(roots, session)
		}
	}
	sortSessions(roots)
	var walk func(interactiveSession, string)
	walk = func(session interactiveSession, prefix string) {
		if seen[session.ID] {
			return
		}
		seen[session.ID] = true
		fmt.Fprintf(out, "%s%s\n", prefix, sessionLine(session))
		for _, child := range byParent[session.ID] {
			walk(child, prefix+"  ")
		}
	}
	for _, root := range roots {
		walk(root, indent)
	}
	for _, session := range sessions {
		if !seen[session.ID] {
			walk(session, indent)
		}
	}
}

func sortStrings(values []string) {
	for i := 1; i < len(values); i++ {
		for j := i; j > 0 && values[j-1] > values[j]; j-- {
			values[j-1], values[j] = values[j], values[j-1]
		}
	}
}

func sortSessions(sessions []interactiveSession) {
	for i := 1; i < len(sessions); i++ {
		for j := i; j > 0 && sessions[j-1].ID > sessions[j].ID; j-- {
			sessions[j-1], sessions[j] = sessions[j], sessions[j-1]
		}
	}
}

func sessionLine(session interactiveSession) string {
	parts := []string{
		terminalSafe(session.ID),
		terminalSafe(session.Status),
		terminalSafe(session.Runtime),
		terminalSafe(session.Repo),
	}
	if summary := sessionSummary(session); summary != "" {
		parts = append(parts, "- "+terminalSafe(summary))
	}
	return strings.Join(parts, "  ")
}

func sessionSummary(session interactiveSession) string {
	if session.Summary != "" {
		return session.Summary
	}
	if session.Purpose != "" {
		return session.Purpose
	}
	return session.LastEvent
}

func printSessionLogs(out io.Writer, logs sessionLogResponse) {
	fmt.Fprintf(
		out,
		"session: %s\nrepo: %s\nstatus: %s\n",
		terminalSafe(logs.Session.ID),
		terminalSafe(logs.Session.Repo),
		terminalSafe(logs.Session.Status),
	)
	if logs.Archive.EventCount > 0 {
		fmt.Fprintf(out, "archive: %d events\n", logs.Archive.EventCount)
	}
	for _, event := range logs.Events {
		timestamp := time.UnixMilli(event.CreatedAt).Format("15:04:05")
		fmt.Fprintf(
			out,
			"%s %s %s\n",
			timestamp,
			terminalSafe(event.Actor),
			terminalSafe(event.Message),
		)
	}
}

func printSessionSummary(out io.Writer, session interactiveSession) {
	fmt.Fprintf(out, "session: %s\n", terminalSafe(session.ID))
	if session.Purpose != "" {
		fmt.Fprintf(out, "purpose: %s\n", terminalSafe(session.Purpose))
	}
	if session.Summary != "" {
		fmt.Fprintf(out, "summary: %s\n", terminalSafe(session.Summary))
	}
}

func compactList(values []string, limit int) string {
	if len(values) == 0 {
		return "none"
	}
	if len(values) <= limit {
		return strings.Join(terminalSafeSlice(values), ", ")
	}
	return fmt.Sprintf("%s, +%d more", strings.Join(terminalSafeSlice(values[:limit]), ", "), len(values)-limit)
}

func terminalSafeSlice(values []string) []string {
	safe := make([]string, len(values))
	for i, value := range values {
		safe[i] = terminalSafe(value)
	}
	return safe
}

func terminalSafe(value string) string {
	return strings.Map(func(r rune) rune {
		if r == '\n' || r == '\r' || r == '\t' {
			return ' '
		}
		if r < 0x20 || r == 0x7f || (r >= 0x80 && r <= 0x9f) {
			return -1
		}
		return r
	}, value)
}

func splitCommand(command string) ([]string, error) {
	var args []string
	var current strings.Builder
	var quote rune
	escaped := false
	hasValue := false
	for _, r := range command {
		if quote == '\'' {
			if r == quote {
				quote = 0
				hasValue = true
				continue
			}
			current.WriteRune(r)
			hasValue = true
			continue
		}
		if escaped {
			current.WriteRune(r)
			hasValue = true
			escaped = false
			continue
		}
		if r == '\\' {
			escaped = true
			continue
		}
		if quote == '"' {
			if r == quote {
				quote = 0
				hasValue = true
				continue
			}
			current.WriteRune(r)
			hasValue = true
			continue
		}
		if r == '\'' || r == '"' {
			quote = r
			hasValue = true
			continue
		}
		if r == ' ' || r == '\t' || r == '\n' || r == '\r' {
			if hasValue {
				args = append(args, current.String())
				current.Reset()
				hasValue = false
			}
			continue
		}
		current.WriteRune(r)
		hasValue = true
	}
	if escaped {
		current.WriteRune('\\')
	}
	if quote != 0 {
		return nil, errors.New("unterminated quote")
	}
	if hasValue {
		args = append(args, current.String())
	}
	return args, nil
}

func parseCreate(args []string, client *apiClient, fingerprint string) createArgs {
	fs := flag.NewFlagSet("new", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	var req createSessionRequest
	var detach bool
	var vnc bool
	fs.StringVar(&req.Repo, "repo", "", "repo")
	fs.StringVar(&req.Branch, "branch", "main", "branch")
	fs.StringVar(&req.Runtime, "runtime", "", "runtime override; defaults to deployment")
	fs.StringVar(&req.Command, "command", "", "command")
	fs.StringVar(&req.ParentSessionID, "parent", "", "parent session")
	fs.StringVar(&req.RootSessionID, "root", "", "root session")
	fs.StringVar(&req.Purpose, "purpose", "", "purpose")
	fs.StringVar(&req.Summary, "summary", "", "summary")
	fs.BoolVar(&detach, "detach", false, "do not attach after creating")
	fs.BoolVar(&vnc, "vnc", false, "print vnc URL without attaching")
	_ = fs.Parse(args)
	req.Prompt = strings.Join(fs.Args(), " ")
	if req.Repo == "" {
		if state, err := client.state(context.Background(), fingerprint); err == nil && len(state.Repos) > 0 {
			req.Repo = state.Repos[0]
		}
	}
	return createArgs{request: req, detach: detach, vnc: vnc}
}

type summaryUpdate struct {
	summary string
	purpose string
}

type messageInput struct {
	text    string
	noEnter bool
}

func parseMessage(args []string) messageInput {
	fs := flag.NewFlagSet("message", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	var input messageInput
	fs.BoolVar(&input.noEnter, "no-enter", false, "do not append enter")
	_ = fs.Parse(args)
	input.text = strings.Join(fs.Args(), " ")
	return input
}

func parseSummary(args []string) summaryUpdate {
	fs := flag.NewFlagSet("summary", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	var update summaryUpdate
	fs.StringVar(&update.purpose, "purpose", "", "purpose")
	_ = fs.Parse(args)
	update.summary = strings.Join(fs.Args(), " ")
	return update
}

func (c *apiClient) auth(ctx context.Context, key ssh.PublicKey, sshUser string, remote string, createLink bool) (keyAuth, error) {
	fingerprint := ssh.FingerprintSHA256(key)
	publicKey := string(bytes.TrimSpace(ssh.MarshalAuthorizedKey(key)))
	var response authResponse
	err := c.do(ctx, http.MethodPost, "/api/ssh/auth", fingerprint, map[string]any{
		"fingerprint": fingerprint,
		"publicKey":   publicKey,
		"label":       strings.TrimSpace(sshUser),
		"remoteIp":    remote,
		"createLink":  createLink,
	}, &response)
	return keyAuth{
		authorized:  response.Authorized,
		fingerprint: fingerprint,
		publicKey:   publicKey,
		linkURL:     response.LinkURL,
		user:        response.User,
	}, err
}

func (c *apiClient) state(ctx context.Context, fingerprint string) (stateResponse, error) {
	var response stateResponse
	err := c.do(ctx, http.MethodGet, "/api/ssh/state", fingerprint, nil, &response)
	return response, err
}

func (c *apiClient) createSession(ctx context.Context, fingerprint string, request createSessionRequest) (interactiveSession, error) {
	var response createSessionResponse
	err := c.do(ctx, http.MethodPost, "/api/ssh/interactive-sessions", fingerprint, request, &response)
	return response.Session, err
}

func (c *apiClient) logs(ctx context.Context, fingerprint string, id string) (sessionLogResponse, error) {
	var response sessionLogResponse
	err := c.do(ctx, http.MethodGet, "/api/ssh/interactive-sessions/"+url.PathEscape(id)+"/logs", fingerprint, nil, &response)
	return response, err
}

func (c *apiClient) transcript(ctx context.Context, fingerprint string, id string) (string, error) {
	data, err := c.raw(ctx, http.MethodGet, "/api/ssh/interactive-sessions/"+url.PathEscape(id)+"/transcript", fingerprint, nil)
	return string(data), err
}

func (c *apiClient) updateSummary(ctx context.Context, fingerprint string, id string, summary string, purpose string) (interactiveSession, error) {
	var response sessionResponse
	err := c.do(ctx, http.MethodPost, "/api/ssh/interactive-sessions/"+url.PathEscape(id)+"/summary", fingerprint, map[string]string{
		"summary": summary,
		"purpose": purpose,
	}, &response)
	return response.Session, err
}

func (c *apiClient) message(ctx context.Context, fingerprint string, id string, message string, enter bool, pty sessionPTY) error {
	u, err := url.Parse(c.baseURL)
	if err != nil {
		return err
	}
	switch u.Scheme {
	case "https":
		u.Scheme = "wss"
	default:
		u.Scheme = "ws"
	}
	u.Path = "/api/ssh/interactive-sessions/" + url.PathEscape(id) + "/pty"
	q := u.Query()
	q.Set("fingerprint", fingerprint)
	q.Set("cols", fmt.Sprint(pty.cols))
	q.Set("rows", fmt.Sprint(pty.rows))
	u.RawQuery = q.Encode()

	headers := http.Header{}
	headers.Set("Authorization", "Bearer "+c.token)
	headers.Set("X-Crabfleet-SSH-Fingerprint", fingerprint)
	ws, _, err := websocket.Dial(ctx, u.String(), &websocket.DialOptions{HTTPHeader: headers})
	if err != nil {
		return err
	}
	defer ws.Close(websocket.StatusNormalClosure, "")
	payload := message
	if enter {
		payload += "\n"
	}
	return ws.Write(ctx, websocket.MessageBinary, []byte(payload))
}

func (c *apiClient) attach(ctx context.Context, fingerprint string, id string, terminal io.ReadWriter, pty sessionPTY) uint32 {
	u, err := url.Parse(c.baseURL)
	if err != nil {
		fmt.Fprintf(terminal, "error: %v\n", err)
		return 1
	}
	switch u.Scheme {
	case "https":
		u.Scheme = "wss"
	default:
		u.Scheme = "ws"
	}
	u.Path = "/api/ssh/interactive-sessions/" + url.PathEscape(id) + "/pty"
	q := u.Query()
	q.Set("fingerprint", fingerprint)
	q.Set("cols", fmt.Sprint(pty.cols))
	q.Set("rows", fmt.Sprint(pty.rows))
	u.RawQuery = q.Encode()

	headers := http.Header{}
	headers.Set("Authorization", "Bearer "+c.token)
	headers.Set("X-Crabfleet-SSH-Fingerprint", fingerprint)
	ws, _, err := websocket.Dial(ctx, u.String(), &websocket.DialOptions{HTTPHeader: headers})
	if err != nil {
		fmt.Fprintf(terminal, "attach failed: %v\n", err)
		return 1
	}
	defer ws.Close(websocket.StatusNormalClosure, "")
	netConn := websocket.NetConn(ctx, ws, websocket.MessageBinary)
	defer netConn.Close()

	errCh := make(chan error, 2)
	go func() {
		_, err := io.Copy(netConn, terminal)
		errCh <- err
	}()
	go func() {
		_, err := io.Copy(terminal, netConn)
		errCh <- err
	}()
	err = <-errCh
	if err != nil && !errors.Is(err, net.ErrClosed) && !strings.Contains(err.Error(), "closed") {
		fmt.Fprintf(terminal, "\nattach closed: %v\n", err)
		return 1
	}
	return 0
}

func (c *apiClient) do(ctx context.Context, method string, path string, fingerprint string, body any, out any) error {
	data, err := c.raw(ctx, method, path, fingerprint, body)
	if err != nil {
		return err
	}
	if out == nil {
		return nil
	}
	return json.Unmarshal(data, out)
}

func (c *apiClient) raw(ctx context.Context, method string, path string, fingerprint string, body any) ([]byte, error) {
	var reader io.Reader
	if body != nil {
		payload, err := json.Marshal(body)
		if err != nil {
			return nil, err
		}
		reader = bytes.NewReader(payload)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.baseURL+path, reader)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+c.token)
	req.Header.Set("Accept", "application/json")
	if fingerprint != "" {
		req.Header.Set("X-Crabfleet-SSH-Fingerprint", fingerprint)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := c.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	data, readErr := io.ReadAll(io.LimitReader(resp.Body, 4*1024*1024))
	if readErr != nil {
		return nil, readErr
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("crabfleet api %s: %s", resp.Status, strings.TrimSpace(string(data)))
	}
	return data, nil
}

func replyExit(channel ssh.Channel, code uint32) {
	_, _ = channel.SendRequest("exit-status", false, ssh.Marshal(struct{ Status uint32 }{code}))
}

func displayUser(u user) string {
	if u.Login != "" {
		return "@" + u.Login
	}
	if u.Email != "" {
		return u.Email
	}
	if u.Subject != "" {
		return u.Subject
	}
	return "unknown"
}

func loadHostKey(path string, allowEphemeral bool) (ssh.Signer, error) {
	if path != "" {
		data, err := os.ReadFile(path)
		if err != nil {
			return nil, err
		}
		return ssh.ParsePrivateKey(data)
	}
	if !allowEphemeral {
		return nil, errors.New("CRABBOX_SSH_HOST_KEY or --host-key is required")
	}
	_, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return nil, err
	}
	log.Print("using ephemeral SSH host key; set CRABBOX_SSH_HOST_KEY for production")
	return ssh.NewSignerFromKey(privateKey)
}

func env(fallback string, keys ...string) string {
	for _, key := range keys {
		if value := os.Getenv(key); value != "" {
			return value
		}
	}
	return fallback
}

func remoteHost(addr net.Addr) string {
	host, _, err := net.SplitHostPort(addr.String())
	if err == nil {
		return host
	}
	return addr.String()
}
