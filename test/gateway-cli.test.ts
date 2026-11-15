/**
 * One-command node smoke tests (ZHC-300): the `gateway` subcommand of
 * bin/opensmm.mjs, end to end — spawn the CLI, speak HTTP to it, and check
 * the catalog, the MCP binding, idempotency and the state snapshot.
 *
 * The process is the unit under test: no core internals are imported here.
 */

import assert from "node:assert/strict";
import { spawnSync, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const BIN = path.join(REPO_ROOT, "bin", "opensmm.mjs");

/** A node must not inherit provider/payment config from the developer shell. */
const CLEAN_ENV = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) => !/^(OPENSMM_|X402_|PORT$|MCP_HTTP_PORT$)/.test(key),
  ),
);

interface RunningNode {
  child: ChildProcess;
  port: number;
  baseUrl: string;
}

function runCli(args: string[]): { status: number | null; stdout: string; stderr: string } {
  return spawnSync(process.execPath, [BIN, ...args], {
    cwd: REPO_ROOT,
    env: CLEAN_ENV,
    encoding: "utf8",
    timeout: 30_000,
  });
}

async function startNode(extraArgs: string[] = []): Promise<RunningNode> {
  const child = spawn(process.execPath, [BIN, "gateway", "--port", "0", ...extraArgs], {
    cwd: REPO_ROOT,
    env: CLEAN_ENV,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`gateway did not report a port in 20s; stderr:\n${stderr}`)),
      20_000,
    );
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
      const match = /listening on http:\/\/localhost:(\d+)/.exec(stderr);
      if (match) {
        clearTimeout(timer);
        resolve(Number(match[1]));
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`gateway exited early (code ${code}); stderr:\n${stderr}`));
    });
  });
  return { child, port, baseUrl: `http://127.0.0.1:${port}` };
}

async function stopNode(node: RunningNode): Promise<void> {
  const child = node.child;
  if (child.exitCode !== null) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, 10_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill("SIGTERM");
  });
}

async function getJson(baseUrl: string, route: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}${route}`);
  return { status: res.status, body: await res.json() };
}

/** Raw TCP client: the tests below need control over request framing. */
function connectSocket(port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1");
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Poll a predicate until it holds; used for data that arrives on a socket. */
function waitUntil(check: () => boolean, what: string, timeoutMs = 5_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const timer = setInterval(() => {
      if (check()) {
        clearInterval(timer);
        resolve();
        return;
      }
      if (Date.now() - startedAt > timeoutMs) {
        clearInterval(timer);
        reject(new Error(`timed out after ${timeoutMs}ms waiting for ${what}`));
      }
    }, 10);
  });
}

async function postJson(
  baseUrl: string,
  route: string,
  body: unknown,
): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}${route}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

/** Minimal JSON-RPC over the stateless Streamable HTTP endpoint. */
async function rpc(node: RunningNode, body: unknown): Promise<any> {
  const res = await fetch(`${node.baseUrl}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify(body),
  });
  assert.equal(res.status, 200, `POST /mcp must answer 200, got ${res.status}`);
  const text = await res.text();
  const dataLine = text.split("\n").find((line) => line.startsWith("data: "));
  assert.ok(dataLine, `MCP response carries no SSE data line: ${text}`);
  return JSON.parse(dataLine.slice("data: ".length));
}

function rpcRequest(id: number, method: string, params: unknown = {}): unknown {
  return { jsonrpc: "2.0", id, method, params };
}

async function callTool(node: RunningNode, name: string, args: unknown): Promise<any> {
  const response = await rpc(node, rpcRequest(9, "tools/call", { name, arguments: args }));
  assert.ok(response.result, `tools/call ${name} returned an error: ${JSON.stringify(response)}`);
  return response.result.structuredContent;
}

