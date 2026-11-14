#!/usr/bin/env node
/**
 * Check one node the way the census (ZHC-324) will check it: a node counts
 * when GET /v0/services answers a JSON catalog and POST /mcp answers an
 * `initialize` JSON-RPC request. The checks come from scripts/node-census.mjs
 * — one definition, two front ends (census = collect, verify = pass/fail).
 *
 * Usage: node scripts/verify-node.mjs <url>
 *        npm run verify:node -- http://127.0.0.1:8080
 * Exit 0 = every check passes, exit 1 = the node would not be counted.
 */

import { census, parseUrl } from "./node-census.mjs";

const USAGE = `usage: node scripts/verify-node.mjs <url>
  runs the census checks against <url> and prints PASS/FAIL per check;
  exit 0 = the node passes, exit 1 = it does not.
  start your node first: npm run gateway (see docs/NODES.md)`;

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  if (args.length !== 1) {
    process.stderr.write(`verify-node: expected exactly one URL\n${USAGE}\n`);
    return 1;
  }

  let url;
  try {
    url = parseUrl(args[0], "url");
  } catch (err) {
    process.stderr.write(`verify-node: ${err.message}\n${USAGE}\n`);
    return 1;
  }

  const { checks, entry } = await census(url);
  const passed = checks.filter((c) => c.ok).length;
  const lines = [`node ${url}`];
  for (const check of checks) {
    lines.push(`${check.ok ? "PASS" : "FAIL"}  ${check.check.padEnd(21)} ${check.detail}`);
  }
  lines.push(
    `${entry.status === "up" ? "PASS" : "FAIL"}  node is ${
      entry.status === "up" ? "counted by the census" : "not counted by the census"
    } (${passed}/${checks.length} checks in ${entry.latencyMs} ms)`,
  );
  process.stdout.write(`${lines.join("\n")}\n`);

  if (entry.status !== "up") {
    process.stderr.write(
      `verify-node: ${entry.error ?? "node is down"}\n` +
        "fix the failing check and re-run; a node is defined in docs/NODES.md\n",
    );
  }
  return entry.status === "up" ? 0 : 1;
}

process.exitCode = await main();
