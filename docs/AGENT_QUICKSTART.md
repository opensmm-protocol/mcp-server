# Order an SMM service from an agent in 5 minutes

Everything below runs on a **local node and its mock catalog**. Every service
is marked `synthetic: true`, no real order is executed, no API key, account or
money is needed. Orders stay `REQUIRES_PAYMENT` and are never paid.

## 0. Versions this guide is pinned to

| Piece | Fixed version / shape |
| --- | --- |
| Node.js | ≥ 22.18 (the repo's `engines`; tested on 22.x) |
| OpenSMM node | this checkout of `opensmm-protocol/mcp-server` |
| MCP protocol | `2025-06-18` (the version the examples send on `initialize`) |
| Claude Desktop / Cursor | builds using the `mcpServers` config shape; configs shipped below |
| LangChain-style example | tool-call shape of LangChain JS 0.3.x / `@langchain/mcp-adapters`; the runnable script needs **no** package install |
| n8n | 1.x, HTTP Request node `typeVersion: 4.2` (workflow file shipped below) |

No step depends on a "latest" release of a third-party tool: the config and
workflow files in this repo are the pinned interface.

## 1. Start the node (about 2 minutes)

```bash
git clone https://github.com/opensmm-protocol/mcp-server.git
cd mcp-server
npm ci
npm run gateway
```

Expected on stderr:

```
OpenSMM 0.1.1 gateway listening on http://localhost:8080 (REST /v0, MCP /mcp; provider: mock, mock catalog — not real supply)
```

Quick check in another terminal:

```bash
curl -s http://127.0.0.1:8080/v0/services | head -30   # every service has "synthetic": true
```

If the port is taken, pass `PORT=8081 npm run gateway` and use that base URL
in the next step. More startup fixes:
[`TROUBLESHOOTING.md`](./TROUBLESHOOTING.md).

## 2. Pick your stack

| Stack | Config / script | Where to run it |
| --- | --- | --- |
| Claude Desktop | [`examples/claude-desktop/claude_desktop_config.json`](../examples/claude-desktop/claude_desktop_config.json) | stdio, `npm run mcp` — no port needed |
| Cursor | [`examples/cursor/.cursor/mcp.json`](../examples/cursor/.cursor/mcp.json) | HTTP `POST /mcp` on the node from step 1 |
| LangChain-style agent | [`examples/langchain/agent.mjs`](../examples/langchain/agent.mjs) | terminal, no LLM key |
| n8n | [`examples/n8n/workflow.json`](../examples/n8n/workflow.json) | import the workflow, press Execute |

Each directory has its own README with the exact steps and expected output.

## 3. Run one example (about 2 minutes)

The fastest path with no third-party app is the LangChain-style tool caller:

```bash
node examples/langchain/agent.mjs http://127.0.0.1:8080 --client-reference my-first-order
```

Expected output:

```
node:      http://127.0.0.1:8080
transport: MCP tools over POST /mcp (LangChain-style tool calls)
tools:     search_services, get_quote, create_order
tool:      search_services({})
catalog:   MOCK — every service is marked synthetic: not real supply, no real money
service:   osmm_svc_tg_members_std — Telegram Channel Members — Standard
tool:      get_quote({"serviceId":"osmm_svc_tg_members_std","quantity":100,"link":"https://t.me/opensmm_example"})
quote:     osmm_quote_... — 0.241200 USDC for 100 (mock rate)
tool:      create_order({"quoteId":"osmm_quote_...","link":"https://t.me/opensmm_example","clientReference":"my-first-order"})
order:     osmm_order_... — REQUIRES_PAYMENT, clientReference "my-first-order"
tool:      create_order({"quoteId":"osmm_quote_...","link":"https://t.me/opensmm_example","clientReference":"my-first-order"})
replay:    osmm_order_... — same orderId, no second order created
done:      LangChain-style agent OK
```

That is the whole scenario: **catalog → quote → order → replay**. `order:` and
`replay:` are the same `orderId`, which is the one rule of the protocol: the
same `clientReference` yields one order on any transport.

## 4. What the agent actually called

1. `search_services` — read the catalog; every entry carries `synthetic: true`.
   All examples refuse to continue if a service is not marked mock.
2. `get_quote` — price one service for quantity 100 and a link. A quote is
   consumed once, so each order needs its own quote.
3. `create_order` — create an unpaid order (HTTP 402 over REST, still carrying
   the order body). Nothing is paid, nothing executes.
4. `create_order` again with the **same** `clientReference` — a replay that
   returns the stored order instead of creating a second one.

REST equivalents of the same tools: `GET /v0/services`, `POST /v0/quotes`,
`POST /v0/orders`, and `GET /v0/orders/:id` to poll. See
[`../examples/README.md`](../examples/README.md) for the plain REST and Python
clients.

## 5. If something looks wrong

- `error: ... is not marked synthetic` — the node is not on its mock catalog;
  stop, do not order. Restart it without a provider configured.
- `ECONNREFUSED` — the node from step 1 is not running or uses another port.
- `IDEMPOTENCY_CONFLICT` — that `clientReference` already belongs to an order
  made from a different quote; pass `--quote <the original quote>` or use a new
  reference (each example generates a fresh one by default).
- HTTP 402 on `POST /v0/orders` is **expected**, not a failure.

Next: [all examples](../examples/README.md) ·
[protocol spec](../spec/v0/) · [node checks](./NODES.md).
