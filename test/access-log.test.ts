/**
 * Access log (ZHC-767): every request leaves exactly one JSON line on stdout —
 * time, method, path without query, status, duration in ms, x-request-id — and
 * never a body, a header or a query string. OPENSMM_ACCESS_LOG=0 silences the
 * log; the x-request-id response header stays.
 *
 * The node runs as a child process: stdout is the contract an operator reads.
 */

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { after, before, describe, it } from "node:test";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const BIN = path.join(REPO_ROOT, "bin", "opensmm.mjs");
const LOG_FIELDS = ["durationMs", "method", "path", "requestId", "status", "time"];

/** A node must not inherit provider/payment config from the developer shell. */
const CLEAN_ENV = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) => !/^(OPENSMM_|X402_|PORT$|MCP_HTTP_PORT$)/.test(key),
  ),
);

interface RunningNode {
  child: ChildProcess;
  baseUrl: string;
  /** Complete stdout lines, in arrival order. */
  lines: string[];
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function startNode(extraEnv: Record<string, string> = {}): Promise<RunningNode> {
  const child = spawn(process.execPath, [BIN, "gateway", "--port", "0"], {
    cwd: REPO_ROOT,
    env: { ...CLEAN_ENV, ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const lines: string[] = [];
  let pending = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    pending += chunk.toString();
    let index = pending.indexOf("\n");
    while (index >= 0) {
      lines.push(pending.slice(0, index));
      pending = pending.slice(index + 1);
      index = pending.indexOf("\n");
    }
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

  return { child, baseUrl: `http://127.0.0.1:${port}`, lines };
}

async function stopNode(node: RunningNode): Promise<void> {
  if (node.child.exitCode !== null) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      node.child.kill("SIGKILL");
      resolve();
    }, 10_000);
    node.child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    node.child.kill("SIGTERM");
  });
}

/** Wait for the next line after `from`, then prove nothing else followed. */
async function onlyLineSince(node: RunningNode, from: number): Promise<Record<string, unknown>> {
  const startedAt = Date.now();
  while (node.lines.length <= from) {
    if (Date.now() - startedAt > 5_000) {
      throw new Error(`no access-log line within 5s; got: ${JSON.stringify(node.lines.slice(from))}`);
    }
    await delay(10);
  }
  const line = node.lines[from]!;
  await delay(100);
  assert.equal(
    node.lines.length,
    from + 1,
    `exactly one line per request; got: ${JSON.stringify(node.lines.slice(from))}`,
  );
  return JSON.parse(line) as Record<string, unknown>;
}

describe("access log: one JSON line per request", () => {
  let node: RunningNode;

  before(async () => {
    node = await startNode();
  });

  after(async () => {
    await stopNode(node);
  });

  it("logs one line with the documented fields and no query string", async () => {
    const from = node.lines.length;
    const res = await fetch(`${node.baseUrl}/v0/capabilities?apiKey=SECRET-QUERY-123`);
    assert.equal(res.status, 200);
    const entry = await onlyLineSince(node, from);

    assert.deepEqual(Object.keys(entry).sort(), LOG_FIELDS);
    assert.equal(entry.method, "GET");
    assert.equal(entry.path, "/v0/capabilities");
    assert.equal(entry.status, 200);
    assert.equal(typeof entry.durationMs, "number");
    assert.ok((entry.durationMs as number) >= 0);
    assert.match(String(entry.requestId), /^[\w.:-]{1,128}$/);
    assert.ok(!Number.isNaN(Date.parse(String(entry.time))), "time must be a timestamp");
    assert.equal(res.headers.get("x-request-id"), entry.requestId);
    assert.ok(
      !node.lines[from]!.includes("SECRET-QUERY-123"),
      "query string leaked into the log line",
    );
  });

  it("echoes a caller x-request-id and returns it in the response", async () => {
    const from = node.lines.length;
    const res = await fetch(`${node.baseUrl}/v0/services`, {
      headers: { "x-request-id": "node-op-42" },
    });
    assert.equal(res.status, 200);
    const entry = await onlyLineSince(node, from);

    assert.equal(res.headers.get("x-request-id"), "node-op-42");
    assert.equal(entry.requestId, "node-op-42");
    assert.equal(entry.path, "/v0/services");
  });

  it("keeps bodies and headers out of the line", async () => {
    const from = node.lines.length;
    const res = await fetch(`${node.baseUrl}/v0/quotes`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer SECRET-PANEL-KEY",
      },
      body: JSON.stringify({
        serviceId: "osmm_svc_missing",
        quantity: 1,
        link: "https://t.me/SECRET-WALLET-0xdeadbeef",
      }),
    });
    assert.ok(res.status >= 400, "the quote for a missing service must fail");
    const entry = await onlyLineSince(node, from);

    assert.deepEqual(Object.keys(entry).sort(), LOG_FIELDS);
    assert.equal(entry.method, "POST");
    assert.equal(entry.path, "/v0/quotes");
    assert.equal(entry.status, res.status);
    for (const secret of ["SECRET-PANEL-KEY", "SECRET-WALLET", "authorization", "Bearer"]) {
      assert.ok(!node.lines[from]!.includes(secret), `${secret} leaked into the log line`);
    }
  });

  it("logs the MCP transport on the same single line", async () => {
    const from = node.lines.length;
    const res = await fetch(`${node.baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "access-log-test", version: "0.0.1" },
        },
      }),
    });
    assert.equal(res.status, 200);
    const entry = await onlyLineSince(node, from);

    assert.equal(entry.method, "POST");
    assert.equal(entry.path, "/mcp");
    assert.equal(entry.status, 200);
    const header = res.headers.get("x-request-id");
    assert.ok(header, "MCP responses must carry x-request-id");
    assert.equal(header, entry.requestId);
  });

  it("OPENSMM_ACCESS_LOG=0 silences the log but keeps x-request-id", async () => {
    const quiet = await startNode({ OPENSMM_ACCESS_LOG: "0" });
    try {
      const res = await fetch(`${quiet.baseUrl}/v0/capabilities`);
      assert.equal(res.status, 200);
      assert.ok(res.headers.get("x-request-id"), "x-request-id stays available for diagnostics");
      await delay(200);
      assert.deepEqual(quiet.lines, [], `no log line expected, got: ${JSON.stringify(quiet.lines)}`);
    } finally {
      await stopNode(quiet);
    }
  });
});
