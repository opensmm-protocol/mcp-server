#!/usr/bin/env node
/**
 * `server.json` is the single source of truth for the MCP Registry manifest.
 * The repo-root `mcp.json` and the website copy are byte-for-byte mirrors of
 * it. Usage:
 *   node scripts/sync-manifests.mjs           # rewrite the copies
 *   node scripts/sync-manifests.mjs --check   # exit 1 when a copy drifts
 */
import { readFileSync, writeFileSync } from "node:fs";

const source = readFileSync("server.json", "utf8");
const targets = ["mcp.json", "website/mcp.json"];
const check = process.argv.includes("--check");
let drift = false;

for (const target of targets) {
  if (readFileSync(target, "utf8") === source) continue;
  drift = true;
  if (check) {
    console.error(`${target} differs from server.json`);
    continue;
  }
  writeFileSync(target, source);
  console.log(`synced ${target}`);
}

if (check && drift) process.exitCode = 1;
