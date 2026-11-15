# Implementation and live-test handoff

## Implemented and validated locally

- TypeScript Cloudflare Worker and SQLite Durable Object per tunnel; Go CLI.
- Random tunnel IDs, absolute TTL (30 minutes by default, 1 minute to 24 hours), and reconnect without extending expiry.
- Optional visitor password with HTTP Basic bootstrap and an HttpOnly/Secure cookie for browser WebSocket access.
- Bounded HTTP bodies, streamed responses with acknowledgements, and WebSocket text/binary/subprotocol forwarding.
- The original Host-routed baseline had passed Go race tests and vet, TypeScript typecheck, four workerd integration tests, Wrangler dry-run, and local end-to-end smoke tests. The smoke coverage included streaming, bodyless statuses, repeated cookies, gzip, password gating, reconnect/expiry, origin failure, and graceful revoke.
- Control routing now uses `GET /api/tunnels/{id}/connect` for the connector WebSocket and `DELETE /api/tunnels/{id}` for connector revocation. The Worker forwards these routes to the existing DO `/_control` handler after validating the 36-character lowercase hex tunnel ID. The Go connector no longer overrides Host for production control WebSockets; the loopback Wrangler virtual host remains supported.
- Current source returns flat visitor URLs in the `<id>-tunnel.<public-domain>` format, requires a separate `VISITOR_DOMAIN` setting, and rejects the legacy nested visitor hostname. The configured Cloudflare route uses `*-tunnel.<public-domain>/*`; each visitor host needs a proxied DNS record.
- The path-routed change passed local integration and smoke tests. The latest flat-host source and type fix (`dde2001`) passed GitHub Actions: Wrangler type generation, TypeScript typecheck, all 5 Vitest tests, Go race tests and vet, smoke dependencies and smoke test, and Wrangler deploy dry-run.

## Live deployment status

A prior Host-routed deployment of commit `0d1971ca7884ded338df851c1dd6046ae731bab4` was made to the operator's Cloudflare account. Its private domain, deployment configuration, and operator credential are intentionally outside Git. The default workers.dev endpoint is disabled.

On that prior Host-routed deployment, the following checks were made in the managed Cloud test environment:

| Check | Result |
| --- | --- |
| HTTPS control-host `/_health` | 200, normal certificate verification |
| Authenticated tunnel creation | Succeeded |
| Public DNS for control and visitor hosts | Resolves to Cloudflare proxy addresses |
| HTTP request using a tunnel Host override | Envoy 503, upstream connection failure, no CF-Ray |
| Actual Go control WebSocket with tunnel Host override | HTTP 503 |
| WebSocket handshake request to control host without Host override | Worker 404 JSON with CF-Ray; this does not establish a successful WebSocket upgrade |

The earlier CLI dialed the control endpoint and overrode HTTP Host to select the tunnel. Those observations describe the previous implementation only; the current code uses a path ID and leaves production Host selection to the URL hostname. The observed 503 does not establish a Durable Object/application failure or prove that WebSocket is generally blocked.

### Path-routed deployment (2026-11-14)

The existing `tunnelworker` was updated in place for the operator's control hostname. At that time, Worker version 5 with path-routed control API was deployed at 100% (deployment `769e39dd-5e17-48e4-9c67-1f4fe22ae0e5`). It reused the existing Durable Object namespace; `BASE_DOMAIN` and numeric settings were verified after deployment. The visitor hostname still used the nested format then; version 6 below replaced its Worker route and DNS record with the flat format. At the operator's request, the `OPERATOR_TOKEN` secret was re-PUT from this checkout's ignored `.dev.vars`; its value is intentionally not recorded. The generic Wrangler config remains unchanged.

### Flat visitor-host deployment (2026-11-15)

Worker version 6 is deployed at 100% (version `77360b82-fe8f-44d2-870f-5e764f93fcdf`, deployment `26cbf000-2a77-4ede-af49-8b44f8bcd42c`). It sets `BASE_DOMAIN` to the control host and `VISITOR_DOMAIN` to the public parent domain, while retaining the existing DO namespace and operator secret. The active routes are the exact control-host route and `*-tunnel.<public-domain>/*`; the old `*.<control-host>/*` route and old nested wildcard DNS record were removed.

To avoid changing resolution for unrelated subdomains, no `*.<public-domain>` DNS record is configured. The static test Tunnel has one exact proxied A record; the test host returned the test page over HTTPS with normal certificate verification. The flat host is covered by the existing first-level wildcard certificate. Future dynamically created Tunnels need an exact proxied DNS record per ID unless DNS provisioning is automated or a broad wildcard record is explicitly chosen.

