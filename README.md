# OpenSMM Protocol

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](https://opensource.org/licenses/MIT)

> **Open, provider-neutral protocol for ordering and executing social media growth services by AI agents.**
> MCP is one way to connect — not the product itself.

**Status: `0.1.0-draft` — the spec and reference gateway are feature-complete
for the v0 draft and covered by tests; not yet published to npm or MCP registries.**

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
  facilitator interface; ships with a mock facilitator for tests. The core only
  knows the `PaymentRail` SPI, so TON/CryptoBot plug in the same way.

## The one rule of the protocol

> The same operation through REST and MCP produces the same domain objects.
> Same `clientReference` → same `orderId`, on any transport.

## Quick start (local, MockProvider)

Requires Node.js ≥ 22.6 (runs TypeScript natively).

```bash
npm install
npm test          # 86 tests: core, transports, adapters, payments, registry, spec examples
```

REST:

```bash
npm run rest      # http://localhost:3100/v0
curl http://localhost:3100/v0/capabilities
curl "http://localhost:3100/v0/services?query=members&platform=telegram"
```

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
      "command": "node",
      "args": ["/path/to/mcp-server/src/adapters/inbound/mcp/server.ts"]
    }
  }
}
```

Tools: `get_capabilities`, `list_providers`, `register_provider`,
`search_services`, `get_service`, `get_quote`, `create_order`,
`get_order_status`, `cancel_order`, `request_refill`.

`list_providers` (REST: `GET /v0/providers`) returns the pseudonymous provider
showcase: lifecycle, capabilities, offers count, and gateway-measured quality
metrics. Providers are listed under opaque keys (`provider-alpha`, …); a
human-readable `displayName` appears only for providers that opted in.

`register_provider` (REST: `POST /v0/providers`) is provider self-onboarding
(spec/v0 §10): the endpoint URL must pass the SSRF guard, the gateway
healthchecks the provider API by listing its offers, syncs them into the
catalog and returns the pseudonymous `providerKey`. Credentials are used only
to call the provider and are never returned. A `payoutAddress` enables direct
settlement (spec/v0 §8): it becomes the `payTo` of that provider's payment
requirements — money flows agent → provider, never through the gateway.

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
8. 🟡 x402: rail with mock facilitator done (incl. `SETTLEMENT_PENDING`);
     testnet needs a real facilitator config.
9. ⬜ Background catalog sync + healthchecks with circuit breaker
     (`SUSPENDED` on degradation).
10. ⬜ Gateway-measured metrics feeding the public provider showcase.
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
