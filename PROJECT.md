# TunnelWorker

Self-hosted HTTP/WebSocket reverse tunnel for Codex Cloud on Cloudflare Workers + Durable Objects.

## Agreed requirements

- Domain: example.net on Cloudflare. Control: dev.example.net; public URLs: <random-id>.dev.example.net.
- Random IDs allocated server-side with collision-safe initialization, one Durable Object per tunnel.
- Absolute TTL defaults to 30 minutes, configurable up to 24 hours. Reconnect preserves URL and original expiry. Expiry rejects traffic and closes sockets, with an alarm and checks on requests/messages.
- Optional visitor password protecting BOTH HTTP and WebSocket upgrades; absent password means public.
- A separate operator creation token stored as a Worker secret; tunnel connectors use per-tunnel credentials. No credentials in URLs or committed secrets.
- TypeScript Worker, SQLite-backed DO, Go CLI named tunnelworker. Explicit HTTP(S)_PROXY and CA compatibility for Codex Cloud.
- HTTP forwarding and streaming responses, WebSocket forwarding for HMR, bounded bodies/queues, cancellation, deadlines, reconnect with backoff, useful failure boundaries.
- Control websocket uses hibernation; persist expiry/credential hashes and serialize attachments so hibernation does not lose connection ownership.
- Cloudflare wildcard DNS/Worker routing AND TLS coverage for *.dev.example.net required. Do not claim Universal SSL covers that nested wildcard.
- No deployment, Cloudflare mutations, GitHub creation, or publication requested. User will create GitHub repository later.

## Delivery

Provide runnable code, meaningful Go and real-workerd integration tests, CI, protocol/deployment documentation and clear limitations. Test local end-to-end flow. Do not claim live Cloudflare/Codex proxy WSS validation without doing it against an actual deployed endpoint.
