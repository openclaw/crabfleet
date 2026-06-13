package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"runtime"
	"sort"
	"strings"
	"time"

	"github.com/alecthomas/kong"
	"github.com/coder/websocket"
)

const defaultAPIURL = "https://crabfleet.openclaw.ai"
const defaultSSHHost = "crabd.sh"

var version = "dev"

type cli struct {
	API         string `help:"Crabfleet API URL." default:"https://crabfleet.openclaw.ai" env:"CRABFLEET_API_URL"`
	SSHHost     string `help:"Crabfleet SSH host." default:"crabd.sh" env:"CRABFLEET_SSH_HOST"`
	Token       string `help:"Internal API token." env:"CRABFLEET_SSH_GATEWAY_TOKEN"`
	Fingerprint string `help:"Linked SSH key fingerprint." env:"CRABFLEET_SSH_FINGERPRINT"`
	AgentToken  string `help:"Scoped Crabfleet agent token." env:"CRABFLEET_AGENT_TOKEN"`
	AgentID     string `help:"Current Crabfleet session id." env:"CRABFLEET_SESSION_ID"`
	JSON        bool   `help:"Print JSON output."`
	Plain       bool   `help:"Print plain output without adornment."`
	NoInput     bool   `help:"Fail instead of prompting or delegating to SSH."`
	Version     kong.VersionFlag

	Login       loginCmd       `cmd:"" help:"Link this machine through SSH onboarding."`
	Whoami      whoamiCmd      `cmd:"" help:"Show the linked Crabfleet user."`
	List        listCmd        `cmd:"" aliases:"ls" help:"List crabboxes as an owner/session tree."`
	New         newCmd         `cmd:"" help:"Create a repo-ready crabbox and attach."`
	Attach      attachCmd      `cmd:"" help:"Attach to a crabbox terminal."`
	Status      statusCmd      `cmd:"" help:"Show one crabbox lifecycle state."`
	Stop        stopCmd        `cmd:"" help:"Stop a crabbox workspace."`
	Doctor      doctorCmd      `cmd:"" help:"Check API, auth, and linked lifecycle access."`
	Checkpoints checkpointsCmd `cmd:"" help:"List sandbox checkpoints."`
	Checkpoint  checkpointCmd  `cmd:"" help:"Create a sandbox checkpoint."`
	Restore     restoreCmd     `cmd:"" help:"Restore a sandbox checkpoint."`
	VNC         vncCmd         `cmd:"" help:"Print or open a crabbox WebVNC URL."`
	Logs        logsCmd        `cmd:"" help:"Print archived crabbox session events."`
	Transcript  transcriptCmd  `cmd:"" help:"Print a crabbox Markdown transcript."`
	Message     messageCmd     `cmd:"" help:"Send text to a crabbox terminal."`
	Summary     summaryCmd     `cmd:"" help:"Show or update a crabbox summary."`
	Open        openCmd        `cmd:"" help:"Open the Crabfleet dashboard."`
}

type loginCmd struct{}
type whoamiCmd struct{}
type listCmd struct{}

type newCmd struct {
	Repo    string   `help:"Repository to prepare, owner/repo."`
	Branch  string   `help:"Git branch to checkout." default:"main"`
	Runtime *string  `help:"Runtime backend override; omit to use the deployment default." enum:"crabbox,container"`
	Command string   `help:"Command to run after checkout." default:"codex --yolo"`
	Parent  string   `help:"Parent crabbox session id."`
	Root    string   `help:"Root crabbox session id."`
	Purpose string   `help:"Short mission label for list output."`
	Summary string   `help:"Initial session summary."`
	Detach  bool     `help:"Create the crabbox without attaching to it."`
	VNC     bool     `help:"Open WebVNC after creation when available."`
	Prompt  []string `arg:"" optional:"" help:"Initial prompt for Codex."`
}

type attachCmd struct {
	ID string `arg:"" help:"Crabbox session id."`
}

type statusCmd struct {
	ID string `arg:"" help:"Crabbox session id."`
}

type stopCmd struct {
	ID string `arg:"" help:"Crabbox session id."`
}