| Check | Result |
| --- | --- |
| Control-host HTTPS `/_health` after version 6 deploy | HTTP 200 with normal TLS verification and Cloudflare Ray ID |
| Real Go Connector control WSS | `control connection established` |
| Visitor HTTPS at `<id>-tunnel.<public-domain>` | HTTP 200 with TLS verification enabled, Cloudflare Ray ID, and the local static page |
| Other nested visitor format | No longer routed; nested wildcard Worker route and DNS record were removed |

### Historical path-routed live tests (2026-11-14)

The following results are from Worker version 5, before the visitor hostname changed to the flat `<id>-tunnel.<public-domain>` format. They describe the earlier nested visitor host and should not be read as results for the current version 6 visitor route.

| Check | Result |
| --- | --- |
| Control-host HTTPS `/_health` with TLS verification | HTTP 200, `{"status":"ok"}`, Cloudflare Ray ID present |
| Tunnel creation through the deployed API with `.dev.vars` after re-PUT | Succeeded; generated a short-lived test tunnel |
| New control WSS path with the real connector credential | HTTP 101 from an explicit Go WebSocket handshake; the real CLI also logged `control connection established` |
| HTTP request through a live public tunnel URL | HTTP 200 with Cloudflare Ray ID and the local origin response `origin-ok:/live-test?source=codex` |
| Reconnect on the same tunnel ID | The real connector re-established after a replacement handshake; saved expiry stayed `2026-11-14T19:50:02.863Z` |
| Graceful connector shutdown and revoke through the new DELETE route | CLI exited cleanly; the subsequent visitor request returned HTTP 410 `tunnel_expired`, and the session file was removed |
| New control connect path with a valid-format but nonexistent ID | HTTP 410 with Cloudflare Ray ID; Worker/DO routing was reached |
| HTTPS request to the old nested visitor hostname, TLS verification enabled | HTTP 503 from the Codex Cloud Envoy proxy (`upstream connect error ... remote connection failure`), without a Cloudflare Ray ID; it failed before evidence of Worker execution |

The valid control WSS request obtained 101 through the Codex Cloud proxy, so the original control-path Envoy 503 was not reproduced after moving control routing to the URL path. The historical nested-host visitor request returned 503 from Envoy without a Cloudflare Ray ID; its exact cause was unconfirmed. Version 6 changed visitor routing to the flat first-level hostname, and a static page on that host subsequently returned HTTP 200 over HTTPS with certificate verification enabled. No certificate order or subscription change was made.

## Unresolved issues

1. **DNS for future tunnels:** only the current test tunnel has a proxied DNS record. New IDs need exact records unless DNS creation is automated; a broad wildcard DNS record would also resolve otherwise-unconfigured sibling subdomains.
2. **Extended live acceptance:** the new flat-host static HTTP/HTTPS path passed. Public application WebSocket forwarding, streaming, password/cookie access, and natural expiry have not been re-run against this deployment.

## Public distribution preparation

- The Go module path is set to `github.com/tanwaikin/TunnelWorker`; the CLI reports its version for release builds.
- `.goreleaser.yaml` and a tag-triggered GitHub Actions workflow are prepared to build Linux, macOS, and Windows binaries and create a **draft** release. CI runs `goreleaser check`; no release tag has been pushed.
- The README now includes a Cloudflare Deploy Button and self-hosted deployment and Connector instructions. The button requires a public repository; the copied project still needs the operator's custom domain routes and DNS before it accepts traffic.
- `CONTRIBUTING.md` and `SECURITY.md` document contribution and vulnerability reporting. Enable GitHub private vulnerability reporting and choose a `LICENSE` before making the repository public; it remains private for now.
- The agreed public mode is self-hosted: each operator deploys their own Worker and supplies their own Cloudflare domain and secret. This repository will not provide a shared public endpoint.

## Suggested next steps

1. Continue adding exact proxied DNS records for new IDs, or automate those per-tunnel records. Keep broad wildcard DNS disabled unless its effect on otherwise-unconfigured subdomains is intended.
2. If required, run longer live expiry and application WebSocket checks on the flat visitor hostname; the live flat-host check so far used a static HTTP page.
3. Preserve the generic repository configuration and keep personal hostnames, account details, and secrets out of Git.

Local reproduction commands are in the README. Use `wrangler.local.jsonc` for local development; production routes cause Wrangler to infer a fixed local hostname and can invalidate virtual-host tests.
