package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"time"

	"github.com/alecthomas/kong"
	"github.com/openclaw/crabfleet/internal/fleetapi"
	"github.com/openclaw/crabfleet/internal/fleettext"
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
	List        listCmd        `cmd:"" help:"List crabboxes as an owner/session tree."`
	New         newCmd         `cmd:"" help:"Create a repo-ready crabbox and attach."`
	Attach      attachCmd      `cmd:"" help:"Attach to a crabbox terminal."`
	Status      statusCmd      `cmd:"" help:"Show one crabbox lifecycle state."`
	Delete      deleteCmd      `cmd:"" help:"End a crabbox session through its configured lifecycle."`
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
	Profile string   `help:"Runtime profile override; omit to use the deployment default."`
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

type deleteCmd struct {
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

func (c *cli) apiClient() *fleetapi.Client {
	auth := fleetapi.SSHAuth(c.Token, c.Fingerprint)
	if c.Token == "" || c.Fingerprint == "" {
		auth = fleetapi.AgentAuth(c.AgentToken, c.AgentID)
	}
	return fleetapi.NewClient(c.API, &http.Client{Timeout: 2 * time.Minute}, auth)
}

func (loginCmd) Run(app *cli, _ *fleetapi.Client) error {
	if app.JSON {
		return json.NewEncoder(os.Stdout).Encode(map[string]string{
			"ssh": fmt.Sprintf("ssh link@%s", app.SSHHost),
			"app": app.API + "/app/",
		})
	}
	fmt.Fprintf(os.Stdout, "ssh: ssh link@%s\napp: %s/app/\n", app.SSHHost, app.API)
	return nil
}

func (whoamiCmd) Run(app *cli, api *fleetapi.Client) error {
	state, err := api.State(context.Background())
	if err != nil {
		if app.NoInput || app.JSON {
			return err
		}
		return runSSH(app, "whoami")
	}
	if app.JSON {
		return json.NewEncoder(os.Stdout).Encode(state.User)
	}
	fmt.Fprintf(os.Stdout, "login: %s\nrole: %s\n", fleettext.DisplayUser(state.User), state.User.Role)
	return nil
}

func (listCmd) Run(app *cli, api *fleetapi.Client) error {
	state, err := api.State(context.Background())
	if err != nil {
		if app.NoInput || app.JSON {
			return err
		}
		return runSSH(app, "list")
	}
	if app.JSON {
		return json.NewEncoder(os.Stdout).Encode(state)
	}
	if !fleettext.WriteSessionGroups(os.Stdout, state.InteractiveSessions, "") {
		fmt.Fprintln(os.Stdout, "crabboxes: none")
	}
	return nil
}

func (cmd newCmd) Run(app *cli, api *fleetapi.Client) error {
	req := cmd.sessionRequest(app)
	session, err := api.CreateSession(context.Background(), req)
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
		fmt.Fprintf(os.Stdout, "parent: %s\n", fleettext.Safe(session.ParentSessionID))
	}
	if session.RootSessionID != "" && session.RootSessionID != session.ID {
		fmt.Fprintf(os.Stdout, "root: %s\n", fleettext.Safe(session.RootSessionID))
	}
	if session.Summary != "" {
		fmt.Fprintf(os.Stdout, "summary: %s\n", fleettext.Safe(session.Summary))
	}
	if session.Attachable() {
		fmt.Fprintf(os.Stdout, "attach: crabfleet attach %s\n", session.ID)
	}
	if session.VNCURL != "" {
		fmt.Fprintf(os.Stdout, "vnc: %s\n", session.VNCURL)
	}
	if cmd.VNC && session.VNCURL != "" {
		return openURL(session.VNCURL)
	}
	if !cmd.Detach && !app.NoInput && isTerminal(os.Stdin) && isTerminal(os.Stdout) && session.Attachable() {
		return runSSH(app, "attach", session.ID)
	}
	return nil
}

func (cmd newCmd) sessionRequest(app *cli) fleetapi.CreateSessionRequest {
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
	return fleetapi.CreateSessionRequest{
		Repo:            cmd.Repo,
		Branch:          cmd.Branch,
		Runtime:         runtime,
		Profile:         cmd.Profile,
		Command:         cmd.Command,
		Prompt:          prompt,
		ParentSessionID: parent,
		RootSessionID:   root,
		Purpose:         cmd.Purpose,
		Summary:         cmd.Summary,
	}
}

