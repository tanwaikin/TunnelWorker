# TunnelWorker

Self-hosted HTTP/WebSocket reverse tunnel for local development using Cloudflare Workers and Durable Objects.

## Agreed requirements

- Each operator configures a custom domain they control. The control hostname and visitor wildcard hostname are user selected and must be covered by Worker routes, proxied DNS, and TLS.
- Random IDs are allocated server-side with collision-safe initialization, one Durable Object per tunnel.
- Absolute TTL defaults to 30 minutes, configurable up to 24 hours. Reconnect preserves URL and original expiry. Expiry rejects traffic and closes sockets, with an alarm and checks on requests/messages.
- Optional visitor password protects both HTTP and WebSocket upgrades; absent password means public.
- A separate operator creation token is stored as a Worker secret; tunnel connectors use per-tunnel credentials. No credentials in URLs or committed secrets.
- TypeScript Worker, SQLite-backed DO, Go CLI named tunnelworker. Explicit HTTP(S)_PROXY and CA compatibility for Codex Cloud.
- HTTP forwarding and streaming responses, WebSocket forwarding for HMR, bounded bodies/queues, cancellation, deadlines, reconnect with backoff, useful failure boundaries.
- Control websocket uses hibernation; persist expiry/credential hashes and serialize attachments so hibernation does not lose connection ownership.
- Wrangler production config must not target a real zone by default. It starts with an empty base domain and no routes; the operator configures these for their domain before deployment. Local routing uses reserved `example.test`.
- No deployment, Cloudflare mutations, GitHub creation, or publication requested. The repository is private while its eventual public address is undecided. No Deploy button is included.

## Delivery

Provide runnable code, meaningful Go and real-workerd integration tests, CI, protocol/deployment documentation and clear limitations. Test local end-to-end flow. Do not claim live Cloudflare/Codex proxy WSS validation without doing it against an actual deployed endpoint.
