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
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/openclaw/crabfleet/internal/fleetapi"
	"github.com/openclaw/crabfleet/internal/fleettext"
	"golang.org/x/crypto/ssh"
)

var (
	sshHandshakeTimeout = 15 * time.Second
	sshAuthTimeout      = 15 * time.Second
	sshConnectionIdle   = 30 * time.Second
	sshSessionIdleTimer = 30 * time.Second
	sshHandshakeSlots   = newConnectionLimiter(64)
	sshConnectionSlots  = newConnectionLimiter(256)
	sshSessionChannels  = 8
)

type connectionLimiter struct {
	slots chan struct{}
}

func newConnectionLimiter(limit int) *connectionLimiter {
	if limit < 1 {
		limit = 1
	}
	return &connectionLimiter{slots: make(chan struct{}, limit)}
}

func (l *connectionLimiter) acquire() bool {
	if l == nil {
		return true
	}
	select {
	case l.slots <- struct{}{}:
		return true
	default:
		return false
	}
}

func (l *connectionLimiter) release() {
	if l == nil {
		return
	}
	select {
	case <-l.slots:
	default:
	}
}

type apiClient struct {
	baseURL string
	token   string
	client  *http.Client
}

type authResponse struct {
	Authorized bool          `json:"authorized"`
	LinkURL    string        `json:"linkUrl"`
	User       fleetapi.User `json:"user"`
}

type createArgs struct {
	request fleetapi.CreateSessionRequest
	detach  bool
	vnc     bool
}

type keyAuth struct {
	authorized  bool
	fingerprint string
	publicKey   string
	linkURL     string
	user        fleetapi.User
}

type sessionPTY struct {
	cols    uint32
	rows    uint32
	resizes chan fleetapi.TerminalSize
}

func main() {
	var addr string
	var apiURL string
	var token string
	var hostKeyPath string
	var ephemeralHostKey bool
	flag.StringVar(&addr, "addr", env(":2222", "CRABFLEET_SSH_ADDR"), "SSH listen address")
	flag.StringVar(&apiURL, "api", env("http://127.0.0.1:8787", "CRABFLEET_API_URL"), "Crabfleet Worker URL")
	flag.StringVar(&token, "token", env("", "CRABFLEET_SSH_GATEWAY_TOKEN"), "Worker SSH gateway token")
	flag.StringVar(&hostKeyPath, "host-key", env("", "CRABFLEET_SSH_HOST_KEY"), "SSH host private key path")
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
			authCtx, cancel := context.WithTimeout(context.Background(), sshAuthTimeout)
			defer cancel()
			auth, err := client.auth(
				authCtx,
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
		acceptConn(conn, config, client)
	}
}

func acceptConn(raw net.Conn, config *ssh.ServerConfig, client *apiClient) {
	if !sshConnectionSlots.acquire() {
		log.Printf("connection limit reached for %s", raw.RemoteAddr())
		raw.Close()
		return
	}
	if !sshHandshakeSlots.acquire() {
		log.Printf("connection limit reached for %s", raw.RemoteAddr())
		sshConnectionSlots.release()
		raw.Close()
		return
	}
	go handleConnWithRelease(raw, config, client, sshHandshakeSlots.release, sshConnectionSlots.release)
}

func handleConn(raw net.Conn, config *ssh.ServerConfig, client *apiClient) {
	handleConnWithRelease(raw, config, client, nil, nil)
}

