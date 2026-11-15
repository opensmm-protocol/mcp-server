import assert from "node:assert/strict";
import fs from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { after, describe, it } from "node:test";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import type { OpenSmmCore } from "../src/core/core.ts";
import { createDevStack } from "../src/bootstrap.ts";
import { createMcpHttpHandler } from "../src/adapters/inbound/mcp/http.ts";
import {
  DEFAULT_RATE_LIMIT_PER_MIN,
  PerIpRateLimiter,
  RATE_LIMIT_ENV,
  rateLimitPerMinFromEnv,
} from "../src/adapters/inbound/rate-limit.ts";
import { createRestHandler } from "../src/adapters/inbound/rest/handler.ts";

type Handler = (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => Promise<void>;

async function startNode(build: (core: OpenSmmCore) => Handler): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const { core } = createDevStack();
  const handler = build(core);
  const server: Server = createServer((req, res) => void handler(req, res));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

async function postJson(baseUrl: string, route: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}${route}`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify(body),
  });
}

/** Compile the published error schema: a 429 body must be a canonical error. */
function errorValidator() {
  const schemaPath = path.resolve(import.meta.dirname, "../spec/v0/schemas/error.json");
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  const applyFormats = typeof addFormats === "function" ? addFormats : (addFormats as any).default;
  applyFormats(ajv);
  return ajv.compile(JSON.parse(fs.readFileSync(schemaPath, "utf8")));
}

describe("OPENSMM_RATE_LIMIT_PER_MIN", () => {
  it("defaults to 120 requests per minute when unset", () => {
    assert.equal(rateLimitPerMinFromEnv({}), DEFAULT_RATE_LIMIT_PER_MIN);
    assert.equal(rateLimitPerMinFromEnv({}), 120);
    assert.equal(rateLimitPerMinFromEnv({ [RATE_LIMIT_ENV]: "  " }), 120);
    assert.equal(rateLimitPerMinFromEnv({ [RATE_LIMIT_ENV]: "42" }), 42);
    assert.equal(rateLimitPerMinFromEnv({ [RATE_LIMIT_ENV]: "0" }), 0);
  });

  it("refuses a value that is not a non-negative integer", () => {
    for (const raw of ["abc", "-1", "1.5", "120/min"]) {
      assert.throws(() => rateLimitPerMinFromEnv({ [RATE_LIMIT_ENV]: raw }), /OPENSMM_RATE_LIMIT_PER_MIN/);
    }
  });
});

describe("per-IP sliding window", () => {
  it("counts one window per key and reports the wait until the oldest hit expires", () => {
    let now = 0;
    const limiter = new PerIpRateLimiter({ limitPerMin: 2, now: () => now });
    assert.deepEqual(limiter.check("1.1.1.1"), { allowed: true });
    now = 10_000;
    assert.deepEqual(limiter.check("1.1.1.1"), { allowed: true });
    now = 30_000;
    assert.deepEqual(limiter.check("1.1.1.1"), { allowed: false, retryAfterSeconds: 30 });
    // Another IP has its own window.
    assert.deepEqual(limiter.check("2.2.2.2"), { allowed: true });
    // Sliding: the first hit leaves the window at t=60s, then a slot opens.
    now = 60_001;
    assert.deepEqual(limiter.check("1.1.1.1"), { allowed: true });
  });

  it("allows everything when the limit is 0", () => {
    const limiter = new PerIpRateLimiter({ limitPerMin: 0 });
    assert.equal(limiter.enabled, false);
    for (let i = 0; i < 10; i++) assert.deepEqual(limiter.check("1.1.1.1"), { allowed: true });
  });
});

describe("REST adapter rate limit", () => {
  const validateError = errorValidator();
  const nodes: { close: () => Promise<void> }[] = [];

  after(async () => {
    await Promise.all(nodes.map((n) => n.close()));
  });

  async function restNode(limitPerMin: number) {
    const node = await startNode((core) => createRestHandler(core, { rateLimiter: new PerIpRateLimiter({ limitPerMin }) }));
    nodes.push(node);
    return node;
  }

  it("answers the N+1-th request in the window with 429 and Retry-After", async () => {
    const node = await restNode(2);
    assert.equal((await fetch(`${node.baseUrl}/v0/capabilities`)).status, 200);
    assert.equal((await fetch(`${node.baseUrl}/v0/services`)).status, 200);

    const limited = await fetch(`${node.baseUrl}/v0/capabilities`);
    assert.equal(limited.status, 429);
    const retryAfter = Number(limited.headers.get("retry-after"));
    assert.ok(Number.isInteger(retryAfter) && retryAfter >= 1, `retry-after must be seconds, got ${retryAfter}`);
    assert.equal(limited.headers.get("access-control-allow-origin"), "*");

    const body = await limited.json();
    assert.equal(body.error.code, "RATE_LIMITED");
    assert.equal(body.error.details.retryAfterSeconds, retryAfter);
    assert.ok(validateError(body), JSON.stringify(validateError.errors));
  });

  it("keeps /health at 200 when the window is exhausted", async () => {
    const node = await restNode(1);
    assert.equal((await fetch(`${node.baseUrl}/v0/capabilities`)).status, 200);
    assert.equal((await fetch(`${node.baseUrl}/v0/capabilities`)).status, 429);

    for (const route of ["/health", "/v0/health"]) {
      const res = await fetch(`${node.baseUrl}${route}`);
      assert.equal(res.status, 200, `${route} must stay outside the limit`);
      assert.equal((await res.json()).status, "ok");
    }
    // The probes above did not consume the window either.
    assert.equal((await fetch(`${node.baseUrl}/v0/capabilities`)).status, 429);
  });

  it("does not count the CORS preflight", async () => {
    const node = await restNode(1);
    assert.equal((await fetch(`${node.baseUrl}/v0/capabilities`)).status, 200);
    const preflight = await fetch(`${node.baseUrl}/v0/orders`, { method: "OPTIONS" });
    assert.equal(preflight.status, 204);
    assert.equal((await fetch(`${node.baseUrl}/v0/capabilities`)).status, 429);
  });

  it("takes the limit from OPENSMM_RATE_LIMIT_PER_MIN", async () => {
    const previous = process.env[RATE_LIMIT_ENV];
    process.env[RATE_LIMIT_ENV] = "2";
    try {
      const node = await startNode((core) => createRestHandler(core));
      nodes.push(node);
      assert.equal((await fetch(`${node.baseUrl}/v0/capabilities`)).status, 200);
      assert.equal((await fetch(`${node.baseUrl}/v0/capabilities`)).status, 200);
      assert.equal((await fetch(`${node.baseUrl}/v0/capabilities`)).status, 429);
    } finally {
      if (previous === undefined) delete process.env[RATE_LIMIT_ENV];
      else process.env[RATE_LIMIT_ENV] = previous;
    }
  });

  it("disables the limit with OPENSMM_RATE_LIMIT_PER_MIN=0", async () => {
    const previous = process.env[RATE_LIMIT_ENV];
    process.env[RATE_LIMIT_ENV] = "0";
    try {
      const node = await startNode((core) => createRestHandler(core));
      nodes.push(node);
      for (let i = 0; i < 5; i++) {
        assert.equal((await fetch(`${node.baseUrl}/v0/capabilities`)).status, 200);
      }
    } finally {
      if (previous === undefined) delete process.env[RATE_LIMIT_ENV];
      else process.env[RATE_LIMIT_ENV] = previous;
    }
  });
});

describe("MCP over HTTP rate limit", () => {
  it("answers an over-limit JSON-RPC POST with 429 and Retry-After", async () => {
    const node = await startNode((core) =>
      createMcpHttpHandler(core, { rateLimiter: new PerIpRateLimiter({ limitPerMin: 1 }) }),
    );
    try {
      const first = await postJson(node.baseUrl, "/mcp", { jsonrpc: "2.0", id: 1, method: "initialize" });
      assert.notEqual(first.status, 429);

      const limited = await postJson(node.baseUrl, "/mcp", { jsonrpc: "2.0", id: 2, method: "initialize" });
      assert.equal(limited.status, 429);
      assert.ok(Number(limited.headers.get("retry-after")) >= 1);
      assert.equal(limited.headers.get("access-control-allow-origin"), "*");
      assert.equal((await limited.json()).error.code, "RATE_LIMITED");
    } finally {
      await node.close();
    }
  });
});

describe("gateway rate limit", () => {
  it("shares one window between REST /v0 and MCP /mcp", async () => {
    // Same wiring as serveGateway: one limiter instance for both bindings.
    const node = await startNode((core) => {
      const limiter = new PerIpRateLimiter({ limitPerMin: 2 });
      const rest = createRestHandler(core, { rateLimiter: limiter });
      const mcp = createMcpHttpHandler(core, { rateLimiter: limiter });
      return (req, res) =>
        req.url === "/mcp" || req.url?.startsWith("/mcp/") ? mcp(req, res) : rest(req, res);
    });
    try {
      assert.equal((await fetch(`${node.baseUrl}/v0/capabilities`)).status, 200);
      assert.notEqual((await postJson(node.baseUrl, "/mcp", { jsonrpc: "2.0", id: 1, method: "initialize" })).status, 429);

      // Third request in the window, whatever the transport, is over the limit.
      assert.equal((await fetch(`${node.baseUrl}/v0/capabilities`)).status, 429);
      assert.equal((await fetch(`${node.baseUrl}/health`)).status, 200);
    } finally {
      await node.close();
    }
  });
});
