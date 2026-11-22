# Examples

Runnable clients and copyable reference files for OpenSMM.

## Client examples

Three runnable clients for a running OpenSMM node: catalog, quote, order and an
idempotent replay of the same order — over REST in Node.js, over REST in Python
and over MCP. No dependencies, no MCP SDK, no API keys, no money: Node.js ≥
22.18 with `fetch`, and Python 3.8+ with `urllib.request` from the standard
library.

All three work on the node's **mock catalog**. Every service there is marked
`synthetic: true` and no real order is executed; the scripts refuse to order
anything that is not marked mock, so nothing here can touch real supply.

### 1. Start a node

```bash
git clone https://github.com/opensmm-protocol/mcp-server.git
cd mcp-server
npm ci
npm run gateway
```

The node reports its port on stderr (`listening on http://localhost:8080`).

### 2. Order over REST

```bash
node examples/rest-client.mjs http://127.0.0.1:8080 --client-reference my-first-order
```

```
node:    http://127.0.0.1:8080
catalog: MOCK — every service is marked synthetic: not real supply, no real money
service: osmm_svc_tg_members_std — Telegram Channel Members — Standard
quote:   osmm_quote_... — 0.241200 USDC for 100 (mock rate)
order:   osmm_order_... — REQUIRES_PAYMENT, clientReference "my-first-order"
replay:  osmm_order_... — same orderId, no second order created
done:    REST client OK
```

To not pay anything: the order is created `REQUIRES_PAYMENT` and never settles.

### 3. The same REST walkthrough in Python

`examples/rest-client.py` makes the same calls as the Node.js REST client with
the Python standard library only — `urllib.request` and `json`, no `pip
install`, no SDK:

```bash
python3 examples/rest-client.py http://127.0.0.1:8080 --client-reference my-first-order
```

```
node:    http://127.0.0.1:8080
protocol: 0.1.0 - 10 commands, payment: mock
catalog: MOCK - every service is marked synthetic: not real supply, no real money
service: osmm_svc_tg_members_std - Telegram Channel Members — Standard
quote:   osmm_quote_... - 0.241200 USDC for 100 (mock rate)
order:   osmm_order_... - REQUIRES_PAYMENT, clientReference "my-first-order"
replay:  osmm_order_... - same orderId, no second order created
done:    Python client OK
```

Arguments and options are the same as the Node.js REST client: an optional base
URL (default `http://127.0.0.1:8080`), `--client-reference <ref>` for the
idempotency key, and `--quote <quote-id>` to reuse a quote printed by another
run instead of pricing a new one. The order also stays `REQUIRES_PAYMENT`, so
the Python run touches no real supply and no money.

### 4. The same order over MCP

Copy the `quote:` line printed above — a quote is priced once and consumed once
— and pass it to the MCP client with the same `clientReference`:

```bash
node examples/mcp-client.mjs http://127.0.0.1:8080 \
  --client-reference my-first-order \
  --quote osmm_quote_...
```

The `order:` line prints the **same `orderId`** as the REST run. That is the one
rule of the protocol: the same `clientReference` produces the same order on any
transport.

Run without `--quote` and the MCP client prices a new quote itself (useful on
its own; it cannot reuse an order that was made from a different quote).

### 5. Connect a node to an MCP client

To use your node from Claude Desktop, Cursor, or any MCP-compatible client, add
one of the following configuration blocks to your client's settings
(e.g., `claude_desktop_config.json` or `.cursor/mcp.json`).

The server configuration aligns with [`../mcp.json`](../mcp.json)
(`io.github.opensmm-protocol/mcp-server`, package `@opensmm/mcp-server`), which
registers the stdio transport.

#### Stdio transport (direct process)

Runs the MCP server locally via `npm run mcp`:

```json
{
  "mcpServers": {
    "opensmm": {
      "command": "npm",
      "args": ["run", "mcp"],
      "cwd": "/path/to/mcp-server"
    }
  }
}
```

#### HTTP transport (running node)

Connects over Streamable HTTP to a running gateway (`npm run gateway` on `:8080`):

```json
{
  "mcpServers": {
    "opensmm": {
      "url": "http://127.0.0.1:8080/mcp"
    }
  }
}
```

### Connect from a specific agent stack

Ready-to-copy examples for four agent stacks — each runs against the same
local node and its mock catalog, with no keys or money:

- [Claude Desktop](claude-desktop/README.md) — stdio via
  [`claude_desktop_config.json`](claude-desktop/claude_desktop_config.json)
  (`npm run mcp`).
- [Cursor](cursor/README.md) — HTTP `POST /mcp` via
  [`.cursor/mcp.json`](cursor/.cursor/mcp.json) (`npm run gateway`).
- [LangChain-style agent](langchain/README.md) — a runnable
  [tool-calling script](langchain/agent.mjs): catalog → quote → order → replay.
- [ElizaOS](eliza/README.md) — a copy-paste
  [plugin](eliza/plugin.mjs) with search / quote / order actions and a
  [smoke test](eliza/smoke.mjs) against a node.
- [n8n](n8n/README.md) — an importable
  [workflow](n8n/workflow.json) with HTTP Request nodes and a mock-only guard.

The short end-to-end walkthrough is
[`docs/AGENT_QUICKSTART.md`](../docs/AGENT_QUICKSTART.md) — order an SMM service
from an agent in 5 minutes, from a clean clone.

### What the scripts talk to

| Script | Path | Calls |
| --- | --- | --- |
| `rest-client.mjs` | REST `/v0` | `GET /v0/services` → `POST /v0/quotes` → `POST /v0/orders` ×2 |
| `rest-client.py` | REST `/v0` | `GET /v0/capabilities` → `GET /v0/services` → `POST /v0/quotes` → `POST /v0/orders` ×2 |
| `mcp-client.mjs` | MCP `/mcp` | `initialize` → `search_services` → `get_quote` → `create_order` ×2 |

The MCP client speaks JSON-RPC directly, so it also shows the wire shape an MCP
SDK hides: one `POST /mcp` per call, `tools/call` with `structuredContent` in the
answer.

## Provider examples

### `provider-profile.example.json`

A `RegisterProviderRequest` for the `rest-v1` dialect — the payload you send to
`POST /v0/providers` on your node. It is the file behind «Copy this profile» in
[`../docs/PROVIDER_ONBOARDING.md`](../docs/PROVIDER_ONBOARDING.md).

Placeholders only:

- `endpoint` — the panel's base URL (its v1 API root). The adapter appends
  `/services`, `/orders` and `/orders/:id`, so give it the same prefix those
  paths hang off, e.g. `https://panel.example/api/v1`.
- `apiKey` — the panel credential, sent as `Authorization: Bearer`. The gateway
  never returns it, never logs it and never publishes it.
- `profile` is not set: profiles describe `smm-v2` panel deviations. A
  `rest-v1` panel needs `endpoint` + `apiKey` and nothing else.

The sample contains no real panel URL and no real key, and `npm test` keeps it
that way: it is validated against
`spec/v0/schemas/register-provider-request.json` and asserted to use a
`.example` host and a placeholder key. Fill a copy **outside** this repository —
the filled file is a secret.

## Not shown here

Paying an order, executing it at a provider, refills and cancels live in
[`../spec/v0/`](../spec/v0/) and [`../docs/`](../docs/). Connecting a real
provider: [`../docs/PROVIDER_ONBOARDING.md`](../docs/PROVIDER_ONBOARDING.md).
