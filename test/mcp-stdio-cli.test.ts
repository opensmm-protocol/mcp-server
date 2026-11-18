/**
 * `opensmm mcp` (ZHC-972): the stdio MCP server behind Dockerfile.mcp.
 * Spawns the CLI, speaks newline-delimited JSON-RPC, checks initialize and tools/list.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const BIN = path.join(REPO_ROOT, "bin", "opensmm.mjs");

const CLEAN_ENV = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !/^(OPENSMM_|X402_|PORT$|MCP_HTTP_PORT$)/.test(key)),
);

function talk(requests: object[]): Promise<Record<string, any>[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, "mcp"], { cwd: REPO_ROOT, env: CLEAN_ENV });
    const replies: Record<string, any>[] = [];
    let buf = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("timeout waiting for replies"));
    }, 30_000);
    child.stdout.on("data", (chunk: Buffer) => {
      buf += chunk.toString();
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) replies.push(JSON.parse(line));
      }
      if (replies.length >= requests.filter((r: any) => r.id !== undefined).length) {
        clearTimeout(timer);
        child.kill();
        resolve(replies);
      }
    });
    child.on("error", reject);
    for (const r of requests) child.stdin.write(JSON.stringify(r) + "\n");
  });
}

describe("opensmm mcp (stdio)", () => {
  it("answers initialize and tools/list", async () => {
    const replies = await talk([
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } },
      },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
    ]);
    const init = replies.find((r) => r.id === 1);
    const list = replies.find((r) => r.id === 2);
    assert.ok(init?.result?.serverInfo, "initialize result");
    assert.ok(Array.isArray(list?.result?.tools) && list.result.tools.length > 0, "tools listed");
  });

  it("Dockerfile.mcp runs `mcp` and exposes no port", () => {
    const f = fs.readFileSync(path.join(REPO_ROOT, "Dockerfile.mcp"), "utf8");
    assert.match(f, /CMD \["bin\/opensmm\.mjs", "mcp"\]/);
    assert.doesNotMatch(f, /^EXPOSE/m);
  });
});