type doctorCmd struct{}

type checkpointsCmd struct {
	ID string `arg:"" help:"Crabbox session id."`
}

type checkpointCmd struct {
	ID string `arg:"" help:"Crabbox session id."`
}

type restoreCmd struct {
	ID         string `arg:"" help:"Crabbox session id."`
	Checkpoint string `arg:"" help:"Checkpoint id."`
}

type vncCmd struct {
	ID   string `arg:"" help:"Crabbox session id."`
	Open bool   `help:"Open the VNC URL in a browser."`
}

type logsCmd struct {
	ID string `arg:"" help:"Crabbox session id."`
}

type transcriptCmd struct {
	ID string `arg:"" help:"Crabbox session id."`
}

type messageCmd struct {
	ID      string   `arg:"" help:"Crabbox session id."`
	NoEnter bool     `help:"Do not append Enter after the message."`
	Text    []string `arg:"" optional:"" help:"Text to send."`
}

type summaryCmd struct {
	ID      string   `arg:"" help:"Crabbox session id."`
	Purpose string   `help:"Update the session purpose."`
	Text    []string `arg:"" optional:"" help:"New summary text."`
}

type openCmd struct{}

type apiClient struct {
	baseURL        string
	token          string
	fingerprint    string
	agentToken     string
	agentSessionID string
	http           *http.Client
}

type stateResponse struct {
	User                user                 `json:"user"`
	Repos               []string             `json:"repos"`
	InteractiveSessions []interactiveSession `json:"interactiveSessions"`
}

