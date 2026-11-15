package control

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

type Tunnel struct {
	ID             string `json:"id"`
	URL            string `json:"url"`
	ConnectorToken string `json:"connectorToken"`
	ExpiresAt      int64  `json:"expiresAt"`
}

type Client struct {
	base   *url.URL
	http   *http.Client
	domain string
}

func New(base *url.URL) *Client {
	domain, _ := RouteDomain(base, "")
	return NewWithDomain(base, domain)
}

func NewWithDomain(base *url.URL, domain string) *Client {
	// No redirects: a credential-bearing request must never be replayed to a
	// redirect target, and the API should return its final endpoint directly.
	return &Client{base: base, domain: domain, http: &http.Client{Timeout: 20 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}
}

// RouteDomain chooses the routing domain used in the HTTP Host header. A
// loopback --url is the local Wrangler endpoint, whose virtual hostname is the
// default public control domain. A non-loopback URL host can serve as its own
// domain, with an explicit --domain available for custom routing setups.
func RouteDomain(base *url.URL, override string) (string, error) {
	if override != "" {
		d := strings.ToLower(strings.TrimSuffix(strings.TrimSpace(override), "."))
		if !validDomain(d) {
			return "", fmt.Errorf("domain must be a DNS hostname without a scheme or port")
		}
		return d, nil
	}
	host := strings.ToLower(strings.TrimSuffix(base.Hostname(), "."))
	if host == "" {
		return "", fmt.Errorf("control URL has no hostname")
	}
	if net.ParseIP(host) != nil || host == "localhost" || strings.HasSuffix(host, ".localhost") {
		return "example.test", nil
	}
	return host, nil
}

func validDomain(domain string) bool {
	if domain == "" || len(domain) > 253 || net.ParseIP(domain) != nil {
		return false
	}
	for _, label := range strings.Split(domain, ".") {
		if label == "" || len(label) > 63 || label[0] == '-' || label[len(label)-1] == '-' {
			return false
		}
		for _, c := range label {
			if !(c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || c == '-') {
				return false
			}
		}
	}
	return true
}

func (c *Client) endpoint(path string) string {
	u := *c.base
	u.Path = strings.TrimRight(u.Path, "/") + path
	u.RawQuery = ""
	u.Fragment = ""
	return u.String()
}

func (c *Client) Create(ctx context.Context, operatorToken string, ttl time.Duration, visitorPassword string) (Tunnel, error) {
	ttlSeconds := int64(ttl / time.Second)
	if ttl%time.Second != 0 {
		ttlSeconds++
	}
	body := map[string]any{"ttlSeconds": ttlSeconds}
	if visitorPassword != "" {
		body["visitorPassword"] = visitorPassword
	}
	b, err := json.Marshal(body)
	if err != nil {
		return Tunnel{}, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.endpoint("/api/tunnels"), bytes.NewReader(b))
	if err != nil {
		return Tunnel{}, err
	}
	req.Header.Set("Authorization", "Bearer "+operatorToken)
	req.Header.Set("Content-Type", "application/json")
	// The local Wrangler endpoint is reached by IP/port, while Worker routing
	// still selects management routes by the production apex Host.
	req.Host = c.domain
	req.Header.Set("Host", c.domain)
	resp, err := c.http.Do(req)
	if err != nil {
		return Tunnel{}, fmt.Errorf("create tunnel: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return Tunnel{}, apiError("create tunnel", resp)
	}
	var tunnel Tunnel
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&tunnel); err != nil {
		return Tunnel{}, fmt.Errorf("decode create response: %w", err)
	}
	if tunnel.ID == "" || tunnel.URL == "" || tunnel.ConnectorToken == "" || tunnel.ExpiresAt <= 0 {
		return Tunnel{}, fmt.Errorf("create response is missing tunnel credentials or metadata")
	}
	return tunnel, nil
}

func (c *Client) Revoke(ctx context.Context, id, token string) error {
	if !validTunnelID(id) {
		return fmt.Errorf("revoke tunnel: invalid tunnel ID")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodDelete, c.endpoint("/api/tunnels/"+id), nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	// Keep local Wrangler routing on the virtual apex host. For production,
	// c.domain is the same hostname used in the configured control URL.
	req.Host = c.domain
	resp, err := c.http.Do(req)
	if err != nil {
		return fmt.Errorf("revoke tunnel: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return apiError("revoke tunnel", resp)
	}
	return nil
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

func apiError(op string, resp *http.Response) error {
	// Never include response bodies: they may contain credentials or internals.
	return fmt.Errorf("%s: server returned HTTP %s", op, strconv.Itoa(resp.StatusCode)+" "+http.StatusText(resp.StatusCode))
}
