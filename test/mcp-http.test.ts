import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createDevStack } from "../src/bootstrap.ts";
import { createMcpHttpHandler } from "../src/adapters/inbound/mcp/http.ts";

describe("MCP over Streamable HTTP (remote binding)", () => {
  let server: Server;
  let baseUrl: string;
  let client: Client;

  before(async () => {
    const { core } = createDevStack();
    server = createServer((req, res) => void createMcpHttpHandler(core)(req, res));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;

    client = new Client({ name: "remote-test", version: "0.0.1" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`)));
  });

  after(async () => {
    await client.close();
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  });

  it("exposes the same 10 tools as stdio", async () => {
    const { tools } = await client.listTools();
    assert.equal(tools.length, 10);
    assert.ok(tools.some((t) => t.name === "register_provider"));
  });

  it("calls tools over HTTP and returns structured content", async () => {
    const result = await client.callTool({ name: "get_capabilities", arguments: {} });
    const caps = result.structuredContent as { protocolVersion: string; commands: string[] };
    assert.equal(caps.protocolVersion, "0.1.0");
    assert.equal(caps.commands.length, 10);
  });

  it("answers CORS preflight for browser agents", async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "OPTIONS",
      headers: { origin: "https://opensmm.dev", "access-control-request-headers": "content-type" },
    });
    assert.equal(res.status, 204);
    assert.equal(res.headers.get("access-control-allow-origin"), "*");
    assert.match(res.headers.get("access-control-allow-headers") ?? "", /content-type/);
  });

  it("rejects GET on the stateless endpoint", async () => {
    const res = await fetch(`${baseUrl}/mcp`, { method: "GET" });
    assert.equal(res.status, 405);
  });

  it("404s other paths", async () => {
    const res = await fetch(`${baseUrl}/nope`, { method: "POST" });
    assert.equal(res.status, 404);
  });
});
