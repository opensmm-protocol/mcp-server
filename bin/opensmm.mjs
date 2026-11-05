#!/usr/bin/env node
/**
 * OpenSMM MCP server entry (stdio). Requires Node.js >= 22.6 (native
 * TypeScript type stripping). Usage in an MCP client config:
 *   { "command": "npx", "args": ["-y", "@opensmm/mcp-server"] }
 */
const { serveStdio } = await import('../src/adapters/inbound/mcp/server.ts');
await serveStdio();