func (cmd newCmd) sshCreateArgs(req fleetapi.CreateSessionRequest) []string {
	args := []string{"new", "--branch", req.Branch}
	if req.Runtime != "" {
		args = append(args, "--runtime", req.Runtime)
	}
	if req.Profile != "" {
		args = append(args, "--profile", req.Profile)
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

func (cmd attachCmd) Run(app *cli, _ *fleetapi.Client) error {
	return runSSH(app, "attach", cmd.ID)
}

func (cmd statusCmd) Run(app *cli, api *fleetapi.Client) error {
	session, err := api.Session(context.Background(), cmd.ID)
	if err != nil {
		if app.NoInput || app.JSON {
			return err
		}
		return runSSH(app, "status", cmd.ID)
	}
	if app.JSON {
		return json.NewEncoder(os.Stdout).Encode(session)
	}
	fleettext.WriteSessionStatus(os.Stdout, session)
	return nil
}

func (cmd deleteCmd) Run(app *cli, api *fleetapi.Client) error {
	session, err := api.Action(context.Background(), cmd.ID, "stop")
	if err != nil {
		if app.NoInput || app.JSON {
			return err
		}
		return runSSH(app, "delete", cmd.ID)
	}
	if app.JSON {
		return json.NewEncoder(os.Stdout).Encode(session)
	}
	fmt.Fprintf(os.Stdout, "session: %s\nstatus: %s\n", session.ID, session.Status)
	if note := session.LifecycleStopNote(); note != "" {
		fmt.Fprintf(os.Stdout, "note: %s\n", note)
	}
	return nil
}

func (doctorCmd) Run(app *cli, api *fleetapi.Client) error {
	result := map[string]string{
		"api":  "unknown",
		"auth": "unknown",
	}
	if err := api.Health(context.Background()); err != nil {
		result["api"] = "failed: " + err.Error()
	} else {
		result["api"] = "ok"
	}
	state, err := api.State(context.Background())
	if err != nil {
		result["auth"] = "failed: " + err.Error()
	} else {
		result["auth"] = "ok"
		result["user"] = fleettext.DisplayUser(state.User)
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

func (cmd checkpointsCmd) Run(app *cli, api *fleetapi.Client) error {
	checkpoints, err := api.Checkpoints(context.Background(), cmd.ID)
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

func (cmd checkpointCmd) Run(app *cli, api *fleetapi.Client) error {
	checkpoint, err := api.Checkpoint(context.Background(), cmd.ID)
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

func (cmd restoreCmd) Run(app *cli, api *fleetapi.Client) error {
	checkpoint, err := api.Restore(context.Background(), cmd.ID, cmd.Checkpoint)
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

func (cmd vncCmd) Run(app *cli, api *fleetapi.Client) error {
	state, err := api.State(context.Background())
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

func (cmd logsCmd) Run(app *cli, api *fleetapi.Client) error {
	logs, err := api.Logs(context.Background(), cmd.ID)
	if err != nil {
		if app.NoInput || app.JSON {
			return err
		}
		return runSSH(app, "logs", cmd.ID)
	}
	if app.JSON {
		return json.NewEncoder(os.Stdout).Encode(logs)
	}
	fleettext.WriteSessionLogs(os.Stdout, logs)
	return nil
}

func (cmd transcriptCmd) Run(app *cli, api *fleetapi.Client) error {
	transcript, err := api.Transcript(context.Background(), cmd.ID)
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

func (cmd messageCmd) Run(app *cli, api *fleetapi.Client) error {
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
	if err := api.Message(context.Background(), cmd.ID, message, !cmd.NoEnter, 120, 34); err != nil {
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
	fmt.Fprintf(os.Stdout, "sent: %s\n", fleettext.Safe(cmd.ID))
	return nil
}

func (cmd summaryCmd) Run(app *cli, api *fleetapi.Client) error {
	summary := strings.Join(cmd.Text, " ")
	if summary == "" && cmd.Purpose == "" {
		session, err := api.Session(context.Background(), cmd.ID)
		if err != nil {
			if app.NoInput || app.JSON {
				return err
			}
			return runSSH(app, "summary", cmd.ID)
		}
		if app.JSON {
			return json.NewEncoder(os.Stdout).Encode(session)
		}
		fleettext.WriteSessionSummary(os.Stdout, session)
		return nil
	}
	session, err := api.UpdateSummary(context.Background(), cmd.ID, summary, cmd.Purpose)
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
	fleettext.WriteSessionSummary(os.Stdout, session)
	return nil
}

func (openCmd) Run(app *cli, _ *fleetapi.Client) error {
	return openURL(app.API + "/app/")
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

func isTerminal(file *os.File) bool {
	info, err := file.Stat()
	return err == nil && (info.Mode()&os.ModeCharDevice) != 0
}