type user struct {
	Login   string `json:"login"`
	Email   string `json:"email"`
	Subject string `json:"subject"`
	Role    string `json:"role"`
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

type createSessionResponse struct {
	Session interactiveSession `json:"session"`
}

type sessionResponse struct {
	Session interactiveSession `json:"session"`
}

type checkpointResponse struct {
	Session    interactiveSession `json:"session"`
	Checkpoint checkpoint         `json:"checkpoint"`
}

type checkpointsResponse struct {
	Session     interactiveSession `json:"session"`
	Checkpoints []checkpoint       `json:"checkpoints"`
}

type actionResponse struct {
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

type checkpoint struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	SessionID string `json:"sessionId"`
	Workdir   string `json:"workdir"`
	CreatedAt int64  `json:"createdAt"`
}

func main() {
	var app cli
	ctx := kong.Parse(
		&app,
		kong.Name("crabfleet"),
		kong.Description("Crabfleet crabbox CLI."),
		kong.Vars{"version": version},
	)
	api := app.apiClient()
	err := ctx.Run(&app, api)
	ctx.FatalIfErrorf(err)
}

func (c *cli) apiClient() *apiClient {
	return &apiClient{
		baseURL:        strings.TrimRight(c.API, "/"),
		token:          c.Token,
		fingerprint:    c.Fingerprint,
		agentToken:     c.AgentToken,
		agentSessionID: c.AgentID,
		http:           &http.Client{Timeout: 2 * time.Minute},
	}
}

func (loginCmd) Run(app *cli, _ *apiClient) error {
	if app.JSON {
		return json.NewEncoder(os.Stdout).Encode(map[string]string{
			"ssh": fmt.Sprintf("ssh link@%s", app.SSHHost),
			"app": app.API + "/app/",
		})
	}
	fmt.Fprintf(os.Stdout, "ssh: ssh link@%s\napp: %s/app/\n", app.SSHHost, app.API)
	return nil
}

func (whoamiCmd) Run(app *cli, api *apiClient) error {
	state, err := api.state(context.Background())
	if err != nil {
		if app.NoInput || app.JSON {
			return err
		}
		return runSSH(app, "whoami")
	}
	if app.JSON {
		return json.NewEncoder(os.Stdout).Encode(state.User)
	}
	fmt.Fprintf(os.Stdout, "login: %s\nrole: %s\n", displayUser(state.User), state.User.Role)
	return nil
}

func (listCmd) Run(app *cli, api *apiClient) error {
	state, err := api.state(context.Background())
	if err != nil {
		if app.NoInput || app.JSON {
			return err
		}
		return runSSH(app, "list")
	}
	if app.JSON {
		return json.NewEncoder(os.Stdout).Encode(state)
	}
	printFleet(os.Stdout, state.InteractiveSessions)
	return nil
}

func (cmd newCmd) Run(app *cli, api *apiClient) error {
	req := cmd.sessionRequest(app)
	session, err := api.createSession(context.Background(), req)
	if err != nil {
		if app.NoInput || app.JSON {
			return err
		}
		args := cmd.sshCreateArgs(req)
		if cmd.VNC {
			output, captureErr := runSSHCommandOutput(app, args...)
			if output != "" {
				fmt.Fprint(os.Stdout, output)
			}
			if captureErr != nil {
				return captureErr
			}
			if url := vncURLFromOutput(output); url != "" {
				return openURL(url)
			}
			return nil
		}
		return runSSHCommand(app, args...)
	}
	if app.JSON {
		return json.NewEncoder(os.Stdout).Encode(session)
	}
	fmt.Fprintf(os.Stdout, "session: %s\nrepo: %s\nstatus: %s\n", session.ID, session.Repo, session.Status)
	if session.ParentSessionID != "" {
		fmt.Fprintf(os.Stdout, "parent: %s\n", terminalSafe(session.ParentSessionID))
	}
	if session.RootSessionID != "" && session.RootSessionID != session.ID {
		fmt.Fprintf(os.Stdout, "root: %s\n", terminalSafe(session.RootSessionID))
	}
	if session.Summary != "" {
		fmt.Fprintf(os.Stdout, "summary: %s\n", terminalSafe(session.Summary))
	}
	if attachable(session) {
		fmt.Fprintf(os.Stdout, "attach: crabfleet attach %s\n", session.ID)
	}
	if session.VNCURL != "" {
		fmt.Fprintf(os.Stdout, "vnc: %s\n", session.VNCURL)
	}
	if cmd.VNC && session.VNCURL != "" {
		return openURL(session.VNCURL)
	}
	if !cmd.Detach && !app.NoInput && isTerminal(os.Stdin) && isTerminal(os.Stdout) && attachable(session) {
		return runSSH(app, "attach", session.ID)
	}
	return nil
}

func (cmd newCmd) sessionRequest(app *cli) createSessionRequest {
	prompt := strings.Join(cmd.Prompt, " ")
	parent := cmd.Parent
	if parent == "" {
		parent = app.AgentID
	}
	root := cmd.Root
	if root == "" {
		root = os.Getenv("CRABFLEET_ROOT_SESSION_ID")
	}
	runtime := ""
	if cmd.Runtime != nil {
		runtime = *cmd.Runtime
	}
	return createSessionRequest{
		Repo:            cmd.Repo,
		Branch:          cmd.Branch,
		Runtime:         runtime,
		Command:         cmd.Command,
		Prompt:          prompt,
		ParentSessionID: parent,
		RootSessionID:   root,
		Purpose:         cmd.Purpose,
		Summary:         cmd.Summary,
	}
}

func (cmd newCmd) sshCreateArgs(req createSessionRequest) []string {
	args := []string{"new", "--branch", req.Branch}
	if req.Runtime != "" {
		args = append(args, "--runtime", req.Runtime)
	}
	if req.Repo != "" {
		args = append(args, "--repo", req.Repo)
	}
	if req.Command != "codex --yolo" {
		args = append(args, "--command", req.Command)
	}
	if req.ParentSessionID != "" {
		args = append(args, "--parent", req.ParentSessionID)
	}
	if req.RootSessionID != "" {
		args = append(args, "--root", req.RootSessionID)
	}
	if req.Purpose != "" {
		args = append(args, "--purpose", req.Purpose)
	}
	if req.Summary != "" {
		args = append(args, "--summary", req.Summary)
	}
	if cmd.Detach {
		args = append(args, "--detach")
	}
	if cmd.VNC {
		args = append(args, "--vnc")
	}
	if req.Prompt != "" {
		args = append(args, req.Prompt)
	}
	return args
}

func (cmd attachCmd) Run(app *cli, _ *apiClient) error {
	return runSSH(app, "attach", cmd.ID)
}

func (cmd statusCmd) Run(app *cli, api *apiClient) error {
	session, err := api.session(context.Background(), cmd.ID)
	if err != nil {
		if app.NoInput || app.JSON {
			return err
		}
		return runSSH(app, "status", cmd.ID)
	}
	if app.JSON {
		return json.NewEncoder(os.Stdout).Encode(session)
	}
	printSessionStatus(os.Stdout, session)
	return nil
}

func (cmd stopCmd) Run(app *cli, api *apiClient) error {
	session, err := api.action(context.Background(), cmd.ID, "stop")
	if err != nil {
		if app.NoInput || app.JSON {
			return err
		}
		return runSSH(app, "stop", cmd.ID)
	}
	if app.JSON {
		return json.NewEncoder(os.Stdout).Encode(session)
	}
	fmt.Fprintf(os.Stdout, "session: %s\nstatus: %s\n", session.ID, session.Status)
	return nil
}

func (doctorCmd) Run(app *cli, api *apiClient) error {
	result := map[string]string{
		"api":  "unknown",
		"auth": "unknown",
	}
	if err := api.health(context.Background()); err != nil {
		result["api"] = "failed: " + err.Error()
	} else {
		result["api"] = "ok"
	}
	state, err := api.state(context.Background())
	if err != nil {
		result["auth"] = "failed: " + err.Error()
	} else {
		result["auth"] = "ok"
		result["user"] = displayUser(state.User)
		result["role"] = state.User.Role
		result["sessions"] = fmt.Sprintf("%d", len(state.InteractiveSessions))
	}
	if app.JSON {
		return json.NewEncoder(os.Stdout).Encode(result)
	}
	keys := []string{"api", "auth", "user", "role", "sessions"}
	for _, key := range keys {
		if value := result[key]; value != "" {
			fmt.Fprintf(os.Stdout, "%s: %s\n", key, value)
		}
	}
	return nil
}

func (cmd checkpointsCmd) Run(app *cli, api *apiClient) error {
	checkpoints, err := api.checkpoints(context.Background(), cmd.ID)
	if err != nil {
		if app.NoInput || app.JSON {
			return err
		}
		return runSSH(app, "checkpoints", cmd.ID)
	}
	if app.JSON {
		return json.NewEncoder(os.Stdout).Encode(checkpoints)
	}
	if len(checkpoints.Checkpoints) == 0 {
		fmt.Fprintf(os.Stdout, "session: %s\ncheckpoints: none\n", checkpoints.Session.ID)
		return nil
	}
	fmt.Fprintf(os.Stdout, "session: %s\n", checkpoints.Session.ID)
	for _, checkpoint := range checkpoints.Checkpoints {
		fmt.Fprintf(
			os.Stdout,
			"%s  %s  %s\n",
			checkpoint.ID,
			time.UnixMilli(checkpoint.CreatedAt).Format(time.RFC3339),
			checkpoint.Workdir,
		)
	}
	return nil
}

func (cmd checkpointCmd) Run(app *cli, api *apiClient) error {
	checkpoint, err := api.checkpoint(context.Background(), cmd.ID)
	if err != nil {
		if app.NoInput || app.JSON {
			return err
		}
		return runSSH(app, "checkpoint", cmd.ID)
	}
	if app.JSON {
		return json.NewEncoder(os.Stdout).Encode(checkpoint)
	}
	fmt.Fprintf(os.Stdout, "session: %s\ncheckpoint: %s\n", checkpoint.Session.ID, checkpoint.Checkpoint.ID)
	return nil
}

func (cmd restoreCmd) Run(app *cli, api *apiClient) error {
	checkpoint, err := api.restore(context.Background(), cmd.ID, cmd.Checkpoint)
	if err != nil {
		if app.NoInput || app.JSON {
			return err
		}
		return runSSH(app, "restore", cmd.ID, cmd.Checkpoint)
	}
	if app.JSON {
		return json.NewEncoder(os.Stdout).Encode(checkpoint)
	}
	fmt.Fprintf(os.Stdout, "session: %s\nrestored: %s\n", checkpoint.Session.ID, checkpoint.Checkpoint.ID)
	return nil
}

func (cmd vncCmd) Run(app *cli, api *apiClient) error {
	state, err := api.state(context.Background())
	if err != nil {
		if app.NoInput || app.JSON {
			return err
		}
		if cmd.Open {
			url, captureErr := runSSHOutput(app, "vnc", cmd.ID)
			if captureErr != nil {
				return captureErr
			}
			url = firstLine(url)
			if url == "" {
				return errors.New("ssh gateway did not return a WebVNC URL")
			}
			return openURL(url)
		}
		return runSSH(app, "vnc", cmd.ID)
	}
	for _, session := range state.InteractiveSessions {
		if session.ID != cmd.ID {
			continue
		}
		if session.VNCURL == "" {
			return fmt.Errorf("session %s has no WebVNC URL yet", cmd.ID)
		}
		if cmd.Open {
			return openURL(session.VNCURL)
		}
		fmt.Fprintln(os.Stdout, session.VNCURL)
		return nil
	}
	return fmt.Errorf("session %s not found", cmd.ID)
}

func (cmd logsCmd) Run(app *cli, api *apiClient) error {
	logs, err := api.logs(context.Background(), cmd.ID)
	if err != nil {
		if app.NoInput || app.JSON {
			return err
		}
		return runSSH(app, "logs", cmd.ID)
	}
	if app.JSON {
		return json.NewEncoder(os.Stdout).Encode(logs)
	}
	printSessionLogs(os.Stdout, logs)
	return nil
}

func (cmd transcriptCmd) Run(app *cli, api *apiClient) error {
	transcript, err := api.transcript(context.Background(), cmd.ID)
	if err != nil {
		if app.NoInput || app.JSON {
			return err
		}
		return runSSH(app, "transcript", cmd.ID)
	}
	if app.JSON {
		return json.NewEncoder(os.Stdout).Encode(map[string]string{
			"session":    cmd.ID,
			"transcript": transcript,
		})
	}
	fmt.Fprint(os.Stdout, transcript)
	if !strings.HasSuffix(transcript, "\n") {
		fmt.Fprintln(os.Stdout)
	}
	return nil
}

func (cmd messageCmd) Run(app *cli, api *apiClient) error {
	message := strings.Join(cmd.Text, " ")
	if message == "" && !isTerminal(os.Stdin) {
		data, err := io.ReadAll(io.LimitReader(os.Stdin, 64*1024))
		if err != nil {
			return err
		}
		message = strings.TrimRight(string(data), "\r\n")
	}
	if message == "" {
		return errors.New("message text is required")
	}
	if err := api.message(context.Background(), cmd.ID, message, !cmd.NoEnter); err != nil {
		if app.NoInput || app.JSON {
			return err
		}
		args := []string{"message", cmd.ID}
		if cmd.NoEnter {
			args = append(args, "--no-enter")
		}
		args = append(args, message)
		return runSSHCommand(app, args...)
	}
	if app.JSON {
		return json.NewEncoder(os.Stdout).Encode(map[string]any{
			"session": cmd.ID,
			"sent":    true,
		})
	}
	fmt.Fprintf(os.Stdout, "sent: %s\n", terminalSafe(cmd.ID))
	return nil
}

func (cmd summaryCmd) Run(app *cli, api *apiClient) error {
	summary := strings.Join(cmd.Text, " ")
	if summary == "" && cmd.Purpose == "" {
		session, err := api.session(context.Background(), cmd.ID)
		if err != nil {
			if app.NoInput || app.JSON {
				return err
			}
			return runSSH(app, "summary", cmd.ID)
		}
		if app.JSON {
			return json.NewEncoder(os.Stdout).Encode(session)
		}
		printSessionSummary(os.Stdout, session)
		return nil
	}
	session, err := api.updateSummary(context.Background(), cmd.ID, summary, cmd.Purpose)
	if err != nil {
		if app.NoInput || app.JSON {
			return err
		}
		args := []string{"summary", cmd.ID}
		if cmd.Purpose != "" {
			args = append(args, "--purpose", cmd.Purpose)
		}
		if summary != "" {
			args = append(args, summary)
		}
		return runSSHCommand(app, args...)
	}
	if app.JSON {
		return json.NewEncoder(os.Stdout).Encode(session)
	}
	printSessionSummary(os.Stdout, session)
	return nil
}

func (openCmd) Run(app *cli, _ *apiClient) error {
	return openURL(app.API + "/app/")
}

func (c *apiClient) state(ctx context.Context) (stateResponse, error) {
	var out stateResponse
	err := c.do(ctx, http.MethodGet, "/api/ssh/state", nil, &out)
	return out, err
}

func (c *apiClient) health(ctx context.Context) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.baseURL+"/healthz", nil)
	if err != nil {
		return err
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("api %s", resp.Status)
	}
	return nil
}

