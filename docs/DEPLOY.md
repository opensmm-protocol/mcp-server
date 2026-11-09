# Deploying an OpenSMM gateway

One process serves both bindings: REST `/v0` and MCP `/mcp` on one port
(default 8080). State (orders, metrics, self-registered nodes) lives in a
single JSON snapshot file — mount it on a volume and the gateway survives
restarts and redeploys.

## Run a node in 5 minutes

One command starts a complete node: REST `/v0` and MCP `/mcp` on one port,
on the built-in mock catalog. No keys, no external services, no code
changes. Requires Node.js ≥ 22.18.

```bash
npx -y @opensmm/mcp-server gateway --port 8080
```

If the published package does not contain the `gateway` command yet (npm
publication is tracked in ZHC-287), run the same command from a checkout:

```bash
npm ci && npm run build && node bin/opensmm.mjs gateway --port 8080
```

The node reports its port on stderr:

```
OpenSMM 0.1.0 gateway listening on http://localhost:8080 (REST /v0, MCP /mcp; provider: mock, mock catalog — not real supply)
```

Check the node:

```bash
curl -s http://localhost:8080/v0/capabilities   # protocol version, commands
curl -s http://localhost:8080/v0/services       # served catalog
curl -s http://localhost:8080/v0/providers      # provider nodes and metrics
```

What you see after the start:

- The catalog is the **mock catalog**. Every service has `"synthetic": true`
  and `providerRef: "provider-alpha"`. Mock services are fixtures for local
  development: they are not sellable supply and no real order is placed. The
  live catalog is empty until you connect a provider (see README,
  «Connecting a live provider (rest-v1)»).
- `GET /v0/providers` lists one node, `provider-alpha`, with `synthetic: true`,
  its `lifecycle`, `offersCount` and gateway-measured `metrics`. `metrics`
  shows `sampleSize: 0` until the node executes orders; measured fields
  appear only when the sample justifies them (spec/v0 §9).
- A provider node that you register yourself starts at lifecycle
  `UNVERIFIED`: it runs in sandbox, its orders are volume-capped per order
  until measured quality promotes it to `ACTIVE` (spec/v0 §10.1).
- MCP clients connect to `http://localhost:8080/mcp` (Streamable HTTP,
  stateless, open CORS). `tools/list` returns 11 tools.

Keep the state across restarts with a snapshot file:

```bash
npx -y @opensmm/mcp-server gateway --port 8080 --state ./opensmm-state.json
```

`--port` and `--state` override the `PORT` and `OPENSMM_STATE_FILE`
variables; `--help` lists the flags. Every variable is commented in
`.env.example`. To publish the node to agents, put TLS in front (section
«TLS + public endpoint (Caddy)» below) and set `OPENSMM_PROVIDER_PAYOUT`,
so that the orders of this node carry your payout address.

## Docker (recommended)

The image is published to the GitHub Container Registry on every merge to
`main` and on `v*` tags (`.github/workflows/publish.yml`). No build, no
checkout, no keys:

```bash
docker run -p 8080:8080 -v opensmm-data:/data ghcr.io/opensmm-protocol/gateway
```

Add `-d --name opensmm` to run it in the background:

```bash
docker run -d --name opensmm -p 8080:8080 -v opensmm-data:/data ghcr.io/opensmm-protocol/gateway
```

The node starts on the mock catalog and answers on
`http://localhost:8080` (`/v0/services`, `/v0/providers`, `/mcp`) within a
few seconds. Add a live provider and your payout address with `-e`:

```bash
docker run -d --name opensmm -p 8080:8080 -v opensmm-data:/data \
  -e OPENSMM_REST_V1_BASE_URL=https://provider.example/api/v1 \
  -e OPENSMM_REST_V1_API_KEY=your-reseller-key \
  -e OPENSMM_PROVIDER_PAYOUT=0xYourUsdcBaseAddress \
  ghcr.io/opensmm-protocol/gateway:latest
```

or `docker compose up -d` (see `docker-compose.yml`).

Image tags: `latest` (default branch), `X.Y.Z` and `X.Y` (on a `vX.Y.Z`
tag), `sha-<commit>` for every build. The image is `linux/amd64`. The
package is public, so `docker pull` needs no credentials; the publish
workflow fails if an anonymous pull does not work. The image is built from
this repository's `Dockerfile`; `scripts/smoke-container.sh` runs a
container end to end (catalog, MCP `initialize`, `tools/list`, order
idempotency, providers). CI repeats the same smoke test on every pull
request.

To test local changes instead of the published image, build it yourself —
development only:

```bash
docker build -t opensmm-gateway . && docker run -d -p 8080:8080 -v opensmm-data:/data opensmm-gateway
```

The state file (`/data/opensmm-state.json`) contains provider credentials —
it is written with mode `0600`; back it up like a secret.

## TLS + public endpoint (Caddy)

For `https://mcp.opensmm.dev`:

```caddyfile
mcp.opensmm.dev {
    reverse_proxy 127.0.0.1:8080
}
```

Caddy issues and renews the certificate automatically. Agents then connect
to `https://mcp.opensmm.dev/mcp` (Streamable HTTP, stateless, CORS-open);
REST is available on the same host under `/v0`.

How agents discover OpenSMM (npm package, MCP Registry entry, weekly download
metric) is documented in [`REGISTRY.md`](./REGISTRY.md). A gateway an operator
deploys like this is not published to the registry: the public entry stays
package-only.

## Environment

| Variable | Purpose |
|---|---|
| `PORT` | Listen port (default 8080). |
| `OPENSMM_REST_V1_BASE_URL` / `OPENSMM_REST_V1_API_KEY` | Live execution provider. Without them the gateway boots on the in-memory MockProvider (dev only). |
| `OPENSMM_PROVIDER_PAYOUT` | Direct-settlement payTo address (USDC on Base) published in payment requirements. |
| `OPENSMM_PROVIDER_LISTED_NAME` | Opt-in public displayName in `list_providers`. |
| `OPENSMM_STATE_FILE` | State snapshot path (default in Docker: `/data/opensmm-state.json`). Unset = in-memory only. |
| `OPENSMM_STATE_SAVE_MS` | Autosave cadence (default 30000). A final flush runs on SIGINT/SIGTERM. |
| `OPENSMM_SUPERVISOR` | `0` disables catalog-sync/poll supervision (default on for live providers). |
| `OPENSMM_SYNC_INTERVAL_MS` / `OPENSMM_POLL_INTERVAL_MS` | Supervision cadence (defaults 5 min / 30 s). |
| `OPENSMM_RETENTION_CHECK_MS` | Retention re-check delay (default 7 days). |

## Production checklist

- [ ] Live provider configured (`OPENSMM_REST_V1_*`), mock rail disabled for
      real money flows (`paymentMethods` config in code) — the mock rail is
      dev-only (spec §11).
- [ ] `OPENSMM_STATE_FILE` on a persistent volume.
- [ ] TLS in front (Caddy or Cloudflare).
- [ ] `OPENSMM_ALLOW_PRIVATE_ENDPOINTS` unset — it is the dev SSRF escape hatch.
- [ ] Firewall: only 80/443 inbound; the gateway listens on 127.0.0.1.