describe("bin/opensmm.mjs gateway — a node in one command", () => {
  let node: RunningNode;
  let services: any[];
  let quoteId: string;

  before(async () => {
    node = await startNode();
    const catalog = await getJson(node.baseUrl, "/v0/services");
    services = catalog.body.services;
    const quote = await postJson(node.baseUrl, "/v0/quotes", {
      serviceId: services[0].serviceId,
      quantity: 100,
      link: "https://t.me/opensmm_smoke",
    });
    quoteId = quote.body.quoteId;
  });

  after(async () => {
    await stopNode(node);
  });

  it("prints help for `gateway --help` and `-h` and exits 0 with all .env.example variables", () => {
    const envExamplePath = path.join(REPO_ROOT, ".env.example");
    const envContent = fs.readFileSync(envExamplePath, "utf8");
    const envVars = Array.from(envContent.matchAll(/^#?([A-Z][A-Z0-9_]+)=/gm), (m) => m[1]);
    assert.ok(envVars.length > 0, "must find variables in .env.example");

    for (const flag of ["--help", "-h"]) {
      const result = runCli(["gateway", flag]);
      assert.equal(result.status, 0);
      assert.match(result.stdout, /--port/);
      assert.match(result.stdout, /--state/);
      assert.match(result.stdout, /gateway/);
      assert.match(result.stdout, /\/data\/opensmm-state\.json/);

      for (const envVar of envVars) {
        assert.ok(
          result.stdout.includes(envVar),
          `gateway ${flag} output must document ${envVar} from .env.example`,
        );
      }
    }
  });

  it("prints help for direct `gateway.ts --help` and `-h` without starting the server", () => {
    const gatewayScript = path.join(REPO_ROOT, "src", "adapters", "inbound", "gateway.ts");
    const envExamplePath = path.join(REPO_ROOT, ".env.example");
    const envContent = fs.readFileSync(envExamplePath, "utf8");
    const envVars = Array.from(envContent.matchAll(/^#?([A-Z][A-Z0-9_]+)=/gm), (m) => m[1]);
    assert.ok(envVars.length > 0, "must find variables in .env.example");

    for (const flag of ["--help", "-h"]) {
      const result = spawnSync(process.execPath, [gatewayScript, flag], {
        cwd: REPO_ROOT,
        env: CLEAN_ENV,
        encoding: "utf8",
        timeout: 10_000,
      });
      assert.equal(result.status, 0);
      assert.match(result.stdout, /--port/);
      assert.match(result.stdout, /--state/);
      assert.match(result.stdout, /\/data\/opensmm-state\.json/);

      for (const envVar of envVars) {
        assert.ok(
          result.stdout.includes(envVar),
          `gateway.ts ${flag} output must document ${envVar} from .env.example`,
        );
      }
    }
  });

  it("rejects an unknown subcommand with usage and a non-zero exit", () => {
    const result = runCli(["deploy"]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /unknown command: deploy/);
    assert.match(result.stderr, /Usage: opensmm/);
  });

  it("rejects a bad --port value", () => {
    const result = runCli(["gateway", "--port", "eighty"]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /invalid --port: eighty/);
  });

  it("keeps the plain stdio server as the default command", async () => {
    const child = spawn(process.execPath, [BIN], {
      cwd: REPO_ROOT,
      env: CLEAN_ENV,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: string[] = [];
    const response = new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no MCP response on stdio in 20s")), 20_000);
      child.stdout?.on("data", (chunk: Buffer) => {
        for (const line of chunk.toString().split("\n")) {
          if (!line.trim()) continue;
          stdout.push(line);
          try {
            const parsed = JSON.parse(line);
            if (parsed.id === 1) {
              clearTimeout(timer);
              resolve(parsed);
            }
          } catch {
            // not a complete JSON line yet
          }
        }
      });
    });
    child.stdin?.write(
      `${JSON.stringify(
        rpcRequest(1, "initialize", {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "stdio-smoke", version: "0" },
        }),
      )}\n`,
    );
    const answer = await response;
    assert.equal(answer.result.serverInfo.name, "opensmm");
    assert.ok(answer.result.capabilities.tools, "stdio server advertises tools");
    child.stdin?.end();
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, 10_000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  });

  it("serves the mock catalog, explicitly marked synthetic", async () => {
    const response = await getJson(node.baseUrl, "/v0/services");
    assert.equal(response.status, 200);
    assert.ok(response.body.services.length > 0, "catalog is not empty");
    for (const service of response.body.services) {
      assert.equal(service.synthetic, true, `${service.serviceId} must be marked mock`);
      assert.match(service.providerRef, /^provider-/);
    }
  });

  it("keeps /v0/services valid against the spec schema", () => {
    const schemasDir = path.join(REPO_ROOT, "spec", "v0", "schemas");
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    const applyFormats =
      typeof addFormats === "function" ? addFormats : (addFormats as any).default;
    applyFormats(ajv);
    for (const file of fs.readdirSync(schemasDir).filter((f) => f.endsWith(".json"))) {
      const schema = JSON.parse(fs.readFileSync(path.join(schemasDir, file), "utf8"));
      ajv.addSchema(schema, schema.$id);
    }
    const validate = ajv.getSchema("https://opensmm.dev/spec/v0/schemas/service.json");
    assert.ok(validate);
    for (const service of services) {
      assert.ok(validate(service), `service failed schema: ${JSON.stringify(validate.errors)}`);
    }
  });

  it("lists the catalog providers with offers count and metrics", async () => {
    const response = await getJson(node.baseUrl, "/v0/providers");
    assert.equal(response.status, 200);
    assert.equal(response.body.providers.length, 1);
    const [provider] = response.body.providers;
    assert.equal(provider.providerKey, services[0].providerRef);
    assert.equal(provider.synthetic, true);
    assert.equal(provider.offersCount, services.length);
    assert.equal(provider.metrics.sampleSize, 0);
  });

  it("answers MCP initialize with 200 over POST /mcp", async () => {
    const response = await rpc(
      node,
      rpcRequest(1, "initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "http-smoke", version: "0" },
      }),
    );
    assert.equal(response.result.serverInfo.name, "opensmm");
    const capabilities = await callTool(node, "get_capabilities", {});
    assert.equal(capabilities.protocolVersion, "0.1.0");
  });

  it("exposes the 11 tools over tools/list", async () => {
    const response = await rpc(node, rpcRequest(2, "tools/list"));
    const names = response.result.tools.map((tool: { name: string }) => tool.name);
    assert.equal(names.length, 11, `unexpected tool set: ${names.join(", ")}`);
    assert.ok(names.includes("create_order"));
    assert.ok(names.includes("register_provider"));
  });

  it("returns the same orderId for a repeated clientReference over MCP", async () => {
    const order = {
      quoteId,
      link: "https://t.me/opensmm_smoke",
      clientReference: "smoke-mcp-idempotency",
    };
    const first = await callTool(node, "create_order", order);
    const second = await callTool(node, "create_order", order);
    assert.equal(first.orderId, second.orderId);
    assert.deepEqual(first, second);
  });

  it("creates one domain object for the same order over REST and MCP", async () => {
    const quote = await postJson(node.baseUrl, "/v0/quotes", {
      serviceId: services[0].serviceId,
      quantity: 100,
      link: "https://t.me/opensmm_parity",
    });
    const body = {
      quoteId: quote.body.quoteId,
      link: "https://t.me/opensmm_parity",
      clientReference: "smoke-transport-parity",
    };
    const viaRest = await postJson(node.baseUrl, "/v0/orders", body);
    assert.equal(viaRest.status, 402, "an unpaid order answers 402 with the order body");
    const viaMcp = await callTool(node, "create_order", body);
    assert.equal(viaMcp.orderId, viaRest.body.orderId);
    assert.deepEqual(viaMcp, viaRest.body);
  });
});

describe("bin/opensmm.mjs doctor — panel check in one command", () => {
  it("prints the doctor usage for `doctor --help` and exits 0", () => {
    const result = runCli(["doctor", "--help"]);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /--url/);
    assert.match(result.stdout, /--key/);
    assert.match(result.stdout, /--profile/);
  });

  it("rejects an unknown doctor option with a non-zero exit and no key leak", () => {
    const result = runCli([
      "doctor",
      "--url",
      "https://panel.example/api/v2",
      "--key",
      "doctor-secret-key",
      "--nope",
    ]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Unknown option/);
    assert.equal(result.stderr.includes("doctor-secret-key"), false);
  });

  it("keeps the key out of `npm run doctor` output when it comes from the environment", () => {
    const envKey = "SUPERSECRET-abc123";
    const result = spawnSync(
      "npm",
      ["run", "doctor", "--", "--url", "http://127.0.0.1:1/api/v2"],
      {
        cwd: REPO_ROOT,
        env: { ...CLEAN_ENV, OPENSMM_PANEL_KEY: envKey },
        encoding: "utf8",
        timeout: 60_000,
      },
    );

    assert.equal(result.status, 1, "an unreachable panel still exits 1");
    const output = `${result.stdout}${result.stderr}`;
    assert.match(output, /src\/cli\/provider-doctor\.ts/, "npm echoes the command it runs");
    assert.equal(
      output.includes(envKey),
      false,
      "the key must not appear in stdout, stderr or the npm command echo",
    );
    assert.equal(output.includes("env-file"), false);
    assert.equal(output.includes(".env not found"), false);
  });

  it("documents the environment form of the doctor in `--help` and exits 0", () => {
    const result = runCli(["doctor", "--help"]);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /OPENSMM_PANEL_KEY/);
    assert.match(result.stdout, /OPENSMM_PANEL_URL/);
  });
});

describe("bin/opensmm.mjs gateway --state", () => {
  it("writes a snapshot and returns order after restart", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opensmm-state-"));
    const statePath = path.join(dir, "opensmm-state.json");
    const first = await startNode(["--state", statePath]);
    let orderId: string;
    try {
      const catalog = await getJson(first.baseUrl, "/v0/services");
      const quote = await postJson(first.baseUrl, "/v0/quotes", {
        serviceId: catalog.body.services[0].serviceId,
        quantity: 100,
        link: "https://t.me/opensmm_state",
      });
      const order = await postJson(first.baseUrl, "/v0/orders", {
        quoteId: quote.body.quoteId,
        link: "https://t.me/opensmm_state",
        clientReference: "smoke-state-restart",
      });
      orderId = order.body.orderId;
    } finally {
      await stopNode(first);
    }
    assert.ok(fs.existsSync(statePath), "the snapshot is written on SIGTERM");

    const second = await startNode(["--state", statePath]);
    try {
      const restored = await getJson(second.baseUrl, `/v0/orders/${orderId}`);
      assert.equal(restored.status, 200);
      assert.equal(restored.body.orderId, orderId);
      assert.equal(restored.body.clientReference, "smoke-state-restart");
    } finally {
      await stopNode(second);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("bin/opensmm.mjs gateway — graceful shutdown", () => {
  it("drains an in-flight request, flushes the snapshot and exits 0 on SIGTERM", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opensmm-shutdown-"));
    const statePath = path.join(dir, "opensmm-state.json");
    const node = await startNode(["--state", statePath]);
    let socket: net.Socket | undefined;
    try {
      // An accepted order must survive the stop: it is what the card protects.
      const catalog = await getJson(node.baseUrl, "/v0/services");
      const serviceId: string = catalog.body.services[0].serviceId;
      const quote = await postJson(node.baseUrl, "/v0/quotes", {
        serviceId,
        quantity: 100,
        link: "https://t.me/opensmm_shutdown",
      });
      const order = await postJson(node.baseUrl, "/v0/orders", {
        quoteId: quote.body.quoteId,
        link: "https://t.me/opensmm_shutdown",
        clientReference: "smoke-graceful-shutdown",
      });
      const orderId: string = order.body.orderId;

      // A request whose headers are in and whose body is still pending: it is
      // in flight from the server's point of view. `Expect: 100-continue`
      // makes the handshake observable — the 100 line proves the gateway has
      // the request before SIGTERM arrives.
      const client = await connectSocket(node.port);
      socket = client;
      let response = "";
      client.on("data", (chunk: Buffer) => {
        response += chunk.toString();
      });
      const body = Buffer.from(
        JSON.stringify({ serviceId, quantity: 100, link: "https://t.me/opensmm_drain" }),
      );
      client.write(
        "POST /v0/quotes HTTP/1.1\r\n" +
          `Host: 127.0.0.1:${node.port}\r\n` +
          "Content-Type: application/json\r\n" +
          "Expect: 100-continue\r\n" +
          "Connection: close\r\n" +
          `Content-Length: ${body.length}\r\n` +
          "\r\n",
      );
      await waitUntil(() => response.includes("100 Continue"), "the gateway to accept the request");

      const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
        (resolve) => {
          node.child.once("exit", (code, signal) => resolve({ code, signal }));
        },
      );
      node.child.kill("SIGTERM");

      // A graceful stop waits for the active request instead of exiting at
      // once: a process that dies here never drains anything.
      await delay(400);
      assert.equal(node.child.exitCode, null, "the in-flight request is drained, not dropped");
      assert.equal(
        response.includes("HTTP/1.1 201"),
        false,
        "the pending request is not answered before its body arrives",
      );

      client.write(body);
      await waitUntil(() => response.includes("HTTP/1.1 201"), "the drained response");
      assert.match(
        response,
        /^HTTP\/1\.1 100 Continue\r\n\r\nHTTP\/1\.1 201 /,
        "the drained request is answered",
      );

      let deadlineTimer: NodeJS.Timeout | undefined;
      const result = await Promise.race([
        exited,
        new Promise<never>((_, reject) => {
          deadlineTimer = setTimeout(() => {
            node.child.kill("SIGKILL");
            reject(new Error("gateway did not exit within 10s of SIGTERM"));
          }, 10_000);
        }),
      ]);
      if (deadlineTimer) clearTimeout(deadlineTimer);

      // The handler owns the signal: the process must not die from it.
      assert.equal(result.signal, null, "SIGTERM is handled by the gateway");
      assert.equal(result.code, 0, "graceful shutdown exits 0");

      assert.ok(fs.existsSync(statePath), "the snapshot is written on SIGTERM");
      const snapshot = JSON.parse(fs.readFileSync(statePath, "utf8"));
      assert.equal(snapshot.format, 1, "the snapshot is valid gateway state");
      assert.ok(
        snapshot.orders.some((entry: { orderId: string }) => entry.orderId === orderId),
        `the accepted order ${orderId} is in the snapshot`,
      );
    } finally {
      socket?.destroy();
      if (node.child.exitCode === null) node.child.kill("SIGKILL");
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
