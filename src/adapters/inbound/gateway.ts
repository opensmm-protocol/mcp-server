/**
 * Combined gateway entry: one process, one core, one state file —
 * MCP over Streamable HTTP on /mcp, REST /v0 on everything else.
 * This is the deployment shape for a hosted gateway (docs/DEPLOY.md).
 *
 * Run: `npm run gateway` (PORT env, default 8080).
 */

import { createServer, type Server } from "node:http";
import { createStackFromEnv } from "../../bootstrap.ts";
import { createMcpHttpHandler } from "./mcp/http.ts";
import { createRestHandler } from "./rest/handler.ts";

export async function serveGateway(): Promise<Server> {
  const { core, provider } = await createStackFromEnv();
  const port = Number(process.env.PORT ?? 8080);
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

  await new Promise<void>((resolve) => server.listen(port, resolve));
  console.error(
    `OpenSMM 0.1.0 gateway listening on http://localhost:${port} ` +
      `(REST /v0, MCP /mcp; provider: ${provider.providerId})`,
  );
  return server;
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"));
if (isMain) {
  await serveGateway();
}
