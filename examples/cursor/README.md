# Cursor: connect a node over HTTP

`.cursor/mcp.json` points Cursor at a running gateway's Streamable HTTP
endpoint. The endpoint is `POST /mcp` on `npm run gateway`; no port forwarding
and no credentials are needed.

## Setup

1. Install Node.js ≥ 22.18 and a Cursor build with MCP support (the
   `mcpServers` config shape with a `url` field, MCP protocol `2025-06-18`).
2. Clone, install and start the node:

   ```bash
   git clone https://github.com/opensmm-protocol/mcp-server.git
   cd mcp-server
   npm ci
   npm run gateway
   ```

   The node reports `listening on http://localhost:8080` on stderr.

3. Copy [`.cursor/mcp.json`](./.cursor/mcp.json) into your project's
   `.cursor/mcp.json` (or merge its `mcpServers.opensmm` entry into your global
   Cursor MCP config). The URL must end in `/mcp`.
4. Reload Cursor and confirm the `opensmm` tools are listed (`search_services`,
   `get_quote`, `create_order`).

## What to ask the agent

> Using the `opensmm` tools, call `search_services` and confirm every service
> is `synthetic`. Then call `get_quote` for the first service with quantity
> 100 and link `https://t.me/opensmm_example`, call `create_order` with that
> quote and clientReference `cursor-demo-1`, then call `create_order` again
> with the same quote and reference. Report both order IDs.

Expected result:

- `search_services` → the mock catalog, every service `synthetic: true`;
- `get_quote` → `osmm_quote_...`, quantity 100;
- first `create_order` → `osmm_order_...`, `paymentStatus: REQUIRES_PAYMENT`;
- second `create_order` → **the same** `orderId` — one `clientReference`, one
  order, even though each call is a separate `POST /mcp`.

If a service is not marked `synthetic`, stop: this demo must not order real
supply. The order is never paid, so nothing executes.

Next: [the 5-minute guide](../../docs/AGENT_QUICKSTART.md) ·
[all examples](../README.md).
