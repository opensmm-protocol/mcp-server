#!/usr/bin/env node
/**
 * OpenSMM MCP server entry (stdio) for the published package. Runs the
 * compiled JavaScript in `dist/` (built by `npm run build`, wired into
 * `prepack`): Node refuses native TypeScript type stripping for files under
 * node_modules, so the shipped entry point must be plain JS.
 * Requires Node.js >= 22.18. Usage in an MCP client config:
 *   { "command": "npx", "args": ["-y", "@opensmm/mcp-server"] }
 */
const { serveStdio } = await import("../dist/adapters/inbound/mcp/server.js");
await serveStdio();
