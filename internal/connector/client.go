// Package connector owns the Linux connector's Fleet identity and publication.
package connector

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

type Client struct {
	Origin, Token string
	HTTP          *http.Client
}
type APIError struct{ Status int }

func (e *APIError) Error() string { return fmt.Sprintf("Fleet request failed (HTTP %d)", e.Status) }
func NewClient(origin, token string) (*Client, error) {
	u, err := url.Parse(origin)
	if err != nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || (u.Path != "" && u.Path != "/") {
		return nil, errors.New("server must be a Fleet origin, such as https://fleet.example.com")
	}
	if u.Scheme != "https" && !(u.Scheme == "http" && (u.Hostname() == "127.0.0.1" || u.Hostname() == "localhost" || u.Hostname() == "::1")) {
		return nil, errors.New("Fleet sign-in requires HTTPS")
	}
	return &Client{Origin: strings.TrimSuffix(u.String(), "/"), Token: token, HTTP: &http.Client{Timeout: 15 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}, nil
}
func (c *Client) request(ctx context.Context, method, path string, body any, headers http.Header, out any) (http.Header, int, error) {
	var reader io.Reader
	if body != nil {
		p, err := json.Marshal(body)
		if err != nil {
			return nil, 0, err
		}
		reader = bytes.NewReader(p)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.Origin+path, reader)
	if err != nil {
		return nil, 0, err
	}
	if c.Token != "" {
		req.Header.Set("Authorization", "Bearer "+c.Token)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	req.Header.Set("Accept", "application/json")
	for name, values := range headers {
		req.Header[name] = values
	}
	res, err := c.HTTP.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return nil, 0, ctx.Err()
		}
		return nil, 0, errors.New("could not reach Fleet")
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		_, _ = io.CopyN(io.Discard, res.Body, 4096)
		return res.Header, res.StatusCode, &APIError{res.StatusCode}
	}
	p, err := io.ReadAll(io.LimitReader(res.Body, (1<<20)+1))
	if err != nil {
		return nil, res.StatusCode, err
	}
	if len(p) > 1<<20 {
		return nil, res.StatusCode, errors.New("Fleet response is too large")
	}
	if out != nil {
		if err := json.Unmarshal(p, out); err != nil {
			return nil, res.StatusCode, errors.New("invalid Fleet response")
		}
	}
	return res.Header, res.StatusCode, nil
}

type DeviceAuthorization struct {
	DeviceCode      string `json:"deviceCode"`
	VerificationURI string `json:"verificationUri"`
	ExpiresAt       int64  `json:"expiresAt"`
	Interval        int    `json:"intervalSeconds"`
}
type Authorization struct {
	AccessToken string `json:"accessToken"`
	ExpiresAt   int64  `json:"expiresAt"`
	User        struct {
		Login   string `json:"login"`
		Subject string `json:"subject"`
	} `json:"user"`
}