func (c *apiClient) session(ctx context.Context, id string) (interactiveSession, error) {
	var out sessionResponse
	err := c.do(ctx, http.MethodGet, "/api/ssh/interactive-sessions/"+url.PathEscape(id), nil, &out)
	return out.Session, err
}

func (c *apiClient) createSession(ctx context.Context, req createSessionRequest) (interactiveSession, error) {
	var out createSessionResponse
	err := c.do(ctx, http.MethodPost, "/api/ssh/interactive-sessions", req, &out)
	return out.Session, err
}

func (c *apiClient) action(ctx context.Context, id string, action string) (interactiveSession, error) {
	var out actionResponse
	err := c.do(
		ctx,
		http.MethodPost,
		"/api/ssh/interactive-sessions/"+url.PathEscape(id)+"/actions",
		map[string]string{"action": action},
		&out,
	)
	return out.Session, err
}

func (c *apiClient) checkpoints(ctx context.Context, id string) (checkpointsResponse, error) {
	var out checkpointsResponse
	err := c.do(ctx, http.MethodGet, "/api/ssh/interactive-sessions/"+url.PathEscape(id)+"/checkpoints", nil, &out)
	return out, err
}

func (c *apiClient) checkpoint(ctx context.Context, id string) (checkpointResponse, error) {
	var out checkpointResponse
	err := c.do(ctx, http.MethodPost, "/api/ssh/interactive-sessions/"+url.PathEscape(id)+"/checkpoints", nil, &out)
	return out, err
}

