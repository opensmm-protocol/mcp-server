# Examples

Runnable clients and copyable reference files for OpenSMM.

## Client examples

Two runnable clients for a running OpenSMM node: catalog, quote, order and an
idempotent replay of the same order — once over REST, once over MCP. No
dependencies, no MCP SDK, no API keys, no money: Node.js ≥ 22.18 and `fetch`.

Both work on the node's **mock catalog**. Every service there is marked
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

### 3. The same order over MCP

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

### 4. Connect a node to an MCP client (Подключить узел к MCP-клиенту)

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

### What the scripts talk to

| Script | Path | Calls |
| --- | --- | --- |
| `rest-client.mjs` | REST `/v0` | `GET /v0/services` → `POST /v0/quotes` → `POST /v0/orders` ×2 |
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
