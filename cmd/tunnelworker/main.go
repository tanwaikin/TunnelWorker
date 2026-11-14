package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"tunnelworker/internal/control"
	"tunnelworker/internal/session"
	"tunnelworker/internal/tunnel"
)

func main() {
	if err := run(os.Args[1:], os.Stdout, os.Stderr); err != nil {
		fmt.Fprintln(os.Stderr, "tunnelworker:", err)
		os.Exit(1)
	}
}

func run(args []string, out, errOut io.Writer) error {
	fs := flag.NewFlagSet("tunnelworker", flag.ContinueOnError)
	fs.SetOutput(errOut)
	baseRaw := fs.String("url", "https://dev.example.net", "TunnelWorker control URL")
	port := fs.Int("port", 3000, "local application port")
	localRaw := fs.String("local", "", "local application URL (defaults to http://127.0.0.1:<port>)")
	domainRaw := fs.String("domain", "", "routing domain (defaults to --url hostname, or dev.example.net for loopback)")
	ttl := fs.Duration("ttl", 30*time.Minute, "new tunnel lifetime (maximum 24h)")
	password := fs.String("password", "", "optional visitor password (or TUNNELWORKER_PASSWORD)")
	connectID := fs.String("connect", "", "reconnect to an existing tunnel ID")
	credential := fs.String("token", "", "connector credential for --connect (or read from session file)")
	sessionPath := fs.String("session-file", defaultSessionPath(), "private file for saving and loading reconnect credentials")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if fs.NArg() != 0 {
		return fmt.Errorf("unexpected arguments: %s", strings.Join(fs.Args(), " "))
	}
	base, err := parseBase(*baseRaw)
	if err != nil {
		return err
	}
	local, err := parseLocal(*localRaw, *port)
	if err != nil {
		return err
	}
	if *connectID == "" {
		if err := validateTTL(*ttl); err != nil {
			return err
		}
	}
	domain, err := control.RouteDomain(base, *domainRaw)
	if err != nil {
		return fmt.Errorf("--domain: %w", err)
	}
	if *password == "" {
		*password = os.Getenv("TUNNELWORKER_PASSWORD")
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	api := control.NewWithDomain(base, domain)
	var saved session.Session
	if *connectID != "" {
		saved = session.Session{ID: *connectID, BaseURL: base.String(), LocalURL: local.String(), VisitorURL: "", ExpiresAt: 0}
		if loaded, e := session.Load(*sessionPath); e == nil && loaded.ID == *connectID && loaded.BaseURL == base.String() {
			saved = loaded
		}
		if *credential == "" {
			*credential = saved.ConnectorToken
		}
		if *credential == "" {
			return errors.New("--connect requires --token or matching credentials in --session-file")
		}
		saved.ConnectorToken = *credential
		saved.LocalURL = local.String()
	} else {
		operator := os.Getenv("TUNNELWORKER_TOKEN")
		if operator == "" {
			return errors.New("TUNNELWORKER_TOKEN is required when creating a tunnel")
		}
		created, e := api.Create(ctx, operator, *ttl, *password)
		if e != nil {
			return e
		}
		saved = session.Session{ID: created.ID, BaseURL: base.String(), LocalURL: local.String(), VisitorURL: created.URL, ConnectorToken: created.ConnectorToken, ExpiresAt: created.ExpiresAt}
	}
	if e := session.Save(*sessionPath, saved); e != nil {
		if *connectID == "" {
			rctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			_ = api.Revoke(rctx, saved.ID, saved.ConnectorToken)
			cancel()
		}
		return fmt.Errorf("save reconnect credentials: %w", e)
	}
	if saved.VisitorURL != "" {
		fmt.Fprintf(out, "Tunnel: %s\n", saved.VisitorURL)
	}
	if saved.ExpiresAt > 0 {
		fmt.Fprintf(out, "Expires: %s\n", time.UnixMilli(saved.ExpiresAt).UTC().Format(time.RFC3339))
	}
	fmt.Fprintf(out, "Session: %s\n", *sessionPath)

	agent := tunnel.New(tunnel.Config{BaseURL: base, LocalURL: local, ID: saved.ID, Token: saved.ConnectorToken, Domain: domain, ExpiresAt: saved.ExpiresAt, OnStatus: func(message string) { fmt.Fprintf(errOut, "tunnelworker: %s\n", message) }})
	if err := agent.Run(ctx); err != nil && !errors.Is(err, context.Canceled) {
		return err
	}
	if ctx.Err() != nil {
		// Revoke is best effort and only occurs on deliberate local shutdown.
		rctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if e := api.Revoke(rctx, saved.ID, saved.ConnectorToken); e != nil {
			fmt.Fprintf(errOut, "warning: tunnel revoke failed: %v\n", e)
		} else {
			_ = os.Remove(*sessionPath)
		}
	}
	return nil
}

func parseBase(raw string) (*url.URL, error) {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") {
		return nil, fmt.Errorf("--url must be an absolute http:// or https:// URL")
	}
	if u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return nil, fmt.Errorf("--url cannot include user info, query, or fragment")
	}
	if err := validateURLPort(u); err != nil {
		return nil, fmt.Errorf("--url: %w", err)
	}
	return u, nil
}

func parseLocal(raw string, port int) (*url.URL, error) {
	if raw == "" {
		if port < 1 || port > 65535 {
			return nil, errors.New("--port must be between 1 and 65535")
		}
		raw = fmt.Sprintf("http://127.0.0.1:%d", port)
	}
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") {
		return nil, errors.New("--local must be an absolute http:// or https:// URL")
	}
	if u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return nil, errors.New("--local cannot include user info, query, or fragment")
	}
	if err := validateURLPort(u); err != nil {
		return nil, fmt.Errorf("--local: %w", err)
	}
	return u, nil
}

func validateURLPort(u *url.URL) error {
	port := u.Port()
	if port == "" {
		return nil
	}
	for _, c := range port {
		if c < '0' || c > '9' {
			return errors.New("port must be numeric")
		}
	}
	n := 0
	for _, c := range port {
		n = n*10 + int(c-'0')
		if n > 65535 {
			return errors.New("port must be between 1 and 65535")
		}
	}
	if n == 0 {
		return errors.New("port must be between 1 and 65535")
	}
	return nil
}

func validateTTL(ttl time.Duration) error {
	if ttl < time.Minute || ttl > 24*time.Hour {
		return errors.New("--ttl must be between 1m and 24h")
	}
	return nil
}

func defaultSessionPath() string {
	if dir, err := os.UserConfigDir(); err == nil {
		return filepath.Join(dir, "tunnelworker", "session.json")
	}
	return filepath.Join(".tunnelworker", "session.json")
}