func (c *apiClient) restore(ctx context.Context, id string, checkpoint string) (checkpointResponse, error) {
	var out checkpointResponse
	err := c.do(
		ctx,
		http.MethodPost,
		"/api/ssh/interactive-sessions/"+url.PathEscape(id)+"/checkpoints/"+url.PathEscape(checkpoint)+"/restore",
		nil,
		&out,
	)
	return out, err
}

func (c *apiClient) logs(ctx context.Context, id string) (sessionLogResponse, error) {
	var out sessionLogResponse
	err := c.do(ctx, http.MethodGet, "/api/ssh/interactive-sessions/"+url.PathEscape(id)+"/logs", nil, &out)
	return out, err
}

func (c *apiClient) transcript(ctx context.Context, id string) (string, error) {
	return c.text(ctx, http.MethodGet, "/api/ssh/interactive-sessions/"+url.PathEscape(id)+"/transcript", nil)
}

func (c *apiClient) message(ctx context.Context, id string, message string, enter bool) error {
	path := "/api/ssh/interactive-sessions/" + url.PathEscape(id) + "/pty"
	apiPath, authMode, err := c.authenticatedPath(path)
	if err != nil {
		return err
	}
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
	u.Path = apiPath
	q := u.Query()
	q.Set("cols", "120")
	q.Set("rows", "34")
	u.RawQuery = q.Encode()

	headers := http.Header{}
	c.setAuthHeaders(headers, authMode)
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

func (c *apiClient) updateSummary(ctx context.Context, id string, summary string, purpose string) (interactiveSession, error) {
	var out sessionResponse
	err := c.do(ctx, http.MethodPost, "/api/ssh/interactive-sessions/"+url.PathEscape(id)+"/summary", map[string]string{
		"summary": summary,
		"purpose": purpose,
	}, &out)
	return out.Session, err
}

func (c *apiClient) do(ctx context.Context, method string, path string, body any, out any) error {
	resp, err := c.request(ctx, method, path, body, "application/json")
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		text, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return fmt.Errorf("api %s: %s", resp.Status, strings.TrimSpace(string(text)))
	}
	if out == nil {
		return nil
	}
	return json.NewDecoder(resp.Body).Decode(out)
}