func handleConnWithRelease(
	raw net.Conn,
	config *ssh.ServerConfig,
	client *apiClient,
	releaseHandshake func(),
	releaseConnection func(),
) {
	defer func() {
		if releaseHandshake != nil {
			releaseHandshake()
		}
	}()
	defer func() {
		if releaseConnection != nil {
			releaseConnection()
		}
	}()
	defer raw.Close()
	if err := raw.SetDeadline(time.Now().Add(sshHandshakeTimeout)); err != nil {
		log.Printf("handshake deadline %s: %v", raw.RemoteAddr(), err)
	}
	conn, chans, reqs, err := ssh.NewServerConn(raw, config)
	if releaseHandshake != nil {
		releaseHandshake()
		releaseHandshake = nil
	}
	if err != nil {
		log.Printf("handshake %s: %v", raw.RemoteAddr(), err)
		return
	}
	if err := raw.SetDeadline(time.Time{}); err != nil {
		log.Printf("clear handshake deadline %s: %v", raw.RemoteAddr(), err)
	}
	defer conn.Close()
	go ssh.DiscardRequests(reqs)

	permissions := conn.Permissions
	if permissions == nil {
		permissions = &ssh.Permissions{Extensions: map[string]string{}}
	}
	sessionSlots := newConnectionLimiter(sshSessionChannels)
	sessionDone := make(chan struct{})
	connectionClosed := make(chan struct{})
	defer close(connectionClosed)
	activeSessions := 0
	connectionIdleTimer, connectionIdle := newConnectionIdleTimer()
	defer stopTimer(connectionIdleTimer)
	for {
		select {
		case <-connectionIdle:
			return
		case <-sessionDone:
			if activeSessions > 0 {
				activeSessions--
			}
			if activeSessions == 0 {
				stopTimer(connectionIdleTimer)
				connectionIdleTimer, connectionIdle = newConnectionIdleTimer()
			}
		case ch, ok := <-chans:
			if !ok {
				return
			}
			if ch.ChannelType() != "session" {
				ch.Reject(ssh.UnknownChannelType, "session channels only")
				continue
			}
			if !sessionSlots.acquire() {
				ch.Reject(ssh.ResourceShortage, "too many session channels")
				continue
			}
			if activeSessions == 0 {
				stopTimer(connectionIdleTimer)
				connectionIdle = nil
			}
			activeSessions++
			channel, requests, err := ch.Accept()
			if err != nil {
				sessionSlots.release()
				if activeSessions > 0 {
					activeSessions--
				}
				if activeSessions == 0 {
					connectionIdleTimer, connectionIdle = newConnectionIdleTimer()
				}
				log.Printf("channel accept: %v", err)
				continue
			}
			go handleSession(channel, requests, permissions, client, func() {
				select {
				case sessionDone <- struct{}{}:
				case <-connectionClosed:
				}
				sessionSlots.release()
			})
		}
	}
}

func handleSession(
	channel ssh.Channel,
	requests <-chan *ssh.Request,
	perms *ssh.Permissions,
	client *apiClient,
	release func(),
) {
	if release != nil {
		defer release()
	}
	defer channel.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	idleTimer, idle := newSessionIdleTimer()
	defer stopTimer(idleTimer)
	pty := sessionPTY{
		cols:    120,
		rows:    34,
		resizes: make(chan fleetapi.TerminalSize, 1),
	}
	exitCh := make(chan uint32, 1)
	commandStarted := false
	for {
		select {
		case req, ok := <-requests:
			if !ok {
				cancel()
				return
			}
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
				pty.resize(payload.Cols, payload.Rows, commandStarted)
				req.Reply(true, nil)
			case "window-change":
				var payload struct {
					Cols   uint32
					Rows   uint32
					Width  uint32
					Height uint32
				}
				ssh.Unmarshal(req.Payload, &payload)
				pty.resize(payload.Cols, payload.Rows, commandStarted)
			case "shell":
				if commandStarted {
					req.Reply(false, nil)
					continue
				}
				commandStarted = true
				stopTimer(idleTimer)
				idle = nil
				req.Reply(true, nil)
				go func(current sessionPTY) {
					exitCh <- runCommand(ctx, channel, perms, client, "", current)
				}(pty)
			case "exec":
				if commandStarted {
					req.Reply(false, nil)
					continue
				}
				var payload struct{ Command string }
				ssh.Unmarshal(req.Payload, &payload)
				commandStarted = true
				stopTimer(idleTimer)
				idle = nil
				req.Reply(true, nil)
				go func(current sessionPTY, command string) {
					exitCh <- runCommand(
						ctx,
						channel,
						perms,
						client,
						command,
						current,
					)
				}(pty, payload.Command)
			default:
				req.Reply(false, nil)
			}
		case exit := <-exitCh:
			cancel()
			replyExit(channel, exit)
			return
		case <-idle:
			return
		}
	}
}

func newSessionIdleTimer() (*time.Timer, <-chan time.Time) {
	if sshSessionIdleTimer <= 0 {
		return nil, nil
	}
	timer := time.NewTimer(sshSessionIdleTimer)
	return timer, timer.C
}

func newConnectionIdleTimer() (*time.Timer, <-chan time.Time) {
	if sshConnectionIdle <= 0 {
		return nil, nil
	}
	timer := time.NewTimer(sshConnectionIdle)
	return timer, timer.C
}

func stopTimer(timer *time.Timer) {
	if timer == nil {
		return
	}
	if !timer.Stop() {
		select {
		case <-timer.C:
		default:
		}
	}
}

