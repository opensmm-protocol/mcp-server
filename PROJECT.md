# PROJECT.md — OpenSMM Protocol (mcp-server)

> Management layer for the OpenSMM direction, maintained by Multica agents
> (epic ZHC-47). For working agreements see `CONTEXT.md`.
> The product-level entry point remains `README.md`; this file tracks state
> and roadmap across the direction.

## What this is

Open, provider-neutral protocol for ordering and executing social media
growth services by AI agents. This repo holds the spec (`spec/v0/`), the
reference gateway (REST + MCP over one domain core), provider adapters
(`smm-v2`, `rest-v1`, `mock`), the x402 payment rail, and the `opensmm.dev`
website (`website/`).

Sibling repository in the direction: `babang1da/smm_marketplace` — a
Telegram Mini App SMM marketplace (consumer product). Long-term goal:
smm_marketplace's supply (ProstoSpets, an SMM API v2 panel) joins OpenSMM
as a provider node, and the marketplace's reseller channel dogfoods the
protocol.

## Current state (inventory 2026-11-06)

- v0.1.0 released; spec and reference gateway feature-complete for v0.
- 104 tests green (`npm test`), typecheck clean.
- Shipped since the README roadmap snapshot:
  - Multi-provider registry + `registerProvider` self-onboarding with SSRF
    guard, healthcheck and live catalog sync (roadmap #6 — done).
  - Direct settlement via provider `payoutAddress` (roadmap #7 — done).
  - Node supervision: background catalog sync with circuit breaker,
    `SUSPENDED` on degradation, gateway-measured provider metrics
    (roadmap #9 and #10 — done; README roadmap is stale here).
  - UNVERIFIED trust tier with anti exit-scam volume cap and
    metric-driven promotion/demotion (spec §10.1).
  - Gateway state persistence (atomic JSON snapshots, node restore) and a
    combined REST+MCP `gateway` entry (deploy shape).
  - `opensmm.dev` website: landing, SEO catalog with RU→EN translation
    layer, IndexNow, CNAME tracking.
- x402: rail with mock facilitator done incl. `SETTLEMENT_PENDING`;
  no real facilitator configured yet (roadmap #8 partially open).

## Roadmap

Next increment (sub-issues of epic ZHC-47, stage 1):

1. x402 testnet: configure a real facilitator, run a live small-amount
   payment on Base Sepolia (closes roadmap #8, preps #11).

Further out (stage 2+):

2. x402 mainnet: first real small-amount payment (roadmap #11).
3. Public MVP: 30–50 curated services, no account farms, no A2A (#12).
4. Supply integration: onboard the smm_marketplace provider (ProstoSpets,
   SMM API v2) as a live OpenSMM provider node via the `smm-v2` adapter;
   dogfood the gateway against real catalog + orders.
5. Keep the README roadmap section in sync with actual state.

## Rules

- PRs via `gh`; put the issue key (`ZHC-N`) in the PR title for linking.
- Merge only with green tests and review.
- Open questions escalate to Egor.
