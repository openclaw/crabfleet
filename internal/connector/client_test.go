package connector

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestClientRestrictsOriginsAndRedirects(t *testing.T) {
	for _, origin := range []string{"http://fleet.example", "https://user:password@fleet.example", "https://fleet.example/path", "https://fleet.example?token=x", "https://fleet.example#fragment"} {
		if _, err := NewClient(origin, "fixture-token"); err == nil {
			t.Fatalf("accepted %s", origin)
		}
	}
	forwarded := false
	destination := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { forwarded = true; w.WriteHeader(200) }))
	defer destination.Close()
	redirect := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, destination.URL, 302) }))
	defer redirect.Close()
	client, _ := NewClient(redirect.URL, "fixture-secret")
	if err := client.Session(context.Background()); err == nil {
		t.Fatal("accepted redirect")
	}
	if forwarded {
		t.Fatal("followed an authenticated redirect")
	}
}
func TestClientLoginPublicationAndRenewal(t *testing.T) {
	var server *httptest.Server
	server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/api/native/v1/auth/device":
			var body map[string]string
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Error(err)
			}
			if body["scope"] != "desktop:publish" {
				t.Error("missing connector scope")
			}
			_ = json.NewEncoder(w).Encode(DeviceAuthorization{DeviceCode: strings.Repeat("d", 32), VerificationURI: server.URL + "/native/link/fixture", ExpiresAt: time.Now().Add(time.Minute).UnixMilli(), Interval: 1})
		case "/api/connector/v1/desktop-hosts/linux-test":
			if r.Header.Get("Authorization") != "Bearer fixture-token" || r.Header.Get("X-Crabfleet-Publication-Id") != "publication-fixture" {
				t.Error("missing publication authorization")
			}
			var host Host
			_ = json.NewDecoder(r.Body).Decode(&host)
			if !host.RelayOnly {
				t.Error("not relay only")
			}
			_, _ = w.Write([]byte(`{"ownershipToken":"fixture-ownership-token"}`))
		case "/api/connector/v1/auth/renew":
			_ = json.NewEncoder(w).Encode(map[string]int64{"expiresAt": time.Now().Add(24 * time.Hour).UnixMilli()})
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	client, _ := NewClient(server.URL, "fixture-token")
	if _, err := client.StartLogin(context.Background(), "Linux fixture"); err != nil {
		t.Fatal(err)
	}
	if token, err := client.Register(context.Background(), "linux-test", "publication-fixture", Host{Name: "Linux", RelayOnly: true}); err != nil || token != "fixture-ownership-token" {
		t.Fatalf("register: %q %v", token, err)
	}
	if _, err := client.Renew(context.Background()); err != nil {
		t.Fatal(err)
	}
}
