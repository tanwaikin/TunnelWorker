# TunnelWorker

Self-hosted HTTP/WebSocket reverse tunnel for local development using Cloudflare Workers and Durable Objects.

## Agreed requirements

- Each operator configures a control hostname (`BASE_DOMAIN`) and a visitor parent domain (`VISITOR_DOMAIN`). Public URLs use `<36-character-lowercase-hex-id>-tunnel.<VISITOR_DOMAIN>`; the visitor Worker route is `*-tunnel.<VISITOR_DOMAIN>/*`.
- Control and visitor traffic need matching proxied DNS and TLS. Visitor DNS can use exact records per tunnel; a broad wildcard DNS record is optional and also resolves otherwise-unconfigured sibling subdomains.
- Random IDs are allocated server-side with collision-safe initialization, one Durable Object per tunnel.
- Absolute TTL defaults to 30 minutes, configurable up to 24 hours. Reconnect preserves URL and original expiry. Expiry rejects traffic and closes sockets, with an alarm and checks on requests/messages.
- Optional visitor password protects both HTTP and WebSocket upgrades; absent password means public.
- A separate operator creation token is stored as a Worker secret; tunnel connectors use per-tunnel credentials. No credentials in URLs or committed secrets.
- TypeScript Worker, SQLite-backed DO, Go CLI named tunnelworker. Explicit HTTP(S)_PROXY and CA compatibility for Codex Cloud.
- HTTP forwarding and streaming responses, WebSocket forwarding for HMR, bounded bodies/queues, cancellation, deadlines, reconnect with backoff, useful failure boundaries.
- Control websocket uses hibernation; persist expiry/credential hashes and serialize attachments so hibernation does not lose connection ownership.
- Wrangler production config must not target a real zone by default. It starts with an empty base domain and no routes; the operator configures these for their domain before deployment. Local routing uses reserved `example.test`.
- The Worker is deployed to the operator's Cloudflare account with an exact control-host route and a `*-tunnel.<VISITOR_DOMAIN>/*` visitor route. No broad visitor DNS wildcard is configured; the temporary test tunnel uses an exact proxied record. Keep account details and credentials out of Git. The self-hosted public release uses the MIT license; the repository remains private until the owner is ready to change visibility and enable private vulnerability reporting.

## Delivery

Provide runnable code, meaningful Go and real-workerd integration tests, CI, protocol/deployment documentation and clear limitations. Test local end-to-end flow. Do not claim live Cloudflare/Codex proxy WSS validation without doing it against an actual deployed endpoint.
