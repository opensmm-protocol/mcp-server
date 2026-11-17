# Deploying an OpenSMM gateway

One process serves both bindings: REST `/v0` and MCP `/mcp` on one port
(default 8080). State (orders, metrics, self-registered nodes) lives in a
single JSON snapshot file — mount it on a volume and the gateway survives
restarts and redeploys.

## Run a node in 5 minutes

From a checkout, two commands start a complete node: REST `/v0` and MCP
`/mcp` on one port, on the built-in mock catalog. No keys, no external
services, no code changes. Requires Node.js ≥ 22.18.

```bash
git clone https://github.com/opensmm-protocol/mcp-server.git
cd mcp-server
npm ci
PORT=8080 OPENSMM_STATE_FILE=./opensmm-state.json npm run gateway
```

There is no npm package and no public image: a checkout of this repository is
the install source, and both routes below build the node from it.
Every variable is commented in
`.env.example`. To publish the node to agents, put TLS in front (section
«TLS + public endpoint (Caddy)» below) and set `OPENSMM_PROVIDER_PAYOUT`,
so that the orders of this node carry your payout address.

The node reports its port on stderr:

```
OpenSMM 0.1.1 gateway listening on http://localhost:8080 (REST /v0, MCP /mcp; provider: mock, mock catalog — not real supply)
```

Check the node:

```bash
curl -s http://localhost:8080/v0/capabilities   # protocol version, commands
curl -s http://localhost:8080/v0/services       # served catalog
curl -s http://localhost:8080/v0/providers      # provider nodes and metrics
npm run census -- --url http://localhost:8080   # "status": "up"
node scripts/node-census.mjs --url http://localhost:8080   # same check without npm
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

Troubleshooting common startup issues (port conflict, Node version, state file permissions, offline npm ci, mock catalog):
[`docs/TROUBLESHOOTING.md`](./TROUBLESHOOTING.md).

## Health check

The node exposes a liveness endpoint for reverse proxies, load balancers and
container monitors: `GET /health` (also reachable as `GET /v0/health`). It
answers `200` on the mock catalog, on a live provider and while the catalog is
still syncing — it reports the process, not the supply.

```bash
curl -s http://localhost:8080/health
```

```json
{
  "status": "ok",
  "version": "0.1.1",
  "uptime": 12.345
}
```

`uptime` is the process uptime in seconds. The response is CORS-open
(`access-control-allow-origin: *`) and `OPTIONS /health` answers `204`, so a
browser or a dashboard can poll it directly. Use it as the upstream check in
Caddy/nginx and as the container liveness probe. It reports the process, not
the supply: the full check — catalog plus MCP `initialize` — stays with
`npm run verify:node` and `npm run census`.

## Rate limit

Every client IP gets a sliding window of `OPENSMM_RATE_LIMIT_PER_MIN` requests
per minute (default 120). REST `/v0` and MCP `/mcp` share one window, so a
client cannot double its budget by switching transports. The N+1-th request
inside the window is answered before it reaches core state:

```bash
curl -s -i http://localhost:8080/v0/services | head -3   # once over the limit
# HTTP/1.1 429 Too Many Requests
# retry-after: 12
# {"error":{"code":"RATE_LIMITED","message":"too many requests from this IP",
#           "details":{"retryAfterSeconds":12}}}
```

`retry-after` is in seconds — the time until the oldest request leaves the
window. The body is the canonical error from `spec/v0/schemas/error.json`.
`OPENSMM_RATE_LIMIT_PER_MIN=0` disables the limit.

`GET /health` (and `OPTIONS`) never consume the window, so a monitor stays
green while an agent is throttled.

The client IP is the socket address. Behind your own reverse proxy every
request arrives from the proxy, so set `OPENSMM_TRUST_PROXY=1` to take the
first `x-forwarded-for` hop instead — only when that proxy overwrites the
header (Caddy does; nginx needs `proxy_set_header X-Forwarded-For
$remote_addr`), otherwise a client can spoof its own identity.

## Docker (optional)

The Docker route is a local build from this checkout — `docker-compose.yml`
builds directly from the repository, and there is no public image to pull.
One command, from zero (Docker installed, nothing checked out):

```bash
git clone https://github.com/opensmm-protocol/mcp-server.git && cd mcp-server && docker build -t opensmm-gateway . && docker run -d --name opensmm -p 127.0.0.1:8080:8080 -v opensmm-data:/data opensmm-gateway
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8080/v0/services   # 200
```

Build and start the node with Docker Compose:

```bash
docker compose up --build -d
```

(omit `-d` to run in the foreground: `docker compose up --build`).

The gateway builds from the local `Dockerfile`, mounts the named volume
`opensmm-data` for state (`/data`), and binds port 8080 to loopback
(`127.0.0.1:8080:8080`).

State goes to `/data/opensmm-state.json` on that volume: `docker-compose.yml`
sets `OPENSMM_STATE_FILE=/data/opensmm-state.json` in
`services.gateway.environment`, so orders and metrics survive
`docker compose restart` and `docker compose down` (the volume stays).
Without the variable the gateway keeps state in memory only and loses orders
on every restart.

The compose service declares a `healthcheck` that polls `GET /v0/services`
inside the container with `node -e` (the runtime image ships no curl/wget).
`/v0/services` answers only after the catalog is loaded, so `healthy` means
"ready to take an order", not just "process up" — `/health` covers the
process check for proxies. Wait for `healthy` before sending traffic:

```bash
docker compose ps                      # STATUS column shows "healthy"
docker inspect --format '{{.State.Health.Status}}' $(docker compose ps -q gateway)
```

Verify the node before the weekly census:

```bash
npm run verify:node -- http://127.0.0.1:8080
```

The port binds to loopback only: the node has no TLS and no authentication
of its own, so it must not listen on a public interface. Put Caddy in front
for a public node (section «TLS + public endpoint (Caddy)»).

The node starts on the mock catalog and answers on
`http://localhost:8080` (`/v0/services`, `/v0/providers`, `/mcp`) within a
few seconds. Add a live provider and your payout address in an `.env` file or
with `-e`:

