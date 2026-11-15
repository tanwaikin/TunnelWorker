# Implementation and live-test handoff

## Implemented and validated locally

- TypeScript Cloudflare Worker and SQLite Durable Object per tunnel; Go CLI.
- Random tunnel IDs, absolute TTL (30 minutes by default, 1 minute to 24 hours), and reconnect without extending expiry.
- Optional visitor password with HTTP Basic bootstrap and an HttpOnly/Secure cookie for browser WebSocket access.
- Bounded HTTP bodies, streamed responses with acknowledgements, and WebSocket text/binary/subprotocol forwarding.
- The original Host-routed baseline had passed Go race tests and vet, TypeScript typecheck, four workerd integration tests, Wrangler dry-run, and local end-to-end smoke tests. The smoke coverage included streaming, bodyless statuses, repeated cookies, gzip, password gating, reconnect/expiry, origin failure, and graceful revoke.
- Control routing now uses `GET /api/tunnels/{id}/connect` for the connector WebSocket and `DELETE /api/tunnels/{id}` for connector revocation. The Worker forwards these routes to the existing DO `/_control` handler after validating the 36-character lowercase hex tunnel ID. The Go connector no longer overrides Host for production control WebSockets; the loopback Wrangler virtual host remains supported.
- The path-routed change passed `npm ci`, `npm run typecheck`, `npm test` (5 integration tests), `go test ./...`, `go vet ./...`, and `python scripts/smoke.py --skip-expiry` locally. The local smoke confirmed the real Go connector established its WSS and forwarded HTTP and application WebSocket traffic through Wrangler/Workerd. Its `--skip-expiry` option skipped the wall-clock expiry scenario; the integration test still checked that reconnect reports the original expiry.

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

The existing `tunnelworker` was updated in place for the operator's requested domain. Its apex and wildcard Worker routes and proxied DNS records were switched to that domain. The path-routed Worker version is deployed at 100% (current version 5, deployment `769e39dd-5e17-48e4-9c67-1f4fe22ae0e5`). It reuses the existing Durable Object namespace; `BASE_DOMAIN` and the existing numeric settings were verified after deployment. At the operator's request, the `OPERATOR_TOKEN` secret was re-PUT from this checkout's ignored `.dev.vars`; its value is intentionally not recorded. The generic Wrangler config remains unchanged.

| Check | Result |
| --- | --- |
| Control-host HTTPS `/_health` with TLS verification | HTTP 200, `{"status":"ok"}`, Cloudflare Ray ID present |
| Tunnel creation through the deployed API with `.dev.vars` after re-PUT | Succeeded; generated a short-lived test tunnel |
| New control WSS path with the real connector credential | HTTP 101 from an explicit Go WebSocket handshake; the real CLI also logged `control connection established` |
| HTTP request through a live public tunnel URL | HTTP 200 with Cloudflare Ray ID and the local origin response `origin-ok:/live-test?source=codex` |
| Reconnect on the same tunnel ID | The real connector re-established after a replacement handshake; saved expiry stayed `2026-11-14T19:50:02.863Z` |
| Graceful connector shutdown and revoke through the new DELETE route | CLI exited cleanly; the subsequent visitor request returned HTTP 410 `tunnel_expired`, and the session file was removed |
| New control connect path with a valid-format but nonexistent ID | HTTP 410 with Cloudflare Ray ID; Worker/DO routing was reached |
| Public HTTPS request to that wildcard host, TLS verification enabled | HTTP 503 from the Codex Cloud Envoy proxy (`upstream connect error ... remote connection failure`), without a Cloudflare Ray ID; it failed before evidence of Worker execution |

The valid control WSS request obtained 101 through the Codex Cloud proxy, so the original control-path Envoy 503 was not reproduced after moving control routing to the URL path. The remaining HTTPS visitor 503 is separate: it came from Envoy without a Cloudflare Ray ID. Its exact cause is unconfirmed; the zone certificate inventory lacks coverage for the nested visitor wildcard, so browser HTTPS and visitor WSS remain unverified. No certificate order or subscription change was made.

## Unresolved issues

1. **Visitor certificate coverage:** the configured visitor wildcard is nested below the zone apex and is not covered by the zone's current certificates. An attempted Advanced Certificate Manager order was rejected by automatic approval review because it might incur a charge. No order or subscription change was made. Billing Read is unavailable to the connected Cloudflare OAuth session, so any additional cost was not established. Obtain explicit approval for any potentially paid certificate action, or independently establish a non-billable entitlement before retrying.
2. **Public visitor HTTPS/WebSocket:** live HTTP forwarding works, but the HTTPS wildcard request did not reach Cloudflare and certificate coverage for the nested wildcard is absent. Application WebSocket forwarding over the public hostname, streaming, and password/cookie access were not tested live.
3. **Extended expiry acceptance:** reconnect preserved the original timestamp in the connector session, but the live tunnel was intentionally revoked before its 15-minute lifetime elapsed; natural expiry was covered locally, not waited out in Cloudflare.

## Suggested next steps

1. Resolve nested visitor wildcard certificate coverage without an unapproved paid change, then test browser HTTPS/WebSocket access with certificate verification enabled.
2. If required, run longer live expiry and application WebSocket checks; the control 101, HTTP forwarding, reconnect timestamp, and DELETE revoke have already passed.
3. Preserve the generic repository configuration and keep personal hostnames, account details, and secrets out of Git.

Local reproduction commands are in the README. Use `wrangler.local.jsonc` for local development; production routes cause Wrangler to infer a fixed local hostname and can invalidate virtual-host tests.
