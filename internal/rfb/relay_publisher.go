package rfb

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"time"

	"github.com/coder/websocket"
)

var relayHostID = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]{0,79}$`)

// PublishRelay is the sole constructor of relay-authenticated sessions. The
// Worker authenticates the ownership token and the viewer's account before
// joining the stream. Direct listeners always keep their VNC challenge.
func (server *Server) PublishRelay(ctx context.Context, origin, hostID, ownershipToken string) error {
	endpoint, err := url.Parse(origin)
	if err != nil || endpoint.Host == "" || endpoint.User != nil || endpoint.RawQuery != "" || endpoint.Fragment != "" || (endpoint.Path != "" && endpoint.Path != "/") {
		return errors.New("invalid Fleet origin")
	}
	if endpoint.Scheme != "https" && !(endpoint.Scheme == "http" && (endpoint.Hostname() == "127.0.0.1" || endpoint.Hostname() == "::1" || endpoint.Hostname() == "localhost")) {
		return errors.New("Fleet relay requires HTTPS")
	}
	if !relayHostID.MatchString(hostID) || len(ownershipToken) < 16 || len(ownershipToken) > 200 {
		return errors.New("invalid relay registration")
	}
	if endpoint.Scheme == "https" {
		endpoint.Scheme = "wss"
	} else {
		endpoint.Scheme = "ws"
	}
	endpoint.Path = "/api/desktop-hosts/" + hostID + "/relay/host"
	client := &http.Client{Timeout: 15 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	socket, response, err := websocket.Dial(ctx, endpoint.String(), &websocket.DialOptions{HTTPClient: client, HTTPHeader: http.Header{"X-Crabfleet-Ownership-Token": []string{ownershipToken}}, CompressionMode: websocket.CompressionDisabled})
	if err != nil {
		if response != nil {
			if response.Body != nil {
				_ = response.Body.Close()
			}
			return fmt.Errorf("Fleet relay rejected the connection (HTTP %d)", response.StatusCode)
		}
		return errors.New("Fleet relay connection failed")
	}
	defer socket.CloseNow()
	connection := relayConnection{websocket.NetConn(ctx, socket, websocket.MessageBinary)}
	socket.SetReadLimit(512 << 10)
	input := server.inputs.newSession()
	server.mu.Lock()
	if input == nil || server.closed || len(server.active) >= server.config.MaxSessions {
		server.mu.Unlock()
		if input != nil {
			input.release(context.Background())
		}
		return errors.New("connector session limit reached")
	}
	server.active[connection] = struct{}{}
	server.wg.Add(1)
	server.mu.Unlock()
	defer server.wg.Done()
	defer func() {
		server.mu.Lock()
		delete(server.active, connection)
		server.mu.Unlock()
		cleanup, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
		defer cancel()
		input.release(cleanup)
	}()
	config := server.config.Session
	config.relay = true
	config.ChallengeReader = server.challenge
	config.Backend = &coordinatedBackend{Backend: config.Backend, input: input, capture: server.captures}
	return ServeConn(ctx, connection, config)
}

type relayConnection struct{ net.Conn }

func (c relayConnection) Write(p []byte) (int, error) { return c.Conn.Write(p[:min(len(p), 256<<10)]) }
