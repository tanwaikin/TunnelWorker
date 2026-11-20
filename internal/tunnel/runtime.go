package tunnel

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

const (
	maxRequestBody   = 8 << 20
	maxResponseChunk = 32 << 10
	maxControlJSON   = 90 << 10
	maxHTTPInFlight  = 8
	maxWSInFlight    = 64
)

type httpRequest struct {
	method, path string
	headers      map[string][]string
	body         bytes.Buffer
	started      bool
	cancel       context.CancelFunc
}
type appSocket struct {
	conn *websocket.Conn
	done chan struct{}
	once sync.Once
}

func (s *appSocket) close() { s.once.Do(func() { close(s.done); _ = s.conn.Close() }) }

type runtime struct {
	agent        *Agent
	conn         *websocket.Conn
	writeMu      sync.Mutex
	mu           sync.Mutex
	httpRequests map[string]*httpRequest
	httpSlots    chan struct{}
	acks         map[string]chan struct{}
	ws           map[string]*appSocket
	wsSlots      chan struct{}
	client       *http.Client
}

func newRuntime(a *Agent, c *websocket.Conn) *runtime {
	transport := &http.Transport{Proxy: nil, DisableCompression: true, ForceAttemptHTTP2: false, TLSClientConfig: nil}
	return &runtime{agent: a, conn: c, httpRequests: map[string]*httpRequest{}, httpSlots: make(chan struct{}, maxHTTPInFlight), acks: map[string]chan struct{}{}, ws: map[string]*appSocket{}, wsSlots: make(chan struct{}, maxWSInFlight), client: &http.Client{Transport: transport, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}
}

func (r *runtime) send(m envelope) error {
	b, err := json.Marshal(m)
	if err != nil {
		return err
	}
	if len(b) > maxControlJSON {
		return errors.New("control message exceeds the size limit")
	}
	r.writeMu.Lock()
	defer r.writeMu.Unlock()
	if err := r.conn.SetWriteDeadline(time.Now().Add(15 * time.Second)); err != nil {
		return err
	}
	return r.conn.WriteMessage(websocket.TextMessage, b)
}

func (r *runtime) readLoop(ctx context.Context) error {
	for {
		_, raw, err := r.conn.ReadMessage()
		if err != nil {
			return err
		}
		// Keep active multiplexed traffic alive even when the peer runtime
		// does not exchange WebSocket pong frames reliably.
		_ = r.conn.SetReadDeadline(time.Now().Add(90 * time.Second))
		m, err := decodeFrame(raw)
		if err != nil {
			return fmt.Errorf("invalid control frame: %w", err)
		}
		switch m.Type {
		case "http":
			r.onHTTP(m)
		case "http_body":
			r.onHTTPBody(m)
		case "http_body_end":
			r.onHTTPBodyEnd(ctx, m.ID)
		case "http_cancel":
			r.onHTTPCancel(m.ID)
		case "http_ack":
			r.onHTTPAck(m.ID)
		case "ws_open":
			go r.onWSOpen(ctx, m)
		case "ws_message":
			r.onWSMessage(m)
		case "ws_close":
			r.terminateSocket(m.ID, m.Code, m.Reason)
		case "health_ready": // Readiness signal; no secrets are echoed.
		default: // Unknown frames are ignored for protocol forward-compatibility.
		}
	}
}

func (r *runtime) onHTTP(m envelope) {
	if m.ID == "" || m.Method == "" || !strings.HasPrefix(m.Path, "/") {
		return
	}
	select {
	case r.httpSlots <- struct{}{}:
	default:
		_ = r.send(envelope{Type: "http_error", ID: m.ID, Error: "connector is at its request limit"})
		return
	}
	r.mu.Lock()
	if _, exists := r.httpRequests[m.ID]; exists {
		r.mu.Unlock()
		<-r.httpSlots
		_ = r.send(envelope{Type: "http_error", ID: m.ID, Error: "duplicate request ID"})
		return
	}
	r.httpRequests[m.ID] = &httpRequest{method: m.Method, path: m.Path, headers: m.Headers}
	r.mu.Unlock()
}

func (r *runtime) onHTTPBody(m envelope) {
	b, err := base64.StdEncoding.DecodeString(m.Data)
	if err != nil {
		r.failHTTP(m.ID, "invalid request body encoding")
		return
	}
	r.mu.Lock()
	req := r.httpRequests[m.ID]
	if req == nil {
		r.mu.Unlock()
		return
	}
	if req.body.Len()+len(b) > maxRequestBody {
		delete(r.httpRequests, m.ID)
		r.mu.Unlock()
		<-r.httpSlots
		_ = r.send(envelope{Type: "http_error", ID: m.ID, Error: "request body exceeds 8 MiB limit"})
		return
	}
	_, _ = req.body.Write(b)
	r.mu.Unlock()
}

func (r *runtime) onHTTPBodyEnd(parent context.Context, id string) {
	// The Worker owns response-idle timeouts and the connector enforces the
	// per-chunk ACK timeout. Keep active requests uncapped, with cancellation.
	ctx, cancel := context.WithCancel(parent)
	r.mu.Lock()
	req := r.httpRequests[id]
	if req == nil || req.started {
		r.mu.Unlock()
		cancel()
		return
	}
	req.started = true
	req.cancel = cancel
	r.mu.Unlock()
	go r.serveHTTP(ctx, id, req)
}

func (r *runtime) failHTTP(id, message string) {
	r.mu.Lock()
	_, ok := r.httpRequests[id]
	if ok {
		delete(r.httpRequests, id)
	}
	r.mu.Unlock()
	if ok {
		<-r.httpSlots
		_ = r.send(envelope{Type: "http_error", ID: id, Error: message})
	}
}

func (r *runtime) onHTTPCancel(id string) {
	r.mu.Lock()
	req, ok := r.httpRequests[id]
	if ok && req.started {
		if req.cancel != nil {
			req.cancel()
		}
	} else if ok {
		delete(r.httpRequests, id)
	}
	ack := r.acks[id]
	if ack != nil {
		delete(r.acks, id)
	}
	r.mu.Unlock()
	if ok && !req.started {
		<-r.httpSlots
	}
}

func (r *runtime) onHTTPAck(id string) {
	r.mu.Lock()
	ack := r.acks[id]
	r.mu.Unlock()
	if ack != nil {
		select {
		case ack <- struct{}{}:
		default:
		}
	}
}

func (r *runtime) serveHTTP(parent context.Context, id string, incoming *httpRequest) {
	defer func() {
		if incoming.cancel != nil {
			incoming.cancel()
		}
		r.mu.Lock()
		delete(r.httpRequests, id)
		r.mu.Unlock()
		<-r.httpSlots
	}()
	ctx := parent
	target, err := requestTarget(r.agent.cfg.LocalURL, incoming.path)
	if err != nil {
		_ = r.send(envelope{Type: "http_error", ID: id, Error: "invalid request path"})
		return
	}
	body := append([]byte(nil), incoming.body.Bytes()...)
	req, err := http.NewRequestWithContext(ctx, incoming.method, target, bytes.NewReader(body))
	if err != nil {
		_ = r.send(envelope{Type: "http_error", ID: id, Error: "invalid request"})
		return
	}
	copyHeaders(req.Header, translatePublicOrigin(incoming.headers, r.agent.cfg))
	// Local requests never leave the configured local application origin.
	resp, err := r.client.Do(req)
	if err != nil {
		_ = r.send(envelope{Type: "http_error", ID: id, Error: "local application request failed"})
		return
	}
	defer resp.Body.Close()
	respHeaders := responseHeaders(resp.Header)
	if resp.ContentLength >= 0 {
		respHeaders["Content-Length"] = []string{strconv.FormatInt(resp.ContentLength, 10)}
	}
	if err := r.send(envelope{Type: "http_start", ID: id, Status: resp.StatusCode, Headers: respHeaders}); err != nil {
		_ = r.send(envelope{Type: "http_error", ID: id, Error: "local application response headers exceed the control message limit"})
		return
	}
	buf := make([]byte, maxResponseChunk)
	for {
		n, readErr := resp.Body.Read(buf)
		if n > 0 {
			ack := make(chan struct{}, 1)
			r.mu.Lock()
			r.acks[id] = ack
			r.mu.Unlock()
			if err := r.send(envelope{Type: "http_chunk", ID: id, Data: base64.StdEncoding.EncodeToString(buf[:n])}); err != nil {
				r.removeAck(id)
				return
			}
			timer := time.NewTimer(45 * time.Second)
			select {
			case <-ctx.Done():
				timer.Stop()
				r.removeAck(id)
				return
			case <-ack:
				timer.Stop()
			case <-timer.C:
				r.removeAck(id)
				_ = r.send(envelope{Type: "http_error", ID: id, Error: "response consumer stopped acknowledging data"})
				return
			}
		}
		if readErr != nil {
			if !errors.Is(readErr, io.EOF) {
				_ = r.send(envelope{Type: "http_error", ID: id, Error: "local application response failed"})
				return
			}
			break
		}
	}
	_ = r.send(envelope{Type: "http_end", ID: id})
}

func translatePublicOrigin(src map[string][]string, cfg Config) map[string][]string {
	copyOfHeaders := make(map[string][]string, len(src))
	for key, values := range src {
		copyOfHeaders[key] = append([]string(nil), values...)
	}
	for key, values := range copyOfHeaders {
		if !strings.EqualFold(key, "Origin") || len(values) != 1 {
			continue
		}
		visitorURL, visitorErr := url.Parse(cfg.VisitorURL)
		if !validTunnelID(cfg.ID) || visitorErr != nil || visitorURL.Scheme != "https" || visitorURL.User != nil || visitorURL.Host == "" || visitorURL.Port() != "" || visitorURL.Path != "" || visitorURL.RawQuery != "" || visitorURL.Fragment != "" || !strings.HasPrefix(strings.ToLower(visitorURL.Hostname()), cfg.ID+"-tunnel.") {
			continue
		}
		origin, err := url.Parse(values[0])
		if err != nil || origin.User != nil || origin.Path != "" || origin.RawQuery != "" || origin.Fragment != "" || !strings.EqualFold(origin.Host, visitorURL.Host) || (origin.Scheme != "http" && origin.Scheme != "https") {
			continue
		}
		copyOfHeaders[key] = []string{cfg.LocalURL.Scheme + "://" + cfg.LocalURL.Host}
	}
	return copyOfHeaders
}

func (r *runtime) removeAck(id string) { r.mu.Lock(); delete(r.acks, id); r.mu.Unlock() }

func requestTarget(base *url.URL, rawPath string) (string, error) {
	if strings.HasPrefix(rawPath, "//") {
		return "", errors.New("network-path references are not valid request paths")
	}
	u, err := url.ParseRequestURI(rawPath)
	if err != nil || u.IsAbs() || u.Host != "" || !strings.HasPrefix(u.Path, "/") {
		return "", errors.New("invalid relative request path")
	}
	target := *base
	basePath := strings.TrimRight(target.Path, "/")
	target.Path = basePath + u.Path
	baseEscaped := strings.TrimRight(base.EscapedPath(), "/")
	rawPathEscaped := baseEscaped + u.EscapedPath()
	target.RawPath = ""
	if rawPathEscaped != target.EscapedPath() {
		target.RawPath = rawPathEscaped
	}
	target.RawQuery = u.RawQuery
	return target.String(), nil
}

var hopHeaders = map[string]bool{"Connection": true, "Proxy-Connection": true, "Keep-Alive": true, "Proxy-Authenticate": true, "Proxy-Authorization": true, "Te": true, "Trailer": true, "Transfer-Encoding": true, "Upgrade": true, "Host": true, "Content-Length": true}

func copyHeaders(dst http.Header, src map[string][]string) {
	connectionTokens := map[string]bool{}
	for k, values := range src {
		if strings.EqualFold(k, "Connection") {
			for _, line := range values {
				for _, token := range strings.Split(line, ",") {
					connectionTokens[http.CanonicalHeaderKey(strings.TrimSpace(token))] = true
				}
			}
		}
	}
	for k, values := range src {
		ck := http.CanonicalHeaderKey(k)
		if hopHeaders[ck] || connectionTokens[ck] {
			continue
		}
		for _, v := range values {
			dst.Add(ck, v)
		}
	}
}

func responseHeaders(src http.Header) map[string][]string {
	dst := make(map[string][]string)
	connectionTokens := map[string]bool{}
	for _, line := range src.Values("Connection") {
		for _, token := range strings.Split(line, ",") {
			connectionTokens[http.CanonicalHeaderKey(strings.TrimSpace(token))] = true
		}
	}
	for k, values := range src {
		ck := http.CanonicalHeaderKey(k)
		if hopHeaders[ck] || connectionTokens[ck] {
			continue
		}
		// Go's map preserves each repeated header value, including Set-Cookie.
		dst[ck] = append([]string(nil), values...)
	}
	return dst
}
