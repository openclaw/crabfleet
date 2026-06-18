package fleetapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"

	"github.com/openclaw/crabfleet/internal/terminalws"
)

type TerminalSize = terminalws.Size

const maxResponseBytes = 4 * 1024 * 1024
const maxErrorBytes = 512

type authMode uint8

const (
	authNone authMode = iota
	authSSH
	authAgent
)

type Auth struct {
	mode      authMode
	token     string
	principal string
}

func SSHAuth(token string, fingerprint string) Auth {
	return Auth{mode: authSSH, token: token, principal: fingerprint}
}

func AgentAuth(token string, sessionID string) Auth {
	return Auth{mode: authAgent, token: token, principal: sessionID}
}

type Client struct {
	baseURL string
	auth    Auth
	http    *http.Client
}

func NewClient(baseURL string, httpClient *http.Client, auth Auth) *Client {
	if httpClient == nil {
		httpClient = http.DefaultClient
	}
	return &Client{
		baseURL: strings.TrimRight(baseURL, "/"),
		auth:    auth,
		http:    httpClient,
	}
}

func (c *Client) BaseURL() string {
	return c.baseURL
}

func (c *Client) Health(ctx context.Context) error {
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
		return fmt.Errorf("crabfleet API %s", resp.Status)
	}
	return nil
}

func (c *Client) State(ctx context.Context) (State, error) {
	var out State
	err := c.doJSON(ctx, http.MethodGet, "/api/ssh/state", nil, &out)
	return out, err
}

func (c *Client) Session(ctx context.Context, id string) (Session, error) {
	var out struct {
		Session Session `json:"session"`
	}
	err := c.doJSON(ctx, http.MethodGet, sessionPath(id), nil, &out)
	return out.Session, err
}

func (c *Client) CreateSession(ctx context.Context, request CreateSessionRequest) (Session, error) {
	var out struct {
		Session Session `json:"session"`
	}
	err := c.doJSON(ctx, http.MethodPost, "/api/ssh/interactive-sessions", request, &out)
	return out.Session, err
}

func (c *Client) Action(ctx context.Context, id string, action string) (Session, error) {
	var out struct {
		Session Session `json:"session"`
	}
	err := c.doJSON(
		ctx,
		http.MethodPost,
		sessionPath(id)+"/actions",
		map[string]string{"action": action},
		&out,
	)
	return out.Session, err
}

func (c *Client) Checkpoints(ctx context.Context, id string) (CheckpointsResult, error) {
	var out CheckpointsResult
	err := c.doJSON(ctx, http.MethodGet, sessionPath(id)+"/checkpoints", nil, &out)
	return out, err
}

func (c *Client) Checkpoint(ctx context.Context, id string) (CheckpointResult, error) {
	var out CheckpointResult
	err := c.doJSON(ctx, http.MethodPost, sessionPath(id)+"/checkpoints", nil, &out)
	return out, err
}

func (c *Client) Restore(ctx context.Context, id string, checkpointID string) (CheckpointResult, error) {
	var out CheckpointResult
	err := c.doJSON(
		ctx,
		http.MethodPost,
		sessionPath(id)+"/checkpoints/"+url.PathEscape(checkpointID)+"/restore",
		nil,
		&out,
	)
	return out, err
}

func (c *Client) Logs(ctx context.Context, id string) (SessionLogs, error) {
	var out SessionLogs
	err := c.doJSON(ctx, http.MethodGet, sessionPath(id)+"/logs", nil, &out)
	return out, err
}

func (c *Client) Transcript(ctx context.Context, id string) (string, error) {
	resp, err := c.open(ctx, http.MethodGet, sessionPath(id)+"/transcript", nil, "text/markdown")
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if err := responseError(resp); err != nil {
		return "", err
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, maxResponseBytes))
	return string(data), err
}

func (c *Client) UpdateSummary(ctx context.Context, id string, summary string, purpose string) (Session, error) {
	var out struct {
		Session Session `json:"session"`
	}
	err := c.doJSON(ctx, http.MethodPost, sessionPath(id)+"/summary", map[string]string{
		"summary": summary,
		"purpose": purpose,
	}, &out)
	return out.Session, err
}

func (c *Client) Message(
	ctx context.Context,
	id string,
	message string,
	enter bool,
	cols uint32,
	rows uint32,
) error {
	client, err := c.terminal(ctx, id, cols, rows)
	if err != nil {
		return err
	}
	defer client.Close()
	if enter {
		message += "\n"
	}
	return client.SendInput(ctx, []byte(message))
}

func (c *Client) Attach(
	ctx context.Context,
	id string,
	terminal io.ReadWriter,
	cols uint32,
	rows uint32,
	resizes <-chan TerminalSize,
) error {
	client, err := c.terminal(ctx, id, cols, rows)
	if err != nil {
		return err
	}
	defer client.Close()
	return client.Attach(ctx, terminal, resizes)
}

func (c *Client) terminal(ctx context.Context, id string, cols uint32, rows uint32) (*terminalws.Client, error) {
	endpoint, err := terminalws.Endpoint(c.baseURL)
	if err != nil {
		return nil, err
	}
	headers, err := c.auth.headers()
	if err != nil {
		return nil, err
	}
	return terminalws.Dial(ctx, endpoint, id, terminalws.Options{
		Header: headers,
		Cols:   cols,
		Rows:   rows,
	})
}

func (c *Client) doJSON(ctx context.Context, method string, path string, body any, out any) error {
	resp, err := c.open(ctx, method, path, body, "application/json")
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if err := responseError(resp); err != nil {
		return err
	}
	if out == nil {
		return nil
	}
	return json.NewDecoder(resp.Body).Decode(out)
}

func (c *Client) open(
	ctx context.Context,
	method string,
	path string,
	body any,
	accept string,
) (*http.Response, error) {
	apiPath, err := c.auth.path(path)
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
	if err := c.auth.apply(req.Header); err != nil {
		return nil, err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, err
	}
	return resp, nil
}

func responseError(resp *http.Response) error {
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		data, _ := io.ReadAll(io.LimitReader(resp.Body, maxErrorBytes))
		return fmt.Errorf("crabfleet API %s: %s", resp.Status, strings.TrimSpace(string(data)))
	}
	return nil
}

func (a Auth) path(path string) (string, error) {
	if err := a.validate(); err != nil {
		return "", err
	}
	if a.mode == authAgent {
		return strings.Replace(path, "/api/ssh/", "/api/agent/", 1), nil
	}
	return path, nil
}

func (a Auth) headers() (http.Header, error) {
	headers := http.Header{}
	if err := a.apply(headers); err != nil {
		return nil, err
	}
	return headers, nil
}

func (a Auth) apply(headers http.Header) error {
	if err := a.validate(); err != nil {
		return err
	}
	headers.Set("Authorization", "Bearer "+a.token)
	switch a.mode {
	case authSSH:
		headers.Set("X-Crabfleet-SSH-Fingerprint", a.principal)
	case authAgent:
		headers.Set("X-Crabfleet-Session-ID", a.principal)
	}
	return nil
}

func (a Auth) validate() error {
	if a.mode == authSSH && a.token != "" && a.principal != "" {
		return nil
	}
	if a.mode == authAgent && a.token != "" && a.principal != "" {
		return nil
	}
	return errors.New("API mode requires SSH gateway token + fingerprint or agent token + session ID")
}

func sessionPath(id string) string {
	return "/api/ssh/interactive-sessions/" + url.PathEscape(id)
}