func (pty *sessionPTY) resize(cols uint32, rows uint32, notify bool) {
	if cols > 0 {
		pty.cols = cols
	}
	if rows > 0 {
		pty.rows = rows
	}
	if !notify || pty.resizes == nil || pty.cols == 0 || pty.rows == 0 {
		return
	}
	size := fleetapi.TerminalSize{Cols: pty.cols, Rows: pty.rows}
	select {
	case pty.resizes <- size:
	default:
		select {
		case <-pty.resizes:
		default:
		}
		pty.resizes <- size
	}
}

func runCommand(ctx context.Context, out io.ReadWriter, perms *ssh.Permissions, client *apiClient, command string, pty sessionPTY) uint32 {
	auth := keyAuth{
		authorized:  perms.Extensions["authorized"] == "true",
		fingerprint: perms.Extensions["fingerprint"],
		publicKey:   perms.Extensions["public_key"],
		linkURL:     perms.Extensions["link_url"],
		user: fleetapi.User{
			Login: perms.Extensions["login"],
			Role:  perms.Extensions["role"],
		},
	}
	if !auth.authorized {
		fmt.Fprintf(out, "Crabfleet SSH key not linked.\n\nOpen this URL to connect it:\n%s\n\nThen run ssh again.\n", auth.linkURL)
		return 1
	}
	api := client.controlPlane(auth.fingerprint)

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
		state, err := api.State(ctx)
		if err != nil {
			fmt.Fprintf(out, "error: %v\n", err)
			return 1
		}
		fmt.Fprintf(
			out,
			"login: %s\nrole: %s\nfingerprint: %s\n",
			fleettext.Safe(fleettext.DisplayUser(state.User)),
			fleettext.Safe(state.User.Role),
			fleettext.Safe(auth.fingerprint),
		)
		return 0
	case "list", "ls":
		state, err := api.State(ctx)
		if err != nil {
			fmt.Fprintf(out, "error: %v\n", err)
			return 1
		}
		printList(out, state)
		return 0
	case "new":
		create, err := parseCreate(ctx, args[1:], api)
		if err != nil {
			fmt.Fprintf(out, "usage: new [--repo owner/repo] [--branch main] [--runtime crabbox|container] [--profile name] [prompt]\nerror: %v\n", err)
			return 2
		}
		session, err := api.CreateSession(ctx, create.request)
		if err != nil {
			fmt.Fprintf(out, "error: %v\n", err)
			return 1
		}
		fmt.Fprintf(
			out,
			"session: %s\nrepo: %s\nstatus: %s\n",
			fleettext.Safe(session.ID),
			fleettext.Safe(session.Repo),
			fleettext.Safe(session.Status),
		)
		if session.Attachable() {
			fmt.Fprintf(out, "attach: ssh crabfleet attach %s\n", fleettext.Safe(session.ID))
		}
		if session.VNCURL != "" {
			fmt.Fprintf(out, "vnc: %s\n", fleettext.Safe(session.VNCURL))
		}
		if create.vnc {
			if session.VNCURL == "" {
				fmt.Fprintln(out, "vnc: pending")
			}
			return 0
		}
		if create.detach || !session.Attachable() {
			return 0
		}
		return attach(ctx, out, api, session.ID, pty)
	case "attach":
		if len(args) < 2 {
			fmt.Fprintln(out, "usage: attach SESSION_ID")
			return 2
		}
		return attach(ctx, out, api, args[1], pty)
	case "vnc":
		if len(args) < 2 {
			fmt.Fprintln(out, "usage: vnc SESSION_ID")
			return 2
		}
		state, err := api.State(ctx)
		if err != nil {
			fmt.Fprintf(out, "error: %v\n", err)
			return 1
		}
		for _, session := range state.InteractiveSessions {
			if session.ID != args[1] {
				continue
			}
			if session.VNCURL == "" {
				fmt.Fprintf(out, "session %s has no WebVNC URL yet\n", fleettext.Safe(args[1]))
				return 1
			}
			fmt.Fprintln(out, fleettext.Safe(session.VNCURL))
			return 0
		}
		fmt.Fprintf(out, "session %s not found\n", fleettext.Safe(args[1]))
		return 1
	case "delete":
		if len(args) != 2 {
			fmt.Fprintln(out, "usage: delete SESSION_ID")
			return 2
		}
		session, err := api.Action(ctx, args[1], "stop")
		if err != nil {
			fmt.Fprintf(out, "error: %v\n", err)
			return 1
		}
		fmt.Fprintf(out, "session: %s\nstatus: %s\n", fleettext.Safe(session.ID), fleettext.Safe(session.Status))
		if note := session.LifecycleStopNote(); note != "" {
			fmt.Fprintf(out, "note: %s\n", note)
		}
		return 0
	case "logs":
		if len(args) < 2 {
			fmt.Fprintln(out, "usage: logs SESSION_ID")
			return 2
		}
		logs, err := api.Logs(ctx, args[1])
		if err != nil {
			fmt.Fprintf(out, "error: %v\n", err)
			return 1
		}
		fleettext.WriteSessionLogs(out, logs)
		return 0
	case "transcript":
		if len(args) < 2 {
			fmt.Fprintln(out, "usage: transcript SESSION_ID")
			return 2
		}
		transcript, err := api.Transcript(ctx, args[1])
		if err != nil {
			fmt.Fprintf(out, "error: %v\n", err)
			return 1
		}
		safeTranscript := fleettext.SafeMultiline(transcript)
		fmt.Fprint(out, safeTranscript)
		if !strings.HasSuffix(safeTranscript, "\n") {
			fmt.Fprintln(out)
		}
		return 0
	case "message":
		if len(args) < 3 {
			fmt.Fprintln(out, "usage: message SESSION_ID [--no-enter] TEXT")
			return 2
		}
		message, err := parseMessage(args[2:])
		if err != nil {
			fmt.Fprintf(out, "usage: message SESSION_ID [--no-enter] TEXT\nerror: %v\n", err)
			return 2
		}
		if message.text == "" {
			fmt.Fprintln(out, "usage: message SESSION_ID [--no-enter] TEXT")
			return 2
		}
		if err := api.Message(ctx, args[1], message.text, !message.noEnter, pty.cols, pty.rows); err != nil {
			fmt.Fprintf(out, "error: %v\n", err)
			return 1
		}
		fmt.Fprintf(out, "sent: %s\n", fleettext.Safe(args[1]))
		return 0
	case "summary":
		if len(args) < 2 {
			fmt.Fprintln(out, "usage: summary SESSION_ID [--purpose text] [summary text]")
			return 2
		}
		update, err := parseSummary(args[2:])
		if err != nil {
			fmt.Fprintf(out, "usage: summary SESSION_ID [--purpose text] [summary text]\nerror: %v\n", err)
			return 2
		}
		if update.summary == "" && update.purpose == "" {
			state, err := api.State(ctx)
			if err != nil {
				fmt.Fprintf(out, "error: %v\n", err)
				return 1
			}
			for _, session := range state.InteractiveSessions {
				if session.ID == args[1] {
					fleettext.WriteSessionSummary(out, session)
					return 0
				}
			}
			fmt.Fprintf(out, "session %s not found\n", fleettext.Safe(args[1]))
			return 1
		}
		session, err := api.UpdateSummary(ctx, args[1], update.summary, update.purpose)
		if err != nil {
			fmt.Fprintf(out, "error: %v\n", err)
			return 1
		}
		fleettext.WriteSessionSummary(out, session)
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

func printHelp(out io.Writer, user fleetapi.User) {
	fmt.Fprintf(
		out,
		"Crabfleet SSH\nlogin: %s\nrole: %s\n\n",
		fleettext.Safe(fleettext.DisplayUser(user)),
		fleettext.Safe(user.Role),
	)
	fmt.Fprintln(out, "commands:")
	fmt.Fprintln(out, "  whoami")
	fmt.Fprintln(out, "  list")
	fmt.Fprintln(out, "  new [--repo owner/repo] [--branch main] [--runtime crabbox|container] [--profile name] [--parent id] [--purpose text] [--command codex] [--vnc] [prompt]")
	fmt.Fprintln(out, "      --runtime overrides the deployment default")
	fmt.Fprintln(out, "      --profile overrides the deployment default")
	fmt.Fprintln(out, "  attach SESSION_ID")
	fmt.Fprintln(out, "  vnc SESSION_ID")
	fmt.Fprintln(out, "  delete SESSION_ID")
	fmt.Fprintln(out, "  logs SESSION_ID")
	fmt.Fprintln(out, "  transcript SESSION_ID")
	fmt.Fprintln(out, "  message SESSION_ID [--no-enter] TEXT")
	fmt.Fprintln(out, "  summary SESSION_ID [--purpose text] [summary text]")
	fmt.Fprintln(out, "  open")
}

func printList(out io.Writer, state fleetapi.State) {
	fmt.Fprintf(
		out,
		"user: %s (%s)\n",
		fleettext.Safe(fleettext.DisplayUser(state.User)),
		fleettext.Safe(state.User.Role),
	)
	fmt.Fprintf(out, "repos: %s\n", fleettext.CompactList(state.Repos, 12))
	fmt.Fprintln(out, "\nsessions:")
	if !fleettext.WriteSessionGroups(out, state.InteractiveSessions, "  ") {
		fmt.Fprintln(out, "  none")
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
			fleettext.Safe(c.ID),
			fleettext.Safe(c.Lane),
			fleettext.Safe(c.Repo),
			fleettext.Safe(c.Title),
		)
	}
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

func parseCreate(ctx context.Context, args []string, api *fleetapi.Client) (createArgs, error) {
	fs := flag.NewFlagSet("new", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	var req fleetapi.CreateSessionRequest
	var detach bool
	var vnc bool
	fs.StringVar(&req.Repo, "repo", "", "repo")
	fs.StringVar(&req.Branch, "branch", "main", "branch")
	fs.StringVar(&req.Runtime, "runtime", "", "runtime override; defaults to deployment")
	fs.StringVar(&req.Profile, "profile", "", "runtime profile override; defaults to deployment")
	fs.StringVar(&req.Command, "command", "", "command")
	fs.StringVar(&req.ParentSessionID, "parent", "", "parent session")
	fs.StringVar(&req.RootSessionID, "root", "", "root session")
	fs.StringVar(&req.Purpose, "purpose", "", "purpose")
	fs.StringVar(&req.Summary, "summary", "", "summary")
	fs.BoolVar(&detach, "detach", false, "do not attach after creating")
	fs.BoolVar(&vnc, "vnc", false, "print vnc URL without attaching")
	if err := fs.Parse(args); err != nil {
		return createArgs{}, err
	}
	req.Prompt = strings.Join(fs.Args(), " ")
	if req.Repo == "" && api != nil {
		state, err := api.State(ctx)
		if err != nil && (ctx.Err() != nil || errors.Is(err, context.Canceled)) {
			return createArgs{}, err
		}
		if err == nil && len(state.Repos) > 0 {
			req.Repo = state.Repos[0]
		}
	}
	return createArgs{request: req, detach: detach, vnc: vnc}, nil
}

type summaryUpdate struct {
	summary string
	purpose string
}

type messageInput struct {
	text    string
	noEnter bool
}

func parseMessage(args []string) (messageInput, error) {
	var input messageInput
	remaining := args
	if len(remaining) > 0 && (remaining[0] == "--no-enter" || remaining[0] == "-no-enter") {
		input.noEnter = true
		remaining = remaining[1:]
	} else if len(remaining) > 0 {
		for _, prefix := range []string{"--no-enter=", "-no-enter="} {
			if value, ok := strings.CutPrefix(remaining[0], prefix); ok {
				parsed, err := strconv.ParseBool(value)
				if err != nil {
					return messageInput{}, err
				}
				input.noEnter = parsed
				remaining = remaining[1:]
				break
			}
		}
	}
	if len(remaining) > 0 && remaining[0] == "--" {
		remaining = remaining[1:]
	}
	input.text = strings.Join(remaining, " ")
	return input, nil
}

func parseSummary(args []string) (summaryUpdate, error) {
	var update summaryUpdate
	remaining := args
	if len(remaining) > 0 && (remaining[0] == "--purpose" || remaining[0] == "-purpose") {
		if len(remaining) < 2 {
			return summaryUpdate{}, errors.New("flag needs an argument: -purpose")
		}
		update.purpose = remaining[1]
		remaining = remaining[2:]
	} else if len(remaining) > 0 {
		for _, prefix := range []string{"--purpose=", "-purpose="} {
			if value, ok := strings.CutPrefix(remaining[0], prefix); ok {
				update.purpose = value
				remaining = remaining[1:]
				break
			}
		}
	}
	if len(remaining) > 0 && remaining[0] == "--" {
		remaining = remaining[1:]
	}
	update.summary = strings.Join(remaining, " ")
	return update, nil
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

func (c *apiClient) controlPlane(fingerprint string) *fleetapi.Client {
	return fleetapi.NewClient(c.baseURL, c.client, fleetapi.SSHAuth(c.token, fingerprint))
}

func attach(
	ctx context.Context,
	terminal io.ReadWriter,
	api *fleetapi.Client,
	id string,
	pty sessionPTY,
) uint32 {
	err := api.Attach(ctx, id, terminal, pty.cols, pty.rows, pty.resizes)
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

func loadHostKey(path string, allowEphemeral bool) (ssh.Signer, error) {
	if path != "" {
		data, err := os.ReadFile(path)
		if err != nil {
			return nil, err
		}
		return ssh.ParsePrivateKey(data)
	}
	if !allowEphemeral {
		return nil, errors.New("CRABFLEET_SSH_HOST_KEY or --host-key is required")
	}
	_, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return nil, err
	}
	log.Print("using ephemeral SSH host key; set CRABFLEET_SSH_HOST_KEY for production")
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
