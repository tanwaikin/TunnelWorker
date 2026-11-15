package tunnel

import (
	"context"
	"errors"
	"net"
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"
)

func TestRequestTargetKeepsLocalOriginAndQuery(t *testing.T) {
	base, _ := url.Parse("http://127.0.0.1:3000/app")
	got, err := requestTarget(base, "/users/a%20b?q=1&x=two")
	if err != nil {
		t.Fatal(err)
	}
	if got != "http://127.0.0.1:3000/app/users/a%20b?q=1&x=two" {
		t.Fatalf("request target = %q", got)
	}
	got, err = requestTarget(base, "/object/a%2Fb")
	if err != nil {
		t.Fatal(err)
	}
	if got != "http://127.0.0.1:3000/app/object/a%2Fb" {
		t.Fatalf("escaped request target = %q", got)
	}
	for _, path := range []string{"https://attacker.invalid/x", "//attacker.invalid/x", "broken"} {
		if _, err := requestTarget(base, path); err == nil {
			t.Errorf("requestTarget accepted %q", path)
		}
	}
}

func TestControlHandshakeRejectionIsTerminal(t *testing.T) {
	t.Setenv("NO_PROXY", "127.0.0.1,localhost")
	t.Setenv("no_proxy", "127.0.0.1,localhost")
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	server := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusGone) })}
	go server.Serve(listener)
	defer server.Close()
	base, _ := url.Parse("http://" + listener.Addr().String())
	a := New(Config{BaseURL: base, ID: "0123456789abcdef0123456789abcdef0123", Token: "token"})
	err = a.runOnce(context.Background())
	var terminal *terminalError
	if !errors.As(err, &terminal) || terminal.status != http.StatusGone {
		t.Fatalf("runOnce error = %v, want terminal 410", err)
	}
}

func TestRunReportsSanitizedReconnectStatus(t *testing.T) {
	t.Setenv("NO_PROXY", "127.0.0.1,localhost")
	t.Setenv("no_proxy", "127.0.0.1,localhost")
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	server := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusServiceUnavailable) })}
	go server.Serve(listener)
	defer server.Close()
	base, _ := url.Parse("http://" + listener.Addr().String())
	ctx, cancel := context.WithCancel(context.Background())
	var status string
	a := New(Config{BaseURL: base, ID: "0123456789abcdef0123456789abcdef0123", Token: "must-not-be-logged", OnStatus: func(message string) { status = message; cancel() }})
	err = a.Run(ctx)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("Run error = %v, want context cancellation", err)
	}
	if !strings.Contains(status, "retry 1 in") || !strings.Contains(status, "HTTP 503") {
		t.Fatalf("status = %q", status)
	}
	if strings.Contains(status, "must-not-be-logged") {
		t.Fatalf("status exposed a credential: %q", status)
	}
}

func TestRunStopsWhenOriginalExpiryHasPassed(t *testing.T) {
	base, _ := url.Parse("http://127.0.0.1:1")
	a := New(Config{BaseURL: base, ID: "0123456789abcdef0123456789abcdef0123", Token: "token", ExpiresAt: time.Now().Add(-time.Second).UnixMilli()})
	if err := a.Run(context.Background()); err == nil || !strings.Contains(err.Error(), "expiry") {
		t.Fatalf("Run error = %v", err)
	}
}

func TestHeaderForwardingStripsHopByHopAndPreservesCookies(t *testing.T) {
	src := map[string][]string{
		"Connection": {"keep-alive, x-private"},
		"Keep-Alive": {"timeout=5"},
		"X-Private":  {"drop"},
		"Cookie":     {"a=1", "b=2"},
		"Origin":     {"https://foreign.example"},
	}
	got := make(http.Header)
	copyHeaders(got, src)
	if got.Get("Connection") != "" || got.Get("Keep-Alive") != "" || got.Get("X-Private") != "" {
		t.Fatalf("hop headers survived: %#v", got)
	}
	if len(got.Values("Cookie")) != 2 {
		t.Fatalf("cookie values = %#v", got.Values("Cookie"))
	}
	if got.Get("Origin") != "https://foreign.example" {
		t.Fatalf("Origin changed: %q", got.Get("Origin"))
	}
	response := responseHeaders(http.Header{"Set-Cookie": {"a=1", "b=2"}, "Connection": {"close"}, "X-Test": {"ok"}})
	if len(response["Set-Cookie"]) != 2 {
		t.Fatalf("Set-Cookie values = %#v", response["Set-Cookie"])
	}
	if _, ok := response["Connection"]; ok {
		t.Fatalf("Connection forwarded: %#v", response)
	}
}

func TestTranslateOnlyExactPublicOrigin(t *testing.T) {
	local, _ := url.Parse("http://127.0.0.1:3000")
	cfg := Config{ID: "abc", Domain: "example.test", LocalURL: local}
	for input, want := range map[string]string{
		"https://abc.example.test":              "http://127.0.0.1:3000",
		"https://foreign.example":               "https://foreign.example",
		"null":                                  "null",
		"https://abc.example.test.evil.example": "https://abc.example.test.evil.example",
	} {
		got := translatePublicOrigin(map[string][]string{"Origin": {input}}, cfg)["Origin"][0]
		if got != want {
			t.Errorf("Origin %q translated to %q, want %q", input, got, want)
		}
	}
}

func TestControlURLAndHostRouteByTunnelID(t *testing.T) {
	base, _ := url.Parse("http://127.0.0.1:8787")
	a := New(Config{BaseURL: base, ID: "0123456789abcdef0123456789abcdef0123", Token: "private"})
	u, host := a.controlURL()
	if u.String() != "ws://127.0.0.1:8787/api/tunnels/0123456789abcdef0123456789abcdef0123/connect" {
		t.Fatalf("control URL = %s", u)
	}
	if host != "example.test" {
		t.Fatalf("local Wrangler Host = %s", host)
	}
	remote, _ := url.Parse("https://tunnel.example.test")
	u, host = New(Config{BaseURL: remote, ID: "0123456789abcdef0123456789abcdef0123", Token: "private"}).controlURL()
	if u.String() != "wss://tunnel.example.test/api/tunnels/0123456789abcdef0123456789abcdef0123/connect" {
		t.Fatalf("production control URL = %s", u)
	}
	if host != "" {
		t.Fatalf("production Host override = %q, want none", host)
	}
}

func TestSendRejectsOversizedControlMessage(t *testing.T) {
	r := &runtime{}
	err := r.send(envelope{Type: "http_start", Headers: map[string][]string{"X-Large": {strings.Repeat("x", maxControlJSON)}}})
	if err == nil || !strings.Contains(err.Error(), "size limit") {
		t.Fatalf("send error = %v", err)
	}
}
