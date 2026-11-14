# Implementation and live-test handoff

## Implemented and validated locally

- TypeScript Cloudflare Worker and SQLite Durable Object per tunnel; Go CLI.
- Random tunnel IDs, absolute TTL (30 minutes by default, 1 minute to 24 hours), and reconnect without extending expiry.
- Optional visitor password with HTTP Basic bootstrap and an HttpOnly/Secure cookie for browser WebSocket access.
- Bounded HTTP bodies, streamed responses with acknowledgements, and WebSocket text/binary/subprotocol forwarding.
- Go race tests and vet, TypeScript typecheck, four workerd integration tests, Wrangler dry-run, and local end-to-end smoke tests passed. Local smoke covered streaming, bodyless statuses, repeated cookies, gzip, password gating, reconnect/expiry, origin failure, and graceful revoke.

## Live deployment status

A deployment of commit `0d1971ca7884ded338df851c1dd6046ae731bab4` was made to the operator's Cloudflare account. Its private domain, deployment configuration, and operator credential are intentionally outside Git. Worker settings, the SQLite Durable Object, DNS records, and routes were created. The default workers.dev endpoint is disabled.

Verified in the managed Cloud test environment:

| Check | Result |
| --- | --- |
| HTTPS control-host `/_health` | 200, normal certificate verification |
| Authenticated tunnel creation | Succeeded |
| Public DNS for control and visitor hosts | Resolves to Cloudflare proxy addresses |
| HTTP request using a tunnel Host override | Envoy 503, upstream connection failure, no CF-Ray |
| Actual Go control WebSocket with tunnel Host override | HTTP 503 |
| WebSocket handshake request to control host without Host override | Worker 404 JSON with CF-Ray; this does not establish a successful WebSocket upgrade |

The CLI currently dials the control endpoint and overrides HTTP Host to select the tunnel. Compare the failing Host-overridden path with the non-overridden control request when diagnosing the environment proxy, upstream TLS/SNI, and routing. The observed 503 does not establish a Durable Object/application failure or prove that WebSocket is generally blocked.

## Unresolved issues

1. **Visitor certificate coverage:** the configured visitor wildcard is nested below the zone apex and is not covered by the zone's current certificates. An attempted Advanced Certificate Manager order was rejected by automatic approval review because it might incur a charge. No order or subscription change was made. Billing Read is unavailable to the connected Cloudflare OAuth session, so any additional cost was not established. Obtain explicit approval for any potentially paid certificate action, or independently establish a non-billable entitlement before retrying.
2. **Live WSS/Host-route 503:** root cause remains unconfirmed. The current Cloud environment uses HTTP(S)_PROXY. Successful control-host HTTPS does not imply that the tunnel-host path works. Keep certificate verification enabled and do not present a Host-override test as validation of the public visitor URL's TLS.
3. **Final public end-to-end acceptance:** live HTTP/WS forwarding, streaming, password/cookie access, reconnect, expiry, and graceful revoke have not passed. Local success must not be reported as live success. Failed test tunnels were short-lived; remote revoke also returned 503, so they were left to expire at their original deadlines.

## Suggested next steps

1. Obtain the operator's private target configuration and credential securely; neither is in this repository.
2. Compare strict TLS access to the same control and visitor hosts from an independent network and the managed Cloud environment. Inspect DNS, certificates, response headers, and proxy diagnostics before assigning a cause.
3. Once certificate coverage is resolved, retry a single short-lived tunnel with the real Go CLI through the intended proxy path.
4. Complete the live acceptance matrix above and record exact passed/blocked checks. Preserve the generic repository configuration and keep personal hostnames, account details, and secrets out of Git.

Local reproduction commands are in the README. Use `wrangler.local.jsonc` for local development; production routes cause Wrangler to infer a fixed local hostname and can invalidate virtual-host tests.
