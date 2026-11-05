# Launch drafts (EN)

Working drafts for public launch posts. Edit dates/links before posting.

## Hacker News (Show HN)

**Title:** Show HN: OpenSMM – an open MCP/REST protocol for ordering social-media growth services, with direct agent→provider payments

**Text:**

I built an open protocol that gives AI agents a single, canonical way to search, quote, order and track social-media growth services (SMM) — the market that today lives behind hundreds of incompatible reseller panel APIs from ~2012.

What it does differently:

- One command set over REST /v0 and MCP. Same clientReference → same orderId on any transport; idempotency and decimal-string money are protocol rules, not conventions.
- Providers self-onboard with one call (`register_provider`): SSRF-guarded, healthchecked, catalog-synced. Classic panels join with zero code — the gateway speaks their legacy key+action API dialect for them.
- Providers are pseudonymous (`provider-alpha`, …) and ranked only by gateway-measured metrics (start latency, delivered ratio, retention). The tier formula is open — anyone can recompute it.
- Direct settlement is canonical: orders carry x402 payment requirements (USDC on Base) with the provider's own payout address as payTo. A gateway routes and measures; it never custodies funds.

Repo: https://github.com/opensmm-protocol/mcp-server (spec + reference gateway, 86 tests, MIT)
MCP client config: `{ "command": "npx", "args": ["-y", "@opensmm/mcp-server"] }`

Happy to answer questions about the x402 flow, the provider SPI, or why payment and execution are separate state machines.

## Reddit r/MCP + r/artificial

**Title:** I open-sourced a protocol that lets AI agents order SMM services directly from providers — MCP-native, 0% protocol fees, x402 payments

**Body:**

Repo: https://github.com/opensmm-protocol/mcp-server

- 10 commands, same over REST and MCP (search → quote → order → pay → track)
- Panels self-onboard with zero code (legacy API dialects are adapted gateway-side)
- Pseudonymous provider showcase with gateway-measured quality metrics — no self-reported ratings
- Direct settlement: agents pay providers in USDC on Base via x402; the gateway never touches funds
- Spec-first: JSON Schemas for every model, 8 runnable examples, 86 tests

Agents can install it as an MCP server: `npx -y @opensmm/mcp-server`.
Feedback welcome — especially on the spec (spec/v0) and the provider SPI.

## X/Twitter thread (3 posts)

1/ OpenSMM is live: an open protocol that lets AI agents search, quote and order social-media growth services directly from providers. MCP-native, REST /v0, x402 (USDC on Base). No middleman fees, no custody. 🧵
https://github.com/opensmm-protocol/mcp-server

2/ How it works: providers self-register with one call (SSRF-guarded, healthchecked). Legacy panel APIs are adapted gateway-side, so onboarding is zero-code. Agents see a pseudonymous showcase ranked by measured quality — start latency, delivered ratio, retention — with an open tier formula.

3/ Money never transits the gateway: orders carry x402 payment requirements with the provider's own payout address. The protocol routes and measures; it is not a party to the trade. MIT, spec-first, 86 tests. `npx -y @opensmm/mcp-server` to try it from your agent.