```bash
docker run -d --name opensmm -p 127.0.0.1:8080:8080 -v opensmm-data:/data \
  -e OPENSMM_REST_V1_BASE_URL=https://provider.example/api/v1 \
  -e OPENSMM_REST_V1_API_KEY=your-reseller-key \
  -e OPENSMM_PROVIDER_PAYOUT=0xYourUsdcBaseAddress \
  opensmm-gateway
```

Or build and run manually with plain Docker:

```bash
docker build -t opensmm-gateway .
docker run -d --name opensmm -p 127.0.0.1:8080:8080 -v opensmm-data:/data opensmm-gateway
```

`docker-compose.yml` builds the node locally from the checkout (`build: .`).
The image belongs to the build, not to a registry: there is no public image to
pull, and the gateway is not distributed that way.

A node with a live provider that other people can reach must also set the
payment rail: `-e X402_FACILITATOR_URL=https://x402.org/facilitator -e
X402_PAYTO_ADDRESS=0xYourUsdcBaseAddress`. Without `X402_FACILITATOR_URL`
the gateway keeps the dev-only mock rail, which settles orders without any
payment — every order then spends the operator's provider balance for free.

CI also builds that same `Dockerfile` into the project's own private package in
the GitHub Container Registry on every merge to `main` and on `v*` tags
(`.github/workflows/publish.yml`), `linux/amd64`, with tags `latest` (default
branch), `X.Y.Z` and `X.Y` (on a `vX.Y.Z` tag) and `sha-<commit>`. That package
is internal to the project — an operator's route is the local build above.
`scripts/smoke-container.sh` runs a container end to end (catalog, MCP
`initialize`, `tools/list`, order idempotency, providers). CI repeats the
same smoke test on every pull request.

Verify the node with the census tool:

```bash
npm run census -- --url http://localhost:8080   # "status": "up"
node scripts/node-census.mjs --url http://localhost:8080   # same check without npm
```

The state file (`/data/opensmm-state.json`) contains provider credentials —
it is written with mode `0600`; back it up like a secret.

## systemd service (Linux without Docker)

