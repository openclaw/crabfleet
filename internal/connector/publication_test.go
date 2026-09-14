//go:build linux

package connector

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestPublicationRecoversLostRegistrationResponseAndCleansOnlyItsToken(t *testing.T) {
	store, err := OpenStore(filepath.Join(t.TempDir(), "config"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	state, _ := store.Load()
	state.ExpiresAt = time.Now().Add(time.Minute).UnixMilli()
	renewedExpiry := time.Now().Add(24 * time.Hour).UnixMilli()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	var mu sync.Mutex
	var publication, token string
	var removed, renewed bool
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.URL.Path == "/api/connector/v1/auth/renew":
			renewed = true
			_ = json.NewEncoder(w).Encode(map[string]int64{"expiresAt": renewedExpiry})
		case r.Method == "PUT":
			if !renewed {
				t.Error("registered before refreshing the nearly expired authorization")
			}
			publication = r.Header.Get("X-Crabfleet-Publication-Id")
			persisted, err := ReadState(filepath.Dir(store.path))
			if err != nil || persisted.PublicationID != publication {
				t.Error("remote write preceded durable recovery identity")
			}
			if persisted.ExpiresAt != renewedExpiry {
				t.Error("renewed authorization was not persisted before registration")
			}
			token = "fixture-ownership-token"
			http.Error(w, "lost response", 503)
		case r.Method == "POST":
			value := ""
			if r.Header.Get("X-Crabfleet-Publication-Id") == publication {
				value = token
			}
			_ = json.NewEncoder(w).Encode(map[string]string{"ownershipToken": value})
		case r.Method == "DELETE":
			if r.Header.Get("X-Crabfleet-Ownership-Token") != token {
				t.Error("cleanup used the wrong token")
			}
			removed = true
			token = ""
			_, _ = w.Write([]byte(`{}`))
		default:
			t.Error("unexpected API request")
			http.NotFound(w, r)
		}
	}))
	defer api.Close()
	client, _ := NewClient(api.URL, "fixture-access-token")
	p := Publication{Client: client, Store: store, State: state, Host: Host{Name: "Test", RelayOnly: true}}
	called := false
	err = p.Run(ctx, func(ctx context.Context, origin, id, ownership string) error {
		called = true
		if ownership != "fixture-ownership-token" {
			t.Error("did not recover ownership")
		}
		cancel()
		return ctx.Err()
	})
	if err != nil {
		t.Fatal(err)
	}
	if !called || !removed {
		t.Fatal("publication or cleanup did not run")
	}
	loaded, err := store.Load()
	if err != nil || loaded.PublicationID != "" || loaded.OwnershipToken != "" {
		t.Fatal("cleanup state was retained")
	}
}

func TestReplacedPublicationStopsWithoutReclaimingOrDeletingHost(t *testing.T) {
	store, err := OpenStore(filepath.Join(t.TempDir(), "config"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	state, _ := store.Load()
	registrations, removals := 0, 0
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.URL.Path == "/api/connector/v1/auth/renew":
			_ = json.NewEncoder(w).Encode(map[string]int64{"expiresAt": time.Now().Add(24 * time.Hour).UnixMilli()})
		case r.Method == "PUT":
			registrations++
			_, _ = w.Write([]byte(`{"ownershipToken":"fixture-original-owner"}`))
		case r.Method == "POST":
			_, _ = w.Write([]byte(`{"ownershipToken":""}`))
		case r.Method == "DELETE":
			removals++
			_, _ = w.Write([]byte(`{}`))
		default:
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
			http.NotFound(w, r)
		}
	}))
	defer api.Close()
	client, _ := NewClient(api.URL, "fixture-access-token")
	var reports []string
	p := Publication{
		Client: client, Store: store, State: state, Host: Host{Name: "Test", RelayOnly: true},
		Report: func(message string) { reports = append(reports, message) },
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	calls := 0
	err = p.Run(ctx, func(context.Context, string, string, string) error { calls++; return nil })
	if err != nil || ctx.Err() != nil || calls != 1 || registrations != 1 || removals != 0 {
		t.Fatalf("replacement result: err=%v context=%v calls=%d registrations=%d removals=%d", err, ctx.Err(), calls, registrations, removals)
	}
	if !strings.Contains(strings.Join(reports, "\n"), "replaced; sharing stopped") {
		t.Fatalf("missing replacement explanation: %v", reports)
	}
	loaded, err := store.Load()
	if err != nil || loaded.PublicationID != "" || loaded.OwnershipToken != "" {
		t.Fatal("retained replaced publication state")
	}
}

func TestPublicationStopsAfterTerminalRegistrationRecoveryError(t *testing.T) {
	store, err := OpenStore(filepath.Join(t.TempDir(), "config"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	state, err := store.Load()
	if err != nil {
		t.Fatal(err)
	}
	registrations := 0
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/api/connector/v1/auth/renew":
			_ = json.NewEncoder(w).Encode(map[string]int64{"expiresAt": time.Now().Add(24 * time.Hour).UnixMilli()})
		case r.Method == "PUT":
			registrations++
			w.WriteHeader(http.StatusServiceUnavailable)
		case r.Method == "POST":
			w.WriteHeader(http.StatusForbidden)
		default:
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
			w.WriteHeader(http.StatusBadRequest)
		}
	}))
	defer api.Close()
	client, err := NewClient(api.URL, "fixture-access-token")
	if err != nil {
		t.Fatal(err)
	}
	p := Publication{Client: client, Store: store, State: state, Host: Host{Name: "Test", RelayOnly: true}}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	err = p.Run(ctx, func(context.Context, string, string, string) error {
		t.Error("published after recovery failed")
		return nil
	})
	var apiError *APIError
	if !errors.As(err, &apiError) || apiError.Status != http.StatusForbidden || ctx.Err() != nil || registrations != 1 {
		t.Fatalf("recovery: err=%v context=%v registrations=%d", err, ctx.Err(), registrations)
	}
	loaded, err := store.Load()
	if err != nil || loaded.PublicationID == "" {
		t.Fatalf("lost pending cleanup identity: %v", err)
	}
}
