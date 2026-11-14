package tunnel

import (
	"context"
	"encoding/base64"
	"errors"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/gorilla/websocket"
)

func (r *runtime) onWSOpen(ctx context.Context, m envelope) {
	if m.ID == "" {
		return
	}
	select {
	case r.wsSlots <- struct{}{}:
	default:
		_ = r.send(envelope{Type: "ws_error", ID: m.ID, Error: "connector is at its WebSocket limit"})
		return
	}
	r.mu.Lock()
	if _, exists := r.ws[m.ID]; exists {
		r.mu.Unlock()
		<-r.wsSlots
		_ = r.send(envelope{Type: "ws_error", ID: m.ID, Error: "duplicate WebSocket ID"})
		return
	}
	r.mu.Unlock()
	target, err := websocketTarget(r.agent.cfg.LocalURL, m.Path)
	if err != nil {
		<-r.wsSlots
		_ = r.send(envelope{Type: "ws_error", ID: m.ID, Error: "invalid WebSocket path"})
		return
	}
	header := make(http.Header)
	copyHeaders(header, translatePublicOrigin(m.Headers, r.agent.cfg))
	// Subprotocols are handled by the websocket handshake implementation.
	header.Del("Sec-WebSocket-Protocol")
	for _, p := range m.Protocols {
		if strings.ContainsAny(p, "\r\n,") {
			<-r.wsSlots
			_ = r.send(envelope{Type: "ws_error", ID: m.ID, Error: "invalid WebSocket protocol"})
			return
		}
	}
	d := websocket.Dialer{Proxy: nil, HandshakeTimeout: 10 * time.Second, Subprotocols: m.Protocols, EnableCompression: false}
	local, resp, err := d.DialContext(ctx, target.String(), header)
	if err != nil {
		<-r.wsSlots
		// Do not pass local error details, headers or URLs into the public channel.
		_ = resp
		_ = r.send(envelope{Type: "ws_error", ID: m.ID, Error: "local application WebSocket handshake failed"})
		return
	}
	socket := &appSocket{conn: local, done: make(chan struct{})}
	r.mu.Lock()
	if _, exists := r.ws[m.ID]; exists {
		r.mu.Unlock()
		socket.close()
		<-r.wsSlots
		_ = r.send(envelope{Type: "ws_error", ID: m.ID, Error: "duplicate WebSocket ID"})
		return
	}
	r.ws[m.ID] = socket
	r.mu.Unlock()
	if err := r.send(envelope{Type: "ws_opened", ID: m.ID, Protocol: local.Subprotocol()}); err != nil {
		r.removeSocket(m.ID, socket)
		return
	}
	go r.pingAppSocket(ctx, socket)
	go r.readAppSocket(ctx, m.ID, socket)
}

func (r *runtime) pingAppSocket(ctx context.Context, socket *appSocket) {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-socket.done:
			return
		case <-ticker.C:
			_ = socket.conn.WriteControl(websocket.PingMessage, nil, time.Now().Add(5*time.Second))
		}
	}
}

func websocketTarget(base *url.URL, rawPath string) (*url.URL, error) {
	ref, err := url.ParseRequestURI(rawPath)
	if err != nil || ref.IsAbs() || ref.Host != "" || !strings.HasPrefix(ref.Path, "/") {
		return nil, errors.New("invalid WebSocket path")
	}
	u := *base
	if u.Scheme == "https" {
		u.Scheme = "wss"
	} else {
		u.Scheme = "ws"
	}
	basePath := strings.TrimRight(u.Path, "/")
	baseEscaped := strings.TrimRight(u.EscapedPath(), "/")
	u.Path = basePath + ref.Path
	rawPathEscaped := baseEscaped + ref.EscapedPath()
	u.RawPath = ""
	if rawPathEscaped != u.EscapedPath() {
		u.RawPath = rawPathEscaped
	}
	u.RawQuery = ref.RawQuery
	u.Fragment = ""
	return &u, nil
}