Without Docker the node is a single process: run it under systemd so it starts
at boot and restarts after a crash, an OOM kill or a reboot. The ready unit and
the step-by-step install live in
[`../examples/systemd/`](../examples/systemd/README.md):
[`opensmm.service`](../examples/systemd/opensmm.service) (unprivileged user,
`Restart=always`, `EnvironmentFile=/etc/opensmm/opensmm.env`,
`StateDirectory=opensmm`) plus the README that sets up the service user, the
checkout, the environment file, `/var/lib/opensmm` for state and the
`systemctl enable --now opensmm` command.

The same two checks as everywhere else confirm the service:

```bash
curl -s http://127.0.0.1:8080/health
npm run verify:node -- http://127.0.0.1:8080
```

The unit listens on `0.0.0.0` like every other route — put Caddy in front
(next section) before the node is reachable from the internet.

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

The project has no MCP Registry entry: no package is published and OpenSMM hosts
no public MCP endpoint of its own, so the registry schema cannot describe the
project itself; OpenSMM is installed from source (see «Run a node in 5 minutes»
above). A node an operator exposes like this is theirs to publish — schema
`2025-12-11` describes it under `remotes` pointing at `https://mcp.opensmm.dev/mcp`.
Details: [`REGISTRY.md`](./REGISTRY.md).

## Environment

| Variable | Purpose |
|---|---|
| `PORT` | Listen port (default 8080). |
| `OPENSMM_ACCESS_LOG` | `0` turns off the JSON request log on stdout (default on): time, method, path, status, duration and `x-request-id`; no bodies, headers or query. |
| `OPENSMM_MAX_BODY_BYTES` | Largest accepted request body in bytes for REST `/v0` and MCP `/mcp` (default 1048576 = 1 MiB). A bigger POST is answered `413 PAYLOAD_TOO_LARGE` and the body read stops, so the process keeps serving `/health`. |
| `OPENSMM_REST_V1_BASE_URL` / `OPENSMM_REST_V1_API_KEY` | Live execution provider. Without them the gateway boots on the in-memory MockProvider (dev only). |
| `OPENSMM_PROVIDER_PAYOUT` | Direct-settlement payTo address (USDC on Base) published in payment requirements. |
| `OPENSMM_PROVIDER_LISTED_NAME` | Opt-in public displayName in `list_providers`. |
| `OPENSMM_STATE_FILE` | State snapshot path (default in Docker: `/data/opensmm-state.json`). Unset = in-memory only. |
| `OPENSMM_STATE_SAVE_MS` | Autosave cadence (default 30000). A final flush runs on SIGINT/SIGTERM. |
| `OPENSMM_SUPERVISOR` | `0` disables catalog-sync/poll supervision (default on for live providers). |
| `OPENSMM_SYNC_INTERVAL_MS` / `OPENSMM_POLL_INTERVAL_MS` | Supervision cadence (defaults 5 min / 30 s). |
| `OPENSMM_RETENTION_CHECK_MS` | Retention re-check delay (default 7 days). |
| `OPENSMM_RATE_LIMIT_PER_MIN` | Requests per minute per client IP, sliding window, shared by REST and MCP (default 120; `0` disables). |
| `OPENSMM_TRUST_PROXY` | `1` behind your own reverse proxy: take the client IP from `x-forwarded-for` (default 0). |

## Production checklist

- [ ] Live provider configured (`OPENSMM_REST_V1_*`), mock rail disabled for
      real money flows (`paymentMethods` config in code) — the mock rail is
      dev-only (spec §11).
- [ ] `OPENSMM_STATE_FILE` on a persistent volume.
- [ ] TLS in front (Caddy or Cloudflare).
- [ ] `OPENSMM_ALLOW_PRIVATE_ENDPOINTS` unset — it is the dev SSRF escape hatch.
- [ ] Firewall: only 80/443 inbound; the gateway listens on 127.0.0.1.

## Release version and tag

The release version has one source: `version` in `package.json`. A bump touches
`package.json`, `src/version.ts` and both `version` fields of `server.json`; then
`npm run manifests:sync` mirrors `server.json` into `mcp.json` and
`website/mcp.json`. `npm test` fails when any of these values drift.

A tag `vX.Y.Z` marks the merge commit of a release and does not depend on
publishing: when the tag and the package version differ, `registry-publish.yml`
skips npm and the registry with a notice and the run stays green. The release
manager orders the bump in the release card of the window and a coder ships it as
a separate PR before the release; a release without a bump still ships, but gets
no new tag.
