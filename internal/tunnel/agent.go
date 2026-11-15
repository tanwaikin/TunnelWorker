package tunnel

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math/rand"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/gorilla/websocket"
)

const maxControlFrame = 96 << 10

type Config struct {
	BaseURL, LocalURL *url.URL
	ID, Token         string
	Domain            string
	ExpiresAt         int64
	OnStatus          func(string)
}
type Agent struct{ cfg Config }

func New(cfg Config) *Agent { return &Agent{cfg: cfg} }

func (a *Agent) Run(ctx context.Context) error {
	if !validTunnelID(a.cfg.ID) || a.cfg.Token == "" {
		return errors.New("tunnel ID and connector credential are required")
	}
	delay := time.Second
	attempt := 0
	for {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if a.cfg.ExpiresAt > 0 && time.Now().UnixMilli() >= a.cfg.ExpiresAt {
			return errors.New("tunnel has reached its original expiry")
		}
		started := time.Now()
		err := a.runOnce(ctx)
		if ctx.Err() != nil {
			return ctx.Err()
		}
		var terminal *terminalError
		if errors.As(err, &terminal) {
			a.status(fmt.Sprintf("control connection rejected with HTTP %d; stopping", terminal.status))
			return err
		}
		if time.Since(started) >= 30*time.Second {
			delay = time.Second
			attempt = 0
		}
		if err == nil {
			err = errors.New("control connection closed")
		}
		attempt++
		// Reconnect uses the existing ID and credential; this neither extends TTL nor creates a new URL.
		wait := jitter(delay)
		a.status(fmt.Sprintf("control connection unavailable; retry %d in %.1fs (%s)", attempt, wait.Seconds(), safeFailure(err)))
		timer := time.NewTimer(wait)
		select {
		case <-ctx.Done():
			timer.Stop()
			return ctx.Err()
		case <-timer.C:
		}
		if delay < 30*time.Second {
			delay *= 2
			if delay > 30*time.Second {
				delay = 30 * time.Second
			}
		}
	}
}

func validTunnelID(id string) bool {
	if len(id) != 36 {
		return false
	}
	for _, c := range id {
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f') {
			return false
		}
	}
	return true
}

func (a *Agent) status(message string) {
	if a.cfg.OnStatus != nil {
		a.cfg.OnStatus(message)
	}
}

func safeFailure(err error) string {
	var handshake *handshakeError
	if errors.As(err, &handshake) {
		return fmt.Sprintf("HTTP %d", handshake.status)
	}
	var network net.Error
	if errors.As(err, &network) {
		if network.Timeout() {
			return "network timeout"
		}
		return "network error"
	}
	return "control connection closed"
}

func jitter(d time.Duration) time.Duration {
	// +/-20%, capped to keep the reconnect cadence bounded.
	r := rand.New(rand.NewSource(time.Now().UnixNano()))
	return time.Duration(float64(d) * (0.8 + r.Float64()*0.4))
}

func (a *Agent) controlURL() (*url.URL, string) {
	u := *a.cfg.BaseURL
	if u.Scheme == "https" {
		u.Scheme = "wss"
	} else {
		u.Scheme = "ws"
	}
	u.Path = strings.TrimRight(u.Path, "/") + "/api/tunnels/" + a.cfg.ID + "/connect"
	u.RawQuery = ""
	u.Fragment = ""
	// Wrangler's local dev server listens on loopback but routes requests by
	// the virtual Host. Production control connections use the URL hostname.
	host := ""
	hostname := strings.ToLower(u.Hostname())
	ip := net.ParseIP(hostname)
	if ip != nil && ip.IsLoopback() || hostname == "localhost" || strings.HasSuffix(hostname, ".localhost") {
		host = a.cfg.Domain
		if host == "" {
			host = "example.test"
		}
	}
	return &u, host
}

type terminalError struct{ status int }

func (e *terminalError) Error() string {
	return fmt.Sprintf("control connection rejected with HTTP %d; tunnel credentials may be invalid or expired", e.status)
}

type handshakeError struct{ status int }

func (e *handshakeError) Error() string {
	return fmt.Sprintf("control handshake rejected with HTTP %d", e.status)
}

func (a *Agent) runOnce(ctx context.Context) error {
	u, localHost := a.controlURL()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+a.cfg.Token)
	if localHost != "" {
		req.Header.Set("Host", localHost)
	}
	dialer := websocket.Dialer{Proxy: http.ProxyFromEnvironment, HandshakeTimeout: 15 * time.Second, EnableCompression: false}
	conn, resp, err := dialer.DialContext(ctx, u.String(), req.Header)
	if err != nil {
		if resp != nil {
			if resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden || resp.StatusCode == http.StatusGone {
				return &terminalError{status: resp.StatusCode}
			}
			return &handshakeError{status: resp.StatusCode}
		}
		return err
	}
	defer conn.Close()
	a.status("control connection established")
	if resp != nil {
		if expiry, parseErr := strconv.ParseInt(resp.Header.Get("x-tunnel-expires-at"), 10, 64); parseErr == nil && expiry > 0 {
			a.cfg.ExpiresAt = expiry
		}
	}
	conn.SetReadLimit(maxControlFrame)
	_ = conn.SetReadDeadline(time.Now().Add(90 * time.Second))
	conn.SetPongHandler(func(string) error { return conn.SetReadDeadline(time.Now().Add(90 * time.Second)) })
	r := newRuntime(a, conn)
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	pingDone := make(chan struct{})
	go func() {
		<-ctx.Done()
		_ = conn.Close()
	}()
	go func() {
		defer close(pingDone)
		ticker := time.NewTicker(30 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				_ = conn.WriteControl(websocket.PingMessage, nil, time.Now().Add(5*time.Second))
			}
		}
	}()
	err = r.readLoop(ctx)
	cancel()
	_ = conn.Close()
	<-pingDone
	r.closeAll()
	return err
}

type envelope struct {
	Type      string              `json:"type"`
	ID        string              `json:"id"`
	Method    string              `json:"method,omitempty"`
	Path      string              `json:"path,omitempty"`
	Headers   map[string][]string `json:"headers,omitempty"`
	Status    int                 `json:"status,omitempty"`
	Data      string              `json:"data,omitempty"`
	Text      bool                `json:"text,omitempty"`
	Protocols []string            `json:"protocols,omitempty"`
	Protocol  string              `json:"protocol,omitempty"`
	Error     string              `json:"error,omitempty"`
	Code      int                 `json:"code,omitempty"`
	Reason    string              `json:"reason,omitempty"`
}

func decodeFrame(b []byte) (envelope, error) {
	var m envelope
	err := json.Unmarshal(b, &m)
	if err == nil && m.Type == "" {
		err = errors.New("control frame missing type")
	}
	return m, err
}
