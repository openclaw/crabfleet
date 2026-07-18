package rfb

import (
	"context"
	"errors"
	"io"
	"net"
	"sync"
	"time"
)

const defaultMaxSessions = 16

type ServerConfig struct {
	Session     SessionConfig
	MaxSessions int
}

type Server struct {
	config ServerConfig

	mu        sync.Mutex
	listener  net.Listener
	active    map[net.Conn]struct{}
	closed    bool
	closeErr  error
	close     sync.Once
	closedCh  chan struct{}
	cancel    context.CancelFunc
	inputs    *inputCoordinator
	captures  *captureCoordinator
	challenge *lockedReader
	wg        sync.WaitGroup
}

type lockedReader struct {
	mu     sync.Mutex
	reader io.Reader
}

func (reader *lockedReader) Read(payload []byte) (int, error) {
	reader.mu.Lock()
	defer reader.mu.Unlock()
	return reader.reader.Read(payload)
}

func NewServer(config ServerConfig) (*Server, error) {
	normalized, err := config.Session.normalized()
	if err != nil {
		return nil, err
	}
	config.Session = normalized
	if config.MaxSessions == 0 {
		config.MaxSessions = defaultMaxSessions
	}
	if config.MaxSessions < 1 || config.MaxSessions > 1024 {
		return nil, errors.New("invalid maximum session count")
	}
	return &Server{
		config:    config,
		active:    make(map[net.Conn]struct{}),
		closedCh:  make(chan struct{}),
		inputs:    newInputCoordinator(config.Session.Backend),
		captures:  &captureCoordinator{backend: config.Session.Backend},
		challenge: &lockedReader{reader: config.Session.ChallengeReader},
	}, nil
}

func (server *Server) Serve(ctx context.Context, listener net.Listener) error {
	if listener == nil {
		return errors.New("RFB listener is required")
	}
	server.mu.Lock()
	if server.closed || server.listener != nil {
		server.mu.Unlock()
		return errors.New("RFB server is already serving or closed")
	}
	server.listener = listener
	sessionContext, cancel := context.WithCancel(ctx)
	server.cancel = cancel
	server.mu.Unlock()

	go func() {
		select {
		case <-ctx.Done():
			_ = server.Close()
		case <-server.closedCh:
		}
	}()

	for {
		connection, err := listener.Accept()
		if err != nil {
			server.mu.Lock()
			closed := server.closed
			server.mu.Unlock()
			if closed || ctx.Err() != nil {
				return nil
			}
			return err
		}
		server.mu.Lock()
		if server.closed || len(server.active) >= server.config.MaxSessions {
			server.mu.Unlock()
			_ = connection.Close()
			continue
		}
		server.active[connection] = struct{}{}
		input := server.inputs.newSession()
		server.wg.Add(1)
		server.mu.Unlock()
		go func() {
			defer server.wg.Done()
			defer connection.Close() //nolint:errcheck // session error is already terminal
			defer func() {
				ctx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
				defer cancel()
				input.release(ctx)
			}()
			sessionConfig := server.config.Session
			sessionConfig.ChallengeReader = server.challenge
			sessionConfig.Backend = &coordinatedBackend{
				Backend: sessionConfig.Backend,
				input:   input,
				capture: server.captures,
			}
			_ = ServeConn(sessionContext, connection, sessionConfig)
			server.mu.Lock()
			delete(server.active, connection)
			server.mu.Unlock()
		}()
	}
}

func (server *Server) Close() error {
	server.close.Do(func() {
		server.mu.Lock()
		server.closed = true
		close(server.closedCh)
		listener := server.listener
		cancel := server.cancel
		connections := make([]net.Conn, 0, len(server.active))
		for connection := range server.active {
			connections = append(connections, connection)
		}
		server.mu.Unlock()
		if cancel != nil {
			cancel()
		}
		if listener != nil {
			server.closeErr = listener.Close()
		}
		for _, connection := range connections {
			_ = connection.Close()
		}
		server.wg.Wait()
		cleanupContext, cleanupCancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
		server.inputs.releaseAll(cleanupContext)
		cleanupCancel()
		if err := server.config.Session.Backend.Close(); server.closeErr == nil {
			server.closeErr = err
		}
	})
	return server.closeErr
}
