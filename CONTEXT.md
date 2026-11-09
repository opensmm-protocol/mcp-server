# CONTEXT.md — working in mcp-server

## Stack

Node.js ≥ 22.18 running TypeScript natively (no build step in dev; `npm run build`
emits `dist/` for the npm package). ESM,
`zod` for validation, `@modelcontextprotocol/sdk` for MCP, `ajv` for
spec-schema tests, `viem` (dev) for x402.

## Commands

```bash
npm install
npm test            # node --test "test/**/*.test.ts" — must stay green
npm run typecheck   # tsc --noEmit
npm run build       # tsc -p tsconfig.build.json → dist/ (npm entry point)
npm run rest        # REST gateway :3100
npm run mcp         # MCP over stdio
npm run mcp:http    # MCP Streamable HTTP :3200
npm run gateway     # both bindings in one process :8080 (deploy shape)
```

No linter is configured; `npm test` + `npm run typecheck` are the gate
(also enforced by `prepublishOnly`).

## Layout

- `spec/v0/` — the protocol: JSON Schemas, statuses, error codes,
  idempotency rules, examples. Language- and transport-neutral.
- `src/core/` — domain core (catalog, quoting, orders, payment intents,
  execution state machine, registry, supervisor, persistence).
  **No MCP/HTTP imports allowed in `src/core/`.**
- `src/adapters/inbound/{rest,mcp}` — transports, thin layers over core.
- `src/adapters/providers/{mock,smm-v2,rest-v1}` — execution providers
  behind the Provider SPI. Onboarding a panel = `baseUrl + apiKey + profile`.
- `src/adapters/payments/x402/` — payment rail behind the `PaymentRail`
  SPI; core only knows the SPI.
- `test/` — node:test suites mirroring core, transports, adapters,
  payments, registry, spec examples.
- `website/` — opensmm.dev static site.

## Invariants (enforced by tests — keep them true)

- Same operation via REST and MCP produces the same domain objects;
  same `clientReference` → same `orderId` on any transport.
- Idempotency is part of the protocol: replay returns the same order;
  same key + different params → `IDEMPOTENCY_CONFLICT`.
- `paymentStatus` and `executionStatus` are separate state machines.
- No blind provider retries: ambiguous submission → `SUBMISSION_UNKNOWN`,
  waits for reconciliation, never silently resent.
- Money is decimal strings computed on integer micro-units. No floats.
- A quote is consumed exactly once.

## Process

- Branch from `main`, PR via `gh pr create`, issue key (`ZHC-N`) in the
  PR title.
- Before a PR: `npm test` and `npm run typecheck` green.
- Spec changes (`spec/v0/`) require matching updates to
  `test/spec-examples.test.ts` fixtures.
