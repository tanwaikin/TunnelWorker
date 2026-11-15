package control

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

func TestCreateUsesApexHostAndTTLSeconds(t *testing.T) {
	var seenHost, seenAuth string
	var body map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seenHost, seenAuth = r.Host, r.Header.Get("Authorization")
		if r.URL.Path != "/api/tunnels" || r.Method != http.MethodPost {
			t.Errorf("request = %s %s", r.Method, r.URL.Path)
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"id":"0123456789abcdef0123456789abcdef0123","url":"https://0123456789abcdef0123456789abcdef0123.example.test","connectorToken":"connector-secret","expiresAt":1730000000000}`))
	}))
	defer srv.Close()
	u, _ := url.Parse(srv.URL)
	got, err := New(u).Create(context.Background(), "operator-secret", 30*time.Minute, "visitor-secret")
	if err != nil {
		t.Fatal(err)
	}
	if seenHost != "example.test" {
		t.Fatalf("Host = %q, want example.test", seenHost)
	}
	if seenAuth != "Bearer operator-secret" {
		t.Fatalf("Authorization = %q", seenAuth)
	}
	if body["ttlSeconds"] != float64(1800) || body["visitorPassword"] != "visitor-secret" {
		t.Fatalf("create body = %#v", body)
	}
	if got.ID != "0123456789abcdef0123456789abcdef0123" || got.ConnectorToken != "connector-secret" {
		t.Fatalf("create result = %#v", got)
	}
}

func TestRevokeUsesPathRoutingAndControlHost(t *testing.T) {
	const id = "0123456789abcdef0123456789abcdef0123"
	var seenHost, seenAuth, seenPath, seenMethod string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seenHost, seenAuth, seenPath, seenMethod = r.Host, r.Header.Get("Authorization"), r.URL.Path, r.Method
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer srv.Close()
	u, _ := url.Parse(srv.URL)
	if err := New(u).Revoke(context.Background(), id, "connector-secret"); err != nil {
		t.Fatal(err)
	}
	if seenHost != "example.test" || seenAuth != "Bearer connector-secret" || seenPath != "/api/tunnels/"+id || seenMethod != http.MethodDelete {
		t.Fatalf("revoke request = %s %s Host=%q Authorization=%q", seenMethod, seenPath, seenHost, seenAuth)
	}
}

func TestRevokeRejectsInvalidTunnelID(t *testing.T) {
	u, _ := url.Parse("http://127.0.0.1:1")
	if err := New(u).Revoke(context.Background(), "bad/id", "connector-secret"); err == nil || !strings.Contains(err.Error(), "invalid tunnel ID") {
		t.Fatalf("Revoke error = %v, want invalid tunnel ID", err)
	}
}

func TestRevokeUsesControlHostForRemoteEndpoint(t *testing.T) {
	const id = "0123456789abcdef0123456789abcdef0123"
	var seenHost string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seenHost = r.Host
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()
	remote, _ := url.Parse("http://control.example.test")
	remote.Host = strings.TrimPrefix(srv.URL, "http://")
	client := NewWithDomain(remote, "control.example.test")
	if err := client.Revoke(context.Background(), id, "connector-secret"); err != nil {
		t.Fatal(err)
	}
	if seenHost != "control.example.test" {
		t.Fatalf("Host = %q, want control.example.test", seenHost)
	}
}

func TestRouteDomainUsesLocalDefaultAndCustomDomain(t *testing.T) {
	local, _ := url.Parse("http://127.0.0.1:8787")
	if got, err := RouteDomain(local, ""); err != nil || got != "example.test" {
		t.Fatalf("local domain = %q, %v", got, err)
	}
	remote, _ := url.Parse("https://control.example.org")
	if got, err := RouteDomain(remote, ""); err != nil || got != "control.example.org" {
		t.Fatalf("remote domain = %q, %v", got, err)
	}
	if got, err := RouteDomain(local, "Tunnel.Example.org."); err != nil || got != "tunnel.example.org" {
		t.Fatalf("override = %q, %v", got, err)
	}
	for _, invalid := range []string{"bad:8787", "bad/path", "-invalid.example", "127.0.0.1"} {
		if _, err := RouteDomain(local, invalid); err == nil {
			t.Errorf("RouteDomain accepted %q", invalid)
		}
	}
}

func TestAPIErrorDoesNotExposeResponseBody(t *testing.T) {
	err := apiError("create tunnel", &http.Response{StatusCode: http.StatusUnauthorized, Body: http.NoBody})
	if strings.Contains(err.Error(), "secret") {
		t.Fatalf("error exposed server body: %v", err)
	}
	if !strings.Contains(err.Error(), "401") {
		t.Fatalf("error lacks status: %v", err)
	}
}
