# OpenSMM Protocol

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](https://opensource.org/licenses/MIT)

> **Open, provider-neutral protocol for ordering and executing social media growth services by AI agents.**
> MCP is one way to connect — not the product itself.

**Status: `0.1.0` — first public release. The spec and reference gateway are
feature-complete for v0 and covered by tests.**

**For AI agents:** start with [`llms.txt`](./llms.txt).
**For supply nodes:** [`docs/PROVIDER_ONBOARDING.md`](./docs/PROVIDER_ONBOARDING.md) —
zero-code registration, including a copy-paste prompt for your AI assistant.

## What this is

OpenSMM separates three concerns that classic SMM panels merge into one:

```text
AI Agent
   │
   ▼
OpenSMM Gateway            ← catalog, quotes, payments, idempotency, MCP/REST
   │ canonical commands
   ▼
OpenSMM Provider SPI       ← execution suppliers behind one adapter interface
   │
   ▼
Execution providers        ← SMM API v2 panels, native providers, ...
```

- `spec/v0/` — the protocol: JSON Schemas for every model, canonical statuses,
  error codes, idempotency rules, flow examples. Language- and transport-neutral.
- `src/core/` — the domain core: catalog, quoting, orders, payment intents,
  execution state machine. No MCP/HTTP imports allowed in here.
- `src/adapters/inbound/rest/` — canonical HTTP binding (`/v0/*`).
- `src/adapters/inbound/mcp/` — MCP tools, a thin layer over the same core.
- `src/adapters/providers/mock/` — in-memory provider for the vertical slice,
  with scriptable failure scenarios (rejection, ambiguous submission, cancel, refill).
- `src/adapters/providers/smm-v2/` — one adapter for the de-facto SMM API v2
  standard (`POST /api/v2`, `key`+`action`) with semantic profiles for panel
  deviations (per-unit rates, success-message refills, provider-credit
  currencies). Onboarding a panel = `baseUrl + apiKey + profile`.
- `src/adapters/providers/rest-v1/` — adapter for reseller-style REST v1 APIs
  (`GET /services`, `POST /orders`, Bearer auth).
- `src/core/provider-registry.ts` + `src/core/ssrf-guard.ts` — multi-provider
  node registry (pseudonymous keys, lifecycle) and the SSRF guard behind
  `registerProvider`.
- `src/adapters/payments/x402/` — x402 payment rail (USDC on Base) behind a
  facilitator interface; ships with a mock facilitator for tests, and an HTTP
  facilitator client (`X402_FACILITATOR_URL`, see
  [`docs/X402_TESTNET.md`](./docs/X402_TESTNET.md)) for live testnet/mainnet
  settlement. The core only knows the `PaymentRail` SPI, so TON/CryptoBot plug
  in the same way.

## The one rule of the protocol

> The same operation through REST and MCP produces the same domain objects.
> Same `clientReference` → same `orderId`, on any transport.

## Install from npm

Requires Node.js ≥ 22.18 — native TypeScript type stripping is on by default
from that version (Node 22.6–22.17 would need `--experimental-strip-types`,
so those versions are not supported).

```bash
npx -y @opensmm/mcp-server
```

MCP client config (Claude Desktop / Kimi Code / Cursor):

```json
{
  "mcpServers": {
    "opensmm": {
      "command": "npx",
      "args": ["-y", "@opensmm/mcp-server"]
    }
  }
}
```

No API keys are required: without `OPENSMM_*` variables the server starts on
the built-in MockProvider catalog. Live provider and payment settings are
opt-in (see below).

## Quick start (local, MockProvider)

Requires Node.js ≥ 22.18 (runs TypeScript natively).

```bash
npm install
npm test          # tests: core, transports, adapters, payments, registry, spec examples
```

REST:

```bash
npm run rest      # http://localhost:3100/v0
curl http://localhost:3100/v0/capabilities
curl "http://localhost:3100/v0/services?query=members&platform=telegram"
```

MCP over stdio (local agents) and Streamable HTTP (hosted gateway, e.g. `https://mcp.opensmm.dev/mcp`):

```bash
npm run mcp         # stdio — point your MCP client at this process
npm run mcp:http    # http://localhost:3200/mcp — stateless Streamable HTTP, open CORS
npm run gateway     # http://localhost:8080 — both bindings in one process (deploy shape)
```

Production deployment (Docker, TLS, state persistence): [`docs/DEPLOY.md`](./docs/DEPLOY.md).

## Run a node in 5 minutes

`npx -y @opensmm/mcp-server gateway --port 8080` starts a complete node — REST `/v0` and MCP `/mcp` on one port, no keys — on the mock catalog (`"synthetic": true`, not real supply).
One command, what you see after, state file and flags: [`docs/DEPLOY.md` → Run a node in 5 minutes](./docs/DEPLOY.md#run-a-node-in-5-minutes).

## Connecting a live provider (rest-v1)

Both entry points boot against the MockProvider by default. To run the gateway
against a live provider exposing a reseller-style REST v1 API
(`GET /services`, `POST /orders`, `GET /orders/:id`, Bearer auth), set:

```bash
# .env (gitignored) or the environment of the process
OPENSMM_REST_V1_BASE_URL=https://provider.example/api/v1
OPENSMM_REST_V1_API_KEY=<reseller api key>
OPENSMM_PROVIDER_ID=provider-alpha   # optional, defaults to "rest-v1"
```

On boot the gateway syncs the catalog from the provider's `GET /services` and
serves it through the same protocol surface. Order creation spends the
provider-side balance of that API key — use a funded key only when you intend
to place real orders.

MCP (stdio, for Claude Desktop / Kimi Code / Cursor):

```json
{
  "mcpServers": {
    "opensmm": {
      "command": "npx",
      "args": ["-y", "@opensmm/mcp-server"]
    }
  }
}
```

or from a checkout: `"command": "node", "args": ["/path/to/mcp-server/bin/opensmm.mjs"]`
(run `npm run build` once — the published entry point runs `dist/`, because
Node refuses TypeScript type stripping inside `node_modules`).

Tools: `get_capabilities`, `list_providers`, `register_provider`,
`search_services`, `compare_offers`, `get_service`, `get_quote`, `create_order`,
`get_order_status`, `cancel_order`, `request_refill`.

`list_providers` (REST: `GET /v0/providers`) returns the pseudonymous provider
showcase: lifecycle, capabilities, offers count, and gateway-measured quality
metrics. Providers are listed under opaque keys (`provider-alpha`, …); a
human-readable `displayName` appears only for providers that opted in.

Choosing between providers for the same service: `search_services` enriches
every offer with `providerRef` (the pseudonymous provider key) and `quality`
(gateway-measured `orders`, `deliveredRatio`, `startLatencyMs`), and accepts
`sort=price|quality|relevance` (`relevance` is the default and keeps the
catalog order). `compare_offers` (MCP tool) goes one step further: one
cheapest offer per provider for a `platform`+`objective`, cheapest first,
with measured quality and the total price for your `quantity` — SUSPENDED
providers are excluded. `GET /v0/services` supports the same `sort` parameter.

`register_provider` (REST: `POST /v0/providers`) is provider self-onboarding
(spec/v0 §10): the endpoint URL must pass the SSRF guard, the gateway
healthchecks the provider API by listing its offers, syncs them into the
catalog and returns the pseudonymous `providerKey`. Credentials are used only
to call the provider and are never returned. A `payoutAddress` enables direct
settlement (spec/v0 §8): it becomes the `payTo` of that provider's payment
requirements — money flows agent → provider, never through the gateway.

## Public MVP: curated catalog

The gateway can serve a **curated catalog** — a hand-reviewed snapshot of
sellable services — instead of calling a provider on boot. Every record keeps
its provenance, so each published price can be traced back to the provider
offer it was copied from.

```bash
OPENSMM_CURATED_CATALOG=./data/curated-services.json npm run rest
```

Without `OPENSMM_CURATED_CATALOG` the gateway behaves exactly as before: mock
seed in local dev, live sync against a configured provider.

### Catalog file format

`data/curated-services.json` holds the wire `Service` (spec/v0 §4) plus a
`provenance` block and curation metadata:

```json
{
  "format": 1,
  "version": "2026-11-06T00:00:00Z",
  "entries": [
    {
      "example": true,
      "rating": 4.6,
      "provenance": {
        "providerId": "mock",
        "externalServiceId": "1001",
        "sourceUrl": "https://example.invalid/mock/services/1001",
        "syncedAt": "2026-11-06T00:00:00Z"
      },
      "service": { "serviceId": "osmm_svc_…", "name": "…" }
    }
  ]
}
```

- `service` — one record of the wire `Service` model: platform, objective,
  rate, rate basis, min/max quantity, capabilities.
- `provenance.providerId` / `externalServiceId` — the provider offer this
  service maps to; orders route to that provider node.
- `provenance.sourceUrl` — the provider-side page or API URL the offer came
  from (`https://` only).
- `provenance.syncedAt` — when the offer was copied (ISO-8601 UTC).
- `rating` — optional curator score, 0–5. The wire `Service` has no rating
  field: spec/v0 publishes gateway-measured metrics only, so this is curation
  metadata, not a protocol claim.
- `example` — `true` marks a placeholder record that must never reach a
  production catalog.

Validation is fail-closed: one bad record stops the gateway at boot with the
offending path and reason. Enforced rules:

- unique `serviceId`; unique `providerId + externalServiceId` pair;
- `provenance` is mandatory, `sourceUrl` must be `https://`, `syncedAt` must be
  an ISO-8601 timestamp;
- rate value between `0.000001` and `10000` per rate basis, `maxQuantity >=
  minQuantity`;
- every `provenance.providerId` must match a provider registered at boot,
  otherwise the catalog would advertise services the gateway cannot route.

The checked-in `data/curated-services.json` contains three **example** records
(telegram members, telegram views, youtube views) copied from the mock seed.
It exists to exercise the schema and tests — it is not a production catalog.
As soon as a live provider is configured (`OPENSMM_REST_V1_BASE_URL`), a
catalog with `example` records is rejected at boot: a public gateway must not
serve placeholders a buyer cannot tell apart from a sellable service.

### How to add a service

1. Take a live offer from the provider's own catalog. Do not invent names,
   prices, limits or capabilities — if the provider catalog is unreachable,
   stop and escalate instead of filling the gap.
2. Copy the offer into a `service` record. `serviceId` is gateway-stable: keep
   it when the price changes, never reuse it for a different offer.
3. Fill `provenance` (`providerId`, `externalServiceId`, `sourceUrl`,
   `syncedAt`). `providerId` must be registered on the gateway at boot.
4. Drop `example` (or set `false`) once the record is real, then run
   `npm test` and start the gateway with `OPENSMM_CURATED_CATALOG`.

### Curated snapshot vs provider live sync

| | Curated catalog | Provider live sync |
| --- | --- | --- |
| Source | reviewed JSON file in the repo | provider API at boot + every 5 min |
| Boot | no provider call needed | `listOffers` healthcheck |
| Content | hand-picked subset | everything the provider returns |
| Price drift | frozen until the file is re-synced | follows the provider |
| Background sync | disabled (would overwrite the review) | enabled, with circuit breaker |

Both modes serve the same REST `/v0/services` and MCP `search_services`
surface. Order polling, retention checks and payment rails are unaffected by
the mode.

## The acceptance flow

```text
search → quote → create order → payment → execution → status → completion
```

```bash
# 1. quote (mandatory before ordering)
curl -X POST http://localhost:3100/v0/quotes -H 'content-type: application/json' \
  -d '{"serviceId":"osmm_svc_tg_members_std","quantity":1000,"link":"https://t.me/example_channel"}'

# 2. order — returns HTTP 402 with the Order body (paymentStatus: REQUIRES_PAYMENT)
curl -X POST http://localhost:3100/v0/orders \
  -H 'content-type: application/json' -H 'Idempotency-Key: my-order-1' \
  -d '{"quoteId":"<quoteId>","link":"https://t.me/example_channel"}'

# 3. settle via the dev-only mock rail
curl -X POST http://localhost:3100/v0/payments/<paymentIntentId>/settle

# 4. poll
curl http://localhost:3100/v0/orders/<orderId>
```

Key properties (enforced by tests):

- **Idempotency is part of the protocol.** `Idempotency-Key` header (REST) /
  `clientReference` (MCP). Replay returns the same order; same key with different
  parameters → `IDEMPOTENCY_CONFLICT`.
- **Payment and execution are separate state machines** (`paymentStatus` vs
  `executionStatus`), never one merged status.
- **No blind provider retries.** An ambiguous submission becomes
  `SUBMISSION_UNKNOWN` and waits for reconciliation — it is never silently resent.
- **Money is decimal strings**, computed on integer micro-units. No floats.
- A quote is consumed exactly once; reuse returns the original order instead of
  double-charging.

## How agents find us

Four entry points, any of them leads to the same server:

- **npm** — `npx -y @opensmm/mcp-server`, no install step and no API key
  needed (Node.js ≥ 22.18).
- **MCP Registry** — `io.github.opensmm-protocol/mcp-server`, searchable at
  `https://registry.modelcontextprotocol.io/v0/servers?search=opensmm`.
- **`llms.txt`** — [`llms.txt`](./llms.txt) is the compact machine-readable
  summary of the protocol, the tools and the docs.
- **Website** — <https://opensmm.dev> for the human-facing view of the same
  material.

There is no public remote MCP endpoint yet: the registry entry is
package-only, and agents run the package locally over `stdio`.

How the registry entry is built, updated and verified — including the weekly
download metric — is documented in [`docs/REGISTRY.md`](./docs/REGISTRY.md).

## Roadmap

1. ✅ Spec draft: JSON Schemas, errors, statuses, examples.
2. ✅ Core: quote, order, idempotency, state machine.
3. ✅ MockProvider: full lifecycle + failure scenarios.
4. ✅ REST + MCP: same scenario through both transports, same `orderId`.
5. ✅ Provider adapters: `smm-v2` (classic panel API with behavior profiles)
     and `rest-v1` (reseller-style REST).
6. ✅ Multi-provider registry + `registerProvider` self-onboarding with SSRF
     guard, healthcheck and live catalog sync.
7. ✅ Direct settlement: provider `payoutAddress` becomes the `payTo` of its
     payment requirements — funds flow agent → provider, never through the
     gateway.
8. 🟡 x402: rail done (incl. `SETTLEMENT_PENDING`) with a real facilitator
     client configured via env — testnet setup and live-run script in
     [`docs/X402_TESTNET.md`](./docs/X402_TESTNET.md). First live Base Sepolia
     payment pending a funded payer key.
9. ✅ Background catalog sync + healthchecks with circuit breaker
     (`SUSPENDED` on degradation).
10. ✅ Gateway-measured metrics feeding the public provider showcase.
11. ⬜ x402 mainnet: real small-amount payment.
12. ⬜ Public MVP: 30–50 curated services. No account farms, no A2A yet.

## Legal notice

OpenSMM is open-source software for routing and measuring API requests. It is
not a marketplace operator, payment processor or escrow agent: with direct
settlement, funds move peer-to-peer between agents and providers, and the
software never holds balances or private keys. Quality metrics are
gateway-measured observations, not guarantees. Each gateway operator and each
provider node is responsible for its own compliance. The software is provided
"as is", without warranty of any kind — see [LICENSE](./LICENSE).

## License

MIT © [OpenSMM Protocol](https://github.com/opensmm-protocol) — see [LICENSE](./LICENSE).