func (r *runtime) readAppSocket(ctx context.Context, id string, socket *appSocket) {
	defer r.removeSocket(id, socket)
	socket.conn.SetReadLimit(maxWSMessage)
	_ = socket.conn.SetReadDeadline(time.Now().Add(10 * time.Minute))
	socket.conn.SetPongHandler(func(string) error { return socket.conn.SetReadDeadline(time.Now().Add(10 * time.Minute)) })
	for {
		kind, data, err := socket.conn.ReadMessage()
		if err != nil {
			r.mu.Lock()
			active := r.ws[id] == socket
			r.mu.Unlock()
			if active {
				code, reason := uint16(websocket.CloseNormalClosure), ""
				var closeErr *websocket.CloseError
				if errors.As(err, &closeErr) {
					code = uint16(closeErr.Code)
					reason = closeErr.Text
				}
				reason = boundedCloseReason(reason)
				_ = r.send(envelope{Type: "ws_close", ID: id, Code: int(code), Reason: reason})
			}
			return
		}
		if kind != websocket.TextMessage && kind != websocket.BinaryMessage {
			continue
		}
		if len(data) > maxWSMessage {
			_ = r.send(envelope{Type: "ws_close", ID: id, Code: websocket.CloseMessageTooBig, Reason: "message too large"})
			r.terminateSocket(id, websocket.CloseMessageTooBig, "message too large")
			return
		}
		select {
		case <-ctx.Done():
			return
		default:
		}
		if err := r.send(envelope{Type: "ws_message", ID: id, Data: base64.StdEncoding.EncodeToString(data), Text: kind == websocket.TextMessage}); err != nil {
			return
		}
	}
}

func (r *runtime) onWSMessage(m envelope) {
	b, err := base64.StdEncoding.DecodeString(m.Data)
	if err != nil {
		r.onWSClose(m.ID)
		return
	}
	if len(b) > maxWSMessage {
		r.terminateSocket(m.ID, websocket.CloseMessageTooBig, "message too large")
		return
	}
	r.mu.Lock()
	socket := r.ws[m.ID]
	r.mu.Unlock()
	if socket == nil {
		return
	}
	kind := websocket.BinaryMessage
	if m.Text {
		kind = websocket.TextMessage
	}
	_ = socket.conn.SetWriteDeadline(time.Now().Add(15 * time.Second))
	if err := socket.conn.WriteMessage(kind, b); err != nil {
		r.onWSClose(m.ID)
	}
}

func (r *runtime) onWSClose(id string) {
	r.terminateSocket(id, websocket.CloseNormalClosure, "")
}

func (r *runtime) terminateSocket(id string, code int, reason string) {
	r.mu.Lock()
	socket := r.ws[id]
	if socket != nil {
		delete(r.ws, id)
	}
	r.mu.Unlock()
	if socket != nil {
		if code < 1000 || code > 4999 || code == 1004 || code == 1005 || code == 1006 || code == 1015 {
			code = websocket.CloseNormalClosure
		}
		reason = boundedCloseReason(reason)
		_ = socket.conn.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(code, reason), time.Now().Add(time.Second))
		socket.close()
		<-r.wsSlots
	}
}

const maxWSMessage = 64 << 10

func boundedCloseReason(reason string) string {
	if len(reason) > 120 {
		return reason[:120]
	}
	return reason
}

func (r *runtime) removeSocket(id string, socket *appSocket) {
	r.mu.Lock()
	exists := r.ws[id] == socket
	if exists {
		delete(r.ws, id)
	}
	r.mu.Unlock()
	if exists {
		socket.close()
		<-r.wsSlots
	}
}

func (r *runtime) closeAll() {
	r.mu.Lock()
	for id, req := range r.httpRequests {
		if req.cancel != nil {
			req.cancel()
		}
		delete(r.httpRequests, id)
	}
	for id, socket := range r.ws {
		delete(r.ws, id)
		socket.close()
		<-r.wsSlots
	}
	r.mu.Unlock()
	r.client.CloseIdleConnections()
}