func (c *Client) StartLogin(ctx context.Context, name string) (DeviceAuthorization, error) {
	var result DeviceAuthorization
	_, _, err := c.request(ctx, "POST", "/api/native/v1/auth/device", map[string]string{"clientName": name, "scope": "desktop:publish"}, nil, &result)
	if err != nil {
		return result, err
	}
	u, err := url.Parse(result.VerificationURI)
	origin, _ := url.Parse(c.Origin)
	if err != nil || u.User != nil || u.Scheme != origin.Scheme || u.Host != origin.Host || !strings.HasPrefix(u.Path, "/native/link/") || u.RawQuery != "" || u.Fragment != "" || len(result.DeviceCode) < 16 || len(result.DeviceCode) > 256 || result.Interval < 1 || result.Interval > 60 || result.ExpiresAt <= time.Now().UnixMilli() || result.ExpiresAt > time.Now().Add(15*time.Minute).UnixMilli() {
		return DeviceAuthorization{}, errors.New("invalid Fleet sign-in response")
	}
	return result, nil
}
func (c *Client) AwaitLogin(ctx context.Context, device DeviceAuthorization) (Authorization, error) {
	ctx, cancel := context.WithDeadline(ctx, time.UnixMilli(device.ExpiresAt))
	defer cancel()
	delay := time.Duration(device.Interval) * time.Second
	for {
		if err := wait(ctx, delay); err != nil {
			return Authorization{}, err
		}
		var result Authorization
		headers, code, err := c.request(ctx, "POST", "/api/native/v1/auth/token", map[string]string{"deviceCode": device.DeviceCode}, nil, &result)
		if code == 202 || code == 429 {
			if n, e := strconv.Atoi(headers.Get("Retry-After")); e == nil && n >= 1 && n <= 60 {
				delay = time.Duration(n) * time.Second
			}
			continue
		}
		if err != nil {
			if (code == 0 || code >= 500) && ctx.Err() == nil {
				delay = min(delay*2, 30*time.Second)
				continue
			}
			return result, err
		}
		if len(result.AccessToken) < 16 || len(result.AccessToken) > 256 || result.ExpiresAt <= time.Now().UnixMilli() {
			return Authorization{}, errors.New("invalid Fleet authorization")
		}
		return result, nil
	}
}
func (c *Client) Session(ctx context.Context) error {
	_, _, err := c.request(ctx, "GET", "/api/connector/v1/session", nil, nil, nil)
	return err
}
func (c *Client) Renew(ctx context.Context) (int64, error) {
	var r struct {
		ExpiresAt int64 `json:"expiresAt"`
	}
	_, _, err := c.request(ctx, "POST", "/api/connector/v1/auth/renew", nil, nil, &r)
	if err == nil && (r.ExpiresAt <= time.Now().UnixMilli() || r.ExpiresAt > time.Now().Add(25*time.Hour).UnixMilli()) {
		err = errors.New("invalid Fleet renewal")
	}
	return r.ExpiresAt, err
}
func (c *Client) Logout(ctx context.Context) error {
	_, _, err := c.request(ctx, "DELETE", "/api/native/v1/auth/token", nil, nil, nil)
	return err
}

type Host struct {
	Name      string `json:"name"`
	Address   string `json:"address,omitempty"`
	Port      int    `json:"port,omitempty"`
	RelayOnly bool   `json:"relayOnly"`
}

func (c *Client) Register(ctx context.Context, id, publication string, host Host) (string, error) {
	var r struct {
		OwnershipToken string `json:"ownershipToken"`
	}
	_, _, err := c.request(ctx, "PUT", "/api/connector/v1/desktop-hosts/"+url.PathEscape(id), host, http.Header{"X-Crabfleet-Publication-Id": []string{publication}}, &r)
	if err == nil && (len(r.OwnershipToken) < 16 || len(r.OwnershipToken) > 200) {
		err = errors.New("invalid Fleet ownership response")
	}
	return r.OwnershipToken, err
}
func (c *Client) Recover(ctx context.Context, id, publication string) (string, error) {
	var r struct {
		OwnershipToken string `json:"ownershipToken"`
	}
	_, _, err := c.request(ctx, "POST", "/api/connector/v1/desktop-hosts/"+url.PathEscape(id)+"/recover", nil, http.Header{"X-Crabfleet-Publication-Id": []string{publication}}, &r)
	// An empty token means this publication no longer owns the registration.
	if err == nil && r.OwnershipToken != "" && (len(r.OwnershipToken) < 16 || len(r.OwnershipToken) > 200) {
		err = errors.New("invalid Fleet ownership response")
	}
	return r.OwnershipToken, err
}
func (c *Client) Remove(ctx context.Context, id, ownership string) error {
	_, _, err := c.request(ctx, "DELETE", "/api/connector/v1/desktop-hosts/"+url.PathEscape(id), nil, http.Header{"X-Crabfleet-Ownership-Token": []string{ownership}}, nil)
	return err
}
func wait(ctx context.Context, d time.Duration) error {
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}
