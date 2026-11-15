# Contributing

TunnelWorker is a self-hosted Cloudflare Worker and Go Connector. Contributions should preserve per-instance credentials, absolute tunnel expiry, TLS verification, and the visitor hostname format `<id>-tunnel.<VISITOR_DOMAIN>`.

## Local checks

The CI workflow runs these checks:

```sh
npm ci
npm run types
npm run typecheck
npm test
go test -race ./...
go vet ./...
python -m pip install -r requirements-smoke.txt
python scripts/smoke.py --skip-expiry
npx wrangler deploy --dry-run --outdir=/tmp/tunnelworker-dry-run
```

The smoke test uses local Wrangler, a local HTTP/WebSocket origin, and the Go Connector. It does not deploy to a Cloudflare account. Do not add real domains, tokens, credentials, or account identifiers to commits or tests.

CI also runs `goreleaser check` to validate the release configuration. Install GoReleaser locally if you want to run that check before opening a pull request.

## Changes and pull requests

- Keep changes focused and update README or HANDOFF documentation when behavior or setup changes.
- Add or update tests for behavior changes.
- Do not change production Cloudflare resources as part of CI.
- Describe user-visible behavior and any required Worker, DNS, or Connector upgrade steps in the pull request.
