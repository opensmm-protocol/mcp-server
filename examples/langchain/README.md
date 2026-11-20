# LangChain-style agent: catalog → quote → order → replay

A runnable tool-calling agent against a local OpenSMM node. The three tools
`search_services`, `get_quote` and `create_order` are the same tools an
MCP-equipped LangChain agent gets from `@langchain/mcp-adapters`; this example
calls them directly over `POST /mcp`, so it needs **no LLM key, no
`@langchain/*` install and no money**. Node.js ≥ 22.18 is enough.

## Run

```bash
git clone https://github.com/opensmm-protocol/mcp-server.git
cd mcp-server
npm ci
npm run gateway
```

In a second terminal:

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

The `replay:` line is the same `orderId` as `order:`: one `clientReference`
produces one order on any transport. The order stays `REQUIRES_PAYMENT` — the
example never pays and nothing is executed.

Options: `[base-url]` (default `http://127.0.0.1:8080`),
`--client-reference <ref>`, `--quote <quote-id>` to reuse a quote printed by
another run, `--help`.

## Mock-only guard

The script reads the **first service the node returns** — it invents no service
ID — and stops immediately if that service is not marked `synthetic: true`:

```
error: refusing to place a demo order: ... is not marked synthetic. This example orders only on the mock catalog — see examples/README.md.
```

That makes it safe against a node that has a live provider connected.

## Using it with a real LangChain agent

Keep the three tool names and argument shapes printed by `TOOLS` in
`agent.mjs`, expose them through LangChain's MCP adapter pointed at
`http://127.0.0.1:8080/mcp`, and let the model emit the same calls. The REST
equivalents are `GET /v0/services`, `POST /v0/quotes` and `POST /v0/orders`
([`../rest-client.mjs`](../rest-client.mjs)).

Next: [the 5-minute guide](../../docs/AGENT_QUICKSTART.md) ·
[all examples](../README.md).
