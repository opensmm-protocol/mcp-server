# Claude Desktop: connect a node over stdio

`claude_desktop_config.json` launches the MCP server as a local child process
with `npm run mcp`. No port, no keys, no credentials: the tools talk to the
node's mock catalog, and orders stay `REQUIRES_PAYMENT`.

## Setup

1. Install Node.js ≥ 22.18 and a Claude Desktop build with MCP support (the
   `mcpServers` config shape, MCP protocol `2025-06-18`).
2. Clone and install the node:

   ```bash
   git clone https://github.com/opensmm-protocol/mcp-server.git
   cd mcp-server
   npm ci
   ```

3. Copy [`claude_desktop_config.json`](./claude_desktop_config.json) into your
   Claude Desktop config:

   - macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
   - Windows: `%APPDATA%\Claude\claude_desktop_config.json`

4. Replace `"cwd": "/path/to/mcp-server"` with the absolute path of your
   checkout, then fully restart Claude Desktop. The `mcp` script must exist in
   that checkout's `package.json` (it does by default).

The config starts `npm run mcp` and speaks MCP over stdio — the same server
that `mcp.json` in the repo root registers.

## What to ask the agent

> Using the `opensmm` tools, call `search_services` and confirm every service
> is `synthetic`. Then call `get_quote` for the first service with quantity
> 100 and link `https://t.me/opensmm_example`, call `create_order` with that
> quote and clientReference `claude-demo-1`, then call `create_order` again
> with the same quote and reference. Report both order IDs.

Expected result:

- `search_services` → a catalog whose services all carry `synthetic: true`
  (the mock catalog, not real supply);
- `get_quote` → `osmm_quote_...`, amount in USDC, quantity 100;
- first `create_order` → `osmm_order_...`, `paymentStatus: REQUIRES_PAYMENT`;
- second `create_order` → **the same** `orderId`, no second order created.

If a service is not marked `synthetic`, stop: this demo must not order real
supply. Nothing is paid, so no provider executes anything.

Next: [the 5-minute guide](../../docs/AGENT_QUICKSTART.md) ·
[all examples](../README.md).
