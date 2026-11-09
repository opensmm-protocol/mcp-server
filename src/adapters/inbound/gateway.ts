/**
 * Combined gateway entry: one process, one core, one state file —
 * MCP over Streamable HTTP on /mcp, REST /v0 on everything else.
 * This is the deployment shape for a hosted gateway (docs/DEPLOY.md).
 *
 * Run: `npm run gateway` (PORT env, default 8080) or
 * `npx -y @opensmm/mcp-server gateway --port 8080`
 * (CLI flags, see bin/opensmm.mjs).
 */

import { createServer, type Server } from "node:http";
import { createStackFromEnv } from "../../bootstrap.ts";
import { createMcpHttpHandler } from "./mcp/http.ts";
import { createRestHandler } from "./rest/handler.ts";

export interface GatewayOptions {
  /** Listen port; overrides PORT. 0 picks a free port (tests). */
  port?: number;
  /** State snapshot path; overrides OPENSMM_STATE_FILE. */
  stateFile?: string;
}

export async function serveGateway(options: GatewayOptions = {}): Promise<Server> {
  if (options.stateFile) process.env.OPENSMM_STATE_FILE = options.stateFile;
  const { core, provider } = await createStackFromEnv();
  const requestedPort = options.port ?? Number(process.env.PORT ?? 8080);
  const rest = createRestHandler(core);
  const mcp = createMcpHttpHandler(core);

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const handler = url.pathname === "/mcp" || url.pathname.startsWith("/mcp/") ? mcp : rest;
    void handler(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });

  await new Promise<void>((resolve) => server.listen(requestedPort, resolve));
  // The stderr line is the contract the CLI smoke tests read the port from:
  // with --port 0 the OS picks the port, so report the bound one, not the ask.
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : requestedPort;
  console.error(
    `OpenSMM 0.1.0 gateway listening on http://localhost:${port} ` +
      `(REST /v0, MCP /mcp; provider: ${provider.providerId}` +
      `${provider.synthetic ? ", mock catalog — not real supply" : ""})`,
  );
  return server;
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"));
if (isMain) {
  await serveGateway();
}
