#!/usr/bin/env node
/**
 * Smoke test of an MCP Bundle: unpack it into an empty temp dir outside the
 * repository, start the server as its `manifest.json` says and send
 * `initialize` and `tools/list` over stdio. The server gets only PATH and an
 * empty HOME, so it runs with no keys (and sees no CI credentials).
 *
 * Usage:
 *   node scripts/smoke-mcpb.mjs [path-to.mcpb]   # no path: builds one first
 *
 * Exits non-zero on any failure or timeout.
 */
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { buildBundle, MCPB_CLI } from "./build-mcpb.mjs";

const TIMEOUT_MS = 30_000;

async function smoke(bundle, workDir) {
  const unpacked = path.join(workDir, "bundle");
  const home = path.join(workDir, "home");
  mkdirSync(home);
  execFileSync(process.execPath, [MCPB_CLI, "unpack", bundle, unpacked], { stdio: "inherit" });

  const manifest = JSON.parse(readFileSync(path.join(unpacked, "manifest.json"), "utf8"));
  const { command, args = [] } = manifest.server.mcp_config;
  const child = spawn(
    command === "node" ? process.execPath : command,
    args.map((arg) => arg.replaceAll("${__dirname}", unpacked)),
    { cwd: home, env: { PATH: process.env.PATH, HOME: home }, stdio: ["pipe", "pipe", "inherit"] },
  );

  let timer;
  const failure = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer within ${TIMEOUT_MS} ms`)), TIMEOUT_MS);
    child.on("error", reject);
    child.on("exit", (code) => reject(new Error(`server exited early with code ${code}`)));
    child.stdin.on("error", reject);
  });
  failure.catch(() => {});

  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  const send = (message) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  async function request(id, method, params) {
    send({ id, method, params });
    for (;;) {
      const { value, done } = await Promise.race([lines.next(), failure]);
      if (done) throw new Error(`server closed stdout before answering ${method}`);
      const message = JSON.parse(value);
      if (message.id !== id) continue;
      if (!message.result) throw new Error(`${method} failed: ${value}`);
      return message.result;
    }
  }

  try {
    const initialized = await request(1, "initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "smoke-mcpb", version: "0" },
    });
    if (initialized.serverInfo?.version !== manifest.version) {
      throw new Error(
        `serverInfo.version ${initialized.serverInfo?.version} differs from manifest version ${manifest.version}`,
      );
    }
    send({ method: "notifications/initialized" });
    const { tools } = await request(2, "tools/list", {});
    if (!tools?.length) throw new Error("tools/list returned no tools");
    console.log(`smoke OK: ${path.basename(bundle)}: initialize, tools/list (${tools.length} tools)`);
  } finally {
    clearTimeout(timer);
    child.kill();
  }
}

const bundle = process.argv[2] ? path.resolve(process.argv[2]) : buildBundle();
const workDir = mkdtempSync(path.join(os.tmpdir(), "opensmm-mcpb-smoke-"));
try {
  await smoke(bundle, workDir);
} catch (error) {
  console.error(`smoke FAILED: ${error.message}`);
  process.exitCode = 1;
} finally {
  rmSync(workDir, { recursive: true, force: true });
}
