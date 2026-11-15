import assert from "node:assert/strict";
import fs from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { Ajv2020 } from "ajv/dist/2020.js";
import { createDevStack } from "../src/bootstrap.ts";
import { maxBodyBytesFromEnv } from "../src/adapters/inbound/body.ts";
import { createMcpHttpHandler } from "../src/adapters/inbound/mcp/http.ts";
import { createRestHandler } from "../src/adapters/inbound/rest/handler.ts";

const SVC = "osmm_svc_tg_members_std";
const LINK = "https://t.me/body_limit_example";

// The 413 body must stay a canonical spec/v0 error, like every other failure.
const errorSchema = JSON.parse(
  fs.readFileSync(path.resolve(import.meta.dirname, "../spec/v0/schemas/error.json"), "utf8"),
);
const validateError = new Ajv2020({ allErrors: true }).compile(errorSchema);

const MCP_INITIALIZE = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "body-limit-test", version: "0.0.1" },
  },
};

interface Node {
  baseUrl: string;
  close: () => Promise<void>;
}

/** One process serving both bindings, like the gateway (REST /v0, MCP /mcp). */
async function startNode(): Promise<Node> {
  const { core } = createDevStack();
  const rest = createRestHandler(core);
  const mcp = createMcpHttpHandler(core);
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const handler = url.pathname.startsWith("/mcp") ? mcp : rest;
    void handler(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

async function rest(baseUrl: string, route: string, init?: RequestInit) {
  const res = await fetch(`${baseUrl}${route}`, init);
  return { status: res.status, body: (await res.json()) as unknown };
}

/** Asserts the body is a canonical spec/v0 error; narrows it for the caller. */
function assertCanonicalError(
  body: unknown,
): asserts body is { error: { code: string; message: string; details?: Record<string, unknown> } } {
  assert.ok(validateError(body), JSON.stringify(validateError.errors));
}

async function mcpPost(baseUrl: string, payload: unknown) {
  const res = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: typeof payload === "string" ? payload : JSON.stringify(payload),
  });
  return { status: res.status, text: await res.text() };
}

describe("OPENSMM_MAX_BODY_BYTES caps every POST (ZHC-766)", () => {
  let node: Node;

  before(async () => {
    process.env.OPENSMM_MAX_BODY_BYTES = "2048";
    node = await startNode();
  });

  after(async () => {
    delete process.env.OPENSMM_MAX_BODY_BYTES;
    await node.close();
  });

  it("REST answers 413 in the canonical error shape and keeps serving /health", async () => {
    const oversized = JSON.stringify({
      serviceId: SVC,
      quantity: 100,
      link: LINK,
      parameters: { pad: "x".repeat(4096) },
    });
    assert.ok(oversized.length > 2048);

    const res = await rest(node.baseUrl, "/v0/quotes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: oversized,
    });
    assert.equal(res.status, 413);
    assertCanonicalError(res.body);
    assert.equal(res.body.error.code, "PAYLOAD_TOO_LARGE");
    assert.equal(res.body.error.details?.maxBodyBytes, 2048);

    const health = await rest(node.baseUrl, "/health");
    assert.equal(health.status, 200);
    assert.equal((health.body as { status: string }).status, "ok");
  });

  it("MCP answers 413 in the canonical error shape and keeps serving", async () => {
    const oversized = JSON.stringify({ ...MCP_INITIALIZE, params: { pad: "x".repeat(4096) } });

    const res = await mcpPost(node.baseUrl, oversized);
    assert.equal(res.status, 413);
    const body = JSON.parse(res.text);
    assertCanonicalError(body);
    assert.equal(body.error.details?.maxBodyBytes, 2048);

    const health = await rest(node.baseUrl, "/health");
    assert.equal(health.status, 200);
  });

  it("REST accepts a body within the limit exactly as before", async () => {
    const quote = await rest(node.baseUrl, "/v0/quotes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ serviceId: SVC, quantity: 100, link: LINK }),
    });
    assert.equal(quote.status, 201);
    assert.match((quote.body as { quoteId: string }).quoteId, /^osmm_quote_/);
  });

  it("MCP accepts a body within the limit", async () => {
    const res = await mcpPost(node.baseUrl, MCP_INITIALIZE);
    assert.equal(res.status, 200);
    assert.match(res.text, /"protocolVersion"/);
  });

  it("cuts a chunked body off at the cap, without a Content-Length to check", async () => {
    const chunk = new TextEncoder().encode("x".repeat(1024));
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent >= 8) {
          controller.close();
          return;
        }
        sent++;
        controller.enqueue(chunk);
      },
    });
    const res = await fetch(`${node.baseUrl}/v0/quotes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: stream,
      // @ts-expect-error duplex is required by fetch for a streaming body
      duplex: "half",
    }).catch((err: Error) => assert.fail(`node must answer, not reset: ${err.message}`));
    assert.equal(res.status, 413);
    const body: unknown = await res.json();
    assertCanonicalError(body);
  });
});

describe("default body cap is 1 MiB", () => {
  let node: Node;

  before(async () => {
    delete process.env.OPENSMM_MAX_BODY_BYTES;
    node = await startNode();
  });

  after(async () => {
    await node.close();
  });

  it("accepts a large body under 1 MiB", async () => {
    const quote = await rest(node.baseUrl, "/v0/quotes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        serviceId: SVC,
        quantity: 100,
        link: LINK,
        parameters: { pad: "x".repeat(256 * 1024) },
      }),
    });
    assert.equal(quote.status, 201);
  });

  it("rejects a body past 1 MiB with 413", async () => {
    const res = await rest(node.baseUrl, "/v0/quotes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pad: "x".repeat(1024 * 1024 + 1) }),
    });
    assert.equal(res.status, 413);
    assertCanonicalError(res.body);
    assert.equal(res.body.error.details?.maxBodyBytes, 1024 * 1024);
  });
});

describe("maxBodyBytesFromEnv", () => {
  it("fails the boot on a malformed value instead of guessing a limit", () => {
    for (const value of ["0", "-1", "1.5", "lots"]) {
      process.env.OPENSMM_MAX_BODY_BYTES = value;
      assert.throws(() => maxBodyBytesFromEnv(), /OPENSMM_MAX_BODY_BYTES must be a positive integer/);
    }
    delete process.env.OPENSMM_MAX_BODY_BYTES;
    assert.equal(maxBodyBytesFromEnv(), 1024 * 1024);
  });
});
