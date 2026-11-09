# Deploying an OpenSMM gateway

One process serves both bindings: REST `/v0` and MCP `/mcp` on one port
(default 8080). State (orders, metrics, self-registered nodes) lives in a
single JSON snapshot file — mount it on a volume and the gateway survives
restarts and redeploys.

## Docker (recommended)

```bash
docker build -t opensmm-gateway .
docker run -d --name opensmm \
  -p 127.0.0.1:8080:8080 \
  -v opensmm-data:/data \
  -e OPENSMM_REST_V1_BASE_URL=https://provider.example/api/v1 \
  -e OPENSMM_REST_V1_API_KEY=your-reseller-key \
  -e OPENSMM_PROVIDER_PAYOUT=0xYourUsdcBaseAddress \
  opensmm-gateway
```

or `docker compose up -d` (see `docker-compose.yml`).

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
