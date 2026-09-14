package connector

import (
	"context"
	"errors"
	"sync"
	"time"
)

type RelayPublisher func(context.Context, string, string, string) error

// Publication keeps the recovery identity durable before any remote write.
// Shutdown removes only the exact publication token, never a replacement host.
type Publication struct {
	Client *Client
	Store  *Store
	State  State
	Host   Host
	Report func(string)
	mu     sync.Mutex
}

func (p *Publication) Cleanup(ctx context.Context) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.State.PublicationID == "" {
		return nil
	}
	token, err := p.Client.Recover(ctx, p.State.HostID, p.State.PublicationID)
	if err != nil {
		return err
	}
	if token != "" {
		if err := p.Client.Remove(ctx, p.State.HostID, token); err != nil {
			return err
		}
	}
	p.State.PublicationID, p.State.OwnershipToken = "", ""
	return p.Store.Save(p.State)
}
func (p *Publication) Run(ctx context.Context, publish RelayPublisher) error {
	expires, err := p.Client.Renew(ctx)
	if err != nil {
		if ctx.Err() != nil {
			return nil
		}
		return err
	}
	p.State.ExpiresAt = expires
	if err := p.Store.Save(p.State); err != nil {
		return err
	}
	if err := p.Cleanup(ctx); err != nil {
		return err
	}
	id, err := RandomID()
	if err != nil {
		return err
	}
	p.State.PublicationID = id
	if err := p.Store.Save(p.State); err != nil {
		return err
	}
	defer func() {
		cleanup, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := p.Cleanup(cleanup); err != nil && p.Report != nil {
			p.Report("Fleet cleanup is pending; it will be retried on the next start.")
		}
	}()
	delay := time.Second
	for {
		token, err := p.Client.Register(ctx, p.State.HostID, id, p.Host)
		if err != nil {
			if terminalAPIError(err) {
				return err
			}
			token, err = p.Client.Recover(ctx, p.State.HostID, id)
			if terminalAPIError(err) {
				return err
			}
			if err != nil || token == "" {
				if err := wait(ctx, delay); err != nil {
					return nil
				}
				delay = min(delay*2, 30*time.Second)
				continue
			}
		}
		p.State.OwnershipToken = token
		if err := p.Store.Save(p.State); err != nil {
			return err
		}
		break
	}
	if p.Report != nil {
		p.Report("Desktop registered with Fleet.")
	}
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	renewErrors := make(chan error, 1)
	renewDone := make(chan struct{})
	go func() {
		defer close(renewDone)
		for {
			if err := wait(ctx, 5*time.Minute); err != nil {
				return
			}
			expires, err := p.Client.Renew(ctx)
			if err != nil {
				if terminalAPIError(err) || time.Now().UnixMilli() >= p.State.ExpiresAt {
					renewErrors <- err
					cancel()
					return
				}
				continue
			}
			p.mu.Lock()
			p.State.ExpiresAt = expires
			err = p.Store.Save(p.State)
			p.mu.Unlock()
			if err != nil {
				renewErrors <- err
				cancel()
				return
			}
		}
	}()
	defer func() { cancel(); <-renewDone }()
	delay = time.Second
	for {
		started := time.Now()
		_ = publish(ctx, p.Client.Origin, p.State.HostID, p.State.OwnershipToken)
		if ctx.Err() != nil {
			select {
			case err := <-renewErrors:
				return err
			default:
				return nil
			}
		}
		// Recovery also detects another publisher replacing this registration.
		token, err := p.Client.Recover(ctx, p.State.HostID, id)
		if err == nil && token == "" {
			if p.Report != nil {
				p.Report("This desktop registration was replaced; sharing stopped.")
			}
			return nil
		}
		if terminalAPIError(err) {
			return err
		}
		if err == nil && token != p.State.OwnershipToken {
			p.mu.Lock()
			p.State.OwnershipToken = token
			err = p.Store.Save(p.State)
			p.mu.Unlock()
			if err != nil {
				return err
			}
		}
		if time.Since(started) > time.Minute {
			delay = time.Second
		}
		if err := wait(ctx, delay); err != nil {
			continue
		}
		delay = min(delay*2, 30*time.Second)
	}
}
func terminalAPIError(err error) bool {
	var e *APIError
	return errors.As(err, &e) && e.Status >= 400 && e.Status < 500 && e.Status != 408 && e.Status != 429
}