func (c *apiClient) text(ctx context.Context, method string, path string, body any) (string, error) {
	resp, err := c.request(ctx, method, path, body, "text/markdown")
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	data, readErr := io.ReadAll(io.LimitReader(resp.Body, 4*1024*1024))
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		if readErr != nil {
			return "", readErr
		}
		return "", fmt.Errorf("api %s: %s", resp.Status, strings.TrimSpace(string(data)))
	}
	if readErr != nil {
		return "", readErr
	}
	return string(data), nil
}

func (c *apiClient) request(ctx context.Context, method string, path string, body any, accept string) (*http.Response, error) {
	apiPath, authMode, err := c.authenticatedPath(path)
	if err != nil {
		return nil, err
	}
	var reader io.Reader
	if body != nil {
		payload, err := json.Marshal(body)
		if err != nil {
			return nil, err
		}
		reader = bytes.NewReader(payload)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.baseURL+apiPath, reader)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", accept)
	c.setAuthHeaders(req.Header, authMode)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	return c.http.Do(req)
}

func (c *apiClient) setAuthHeaders(headers http.Header, authMode string) {
	if authMode == "ssh" {
		headers.Set("Authorization", "Bearer "+c.token)
		headers.Set("X-Crabfleet-SSH-Fingerprint", c.fingerprint)
		return
	}
	headers.Set("Authorization", "Bearer "+c.agentToken)
	headers.Set("X-Crabfleet-Session-ID", c.agentSessionID)
}

