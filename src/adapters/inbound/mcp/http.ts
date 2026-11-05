/**
 * OpenSMM MCP over Streamable HTTP — the remote binding for hosted gateways
 * (e.g. https://mcp.opensmm.dev/mcp). Stateless: no session ids; every POST
 * gets a fresh transport over the same core. CORS is open so browser-based
 * agents and MCP playgrounds can connect.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { OpenSmmCore } from "../../../core/core.ts";
import { createMcpServer } from "./server.ts";

const MCP_CORS_HEADERS = "content-type, mcp-protocol-version, mcp-session-id";

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return undefined;
  return JSON.parse(raw);
}

export function createMcpHttpHandler(
  core: OpenSmmCore,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    res.setHeader("access-control-allow-origin", "*");
    res.setHeader("access-control-allow-methods", "POST, OPTIONS");
    res.setHeader("access-control-allow-headers", MCP_CORS_HEADERS);
    res.setHeader("access-control-expose-headers", "mcp-session-id");

    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }
    if (path !== "/mcp") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { code: "NOT_FOUND", message: "MCP endpoint is /mcp" } }));
      return;
    }
    // Stateless mode: POST only. GET (SSE stream) and DELETE (session close)
    // are session features; this gateway keeps no sessions.
    if (req.method !== "POST") {
      res.writeHead(405, { "content-type": "application/json", allow: "POST" });
      res.end(JSON.stringify({ error: { code: "VALIDATION_FAILED", message: "use POST for JSON-RPC" } }));
      return;
    }

    let body: unknown;
    try {
      body = await readBody(req);
    } catch {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { code: "VALIDATION_FAILED", message: "request body is not valid JSON" } }));
      return;
    }

    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    const server = createMcpServer(core);
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  };
}

/** Start the remote MCP server. Entry: `npm run mcp:http`. */
export async function serveHttp(): Promise<Server> {
  const { createStackFromEnv } = await import("../../../bootstrap.ts");
  const { core, provider } = await createStackFromEnv();
  const port = Number(process.env.MCP_HTTP_PORT ?? 3200);
  const server = createServer((req, res) => {
    void createMcpHttpHandler(core)(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(port, resolve));
  console.error(`OpenSMM 0.1.0 MCP over HTTP listening on http://localhost:${port}/mcp (provider: ${provider.providerId})`);
  return server;
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"));
if (isMain) {
  await serveHttp();
}