func (c *apiClient) authenticatedPath(path string) (string, string, error) {
	if c.token != "" && c.fingerprint != "" {
		return path, "ssh", nil
	}
	if c.agentToken != "" && c.agentSessionID != "" {
		return strings.Replace(path, "/api/ssh/", "/api/agent/", 1), "agent", nil
	}
	return "", "", errors.New("API mode requires CRABFLEET_SSH_GATEWAY_TOKEN + CRABFLEET_SSH_FINGERPRINT or CRABFLEET_AGENT_TOKEN + CRABFLEET_SESSION_ID")
}

func printFleet(out io.Writer, sessions []interactiveSession) {
	groups := map[string][]interactiveSession{}
	for _, session := range sessions {
		owner := session.Owner
		if owner == "" {
			owner = "unassigned"
		}
		groups[owner] = append(groups[owner], session)
	}
	owners := make([]string, 0, len(groups))
	for owner := range groups {
		owners = append(owners, owner)
	}
	sort.Strings(owners)
	if len(owners) == 0 {
		fmt.Fprintln(out, "crabboxes: none")
		return
	}
	for _, owner := range owners {
		fmt.Fprintf(out, "%s:\n", terminalSafe(owner))
		printSessionTree(out, groups[owner], "  ")
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
		sort.SliceStable(byParent[parent], func(i, j int) bool {
			return byParent[parent][i].ID < byParent[parent][j].ID
		})
	}
	var roots []interactiveSession
	for _, session := range sessions {
		if session.ParentSessionID == "" || !known[session.ParentSessionID] {
			roots = append(roots, session)
		}
	}
	sort.SliceStable(roots, func(i, j int) bool {
		return roots[i].ID < roots[j].ID
	})
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

func printSessionStatus(out io.Writer, session interactiveSession) {
	fmt.Fprintf(out, "session: %s\n", terminalSafe(session.ID))
	fmt.Fprintf(out, "repo: %s\n", terminalSafe(session.Repo))
	fmt.Fprintf(out, "branch: %s\n", terminalSafe(session.Branch))
	fmt.Fprintf(out, "runtime: %s\n", terminalSafe(session.Runtime))
	fmt.Fprintf(out, "status: %s\n", terminalSafe(session.Status))
	fmt.Fprintf(out, "owner: %s\n", terminalSafe(session.Owner))
	if session.LeaseID != "" {
		fmt.Fprintf(out, "lease: %s\n", terminalSafe(session.LeaseID))
	}
	if session.ParentSessionID != "" {
		fmt.Fprintf(out, "parent: %s\n", terminalSafe(session.ParentSessionID))
	}
	if session.RootSessionID != "" {
		fmt.Fprintf(out, "root: %s\n", terminalSafe(session.RootSessionID))
	}
	if session.CreatedBy != "" {
		fmt.Fprintf(out, "created-by: %s\n", terminalSafe(session.CreatedBy))
	}
	if session.Purpose != "" {
		fmt.Fprintf(out, "purpose: %s\n", terminalSafe(session.Purpose))
	}
	if session.Summary != "" {
		fmt.Fprintf(out, "summary: %s\n", terminalSafe(session.Summary))
	}
	if session.AttachURL != "" {
		fmt.Fprintf(out, "attach: %s\n", terminalSafe(session.AttachURL))
	}
	if session.VNCURL != "" {
		fmt.Fprintf(out, "vnc: %s\n", terminalSafe(session.VNCURL))
	}
	if session.LastEvent != "" {
		fmt.Fprintf(out, "event: %s\n", terminalSafe(session.LastEvent))
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

func runSSH(app *cli, args ...string) error {
	sshArgs := append([]string{app.SSHHost}, args...)
	cmd := exec.Command("ssh", sshArgs...)
	cmd.Stdin = os.Stdin
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	return cmd.Run()
}

func runSSHCommand(app *cli, args ...string) error {
	parts := make([]string, len(args))
	for i, arg := range args {
		parts[i] = shellQuote(arg)
	}
	return runSSH(app, strings.Join(parts, " "))
}

func runSSHCommandOutput(app *cli, args ...string) (string, error) {
	parts := make([]string, len(args))
	for i, arg := range args {
		parts[i] = shellQuote(arg)
	}
	return runSSHOutput(app, strings.Join(parts, " "))
}

func runSSHOutput(app *cli, args ...string) (string, error) {
	sshArgs := append([]string{app.SSHHost}, args...)
	cmd := exec.Command("ssh", sshArgs...)
	cmd.Stderr = os.Stderr
	output, err := cmd.Output()
	return string(output), err
}

func shellQuote(value string) string {
	if value == "" {
		return "''"
	}
	if strings.IndexFunc(value, func(r rune) bool {
		return r == ' ' || r == '\t' || r == '\n' || r == '\r' || r == '\'' || r == '"' || r == '\\'
	}) == -1 {
		return value
	}
	return "'" + strings.ReplaceAll(value, "'", "'\\''") + "'"
}

func openURL(url string) error {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("open", url)
	case "windows":
		cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", url)
	default:
		cmd = exec.Command("xdg-open", url)
	}
	return cmd.Run()
}

func firstLine(value string) string {
	for _, line := range strings.Split(value, "\n") {
		if trimmed := strings.TrimSpace(line); trimmed != "" {
			return trimmed
		}
	}
	return ""
}

func vncURLFromOutput(output string) string {
	for _, line := range strings.Split(output, "\n") {
		line = strings.TrimSpace(line)
		if after, ok := strings.CutPrefix(line, "vnc:"); ok {
			line = strings.TrimSpace(after)
		}
		if strings.HasPrefix(line, "http://") || strings.HasPrefix(line, "https://") {
			return line
		}
	}
	return ""
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

func attachable(session interactiveSession) bool {
	if !terminalCapable(session) {
		return false
	}
	if !ptyAttachable(session) {
		return false
	}
	switch session.Status {
	case "ready", "attached", "detached":
		return true
	default:
		return false
	}
}

func terminalCapable(session interactiveSession) bool {
	return session.Capabilities == nil || session.Capabilities.Terminal
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

func isTerminal(file *os.File) bool {
	info, err := file.Stat()
	return err == nil && (info.Mode()&os.ModeCharDevice) != 0
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
