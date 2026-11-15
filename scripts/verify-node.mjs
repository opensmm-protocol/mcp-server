#!/usr/bin/env node
/**
 * Check one OpenSMM node before the weekly census: same probes as
 * scripts/node-census.mjs (imported, not copied), PASS/FAIL per check, a
 * verdict, exit 0 when the census would count the node and 1 otherwise.
 * --json prints { entry, checks } for monitoring scripts instead.
 *
 * Usage: npm run verify:node -- http://127.0.0.1:8080 [--json]
 */

import { censusNode, parseTimeout, parseUrl } from "./node-census.mjs";

const USAGE = `usage: npm run verify:node -- <url> [--timeout <ms>] [--json]
  <url>          gateway base URL, e.g. http://127.0.0.1:8080
  --timeout <ms> budget for all probes of one node, 1000-30000 ms (default 5000)
  --json         print {"entry","checks"} as JSON on stdout, for cron and CI

Prints PASS/FAIL for GET /v0/services and POST /mcp initialize — the two checks
the census counts — plus GET /v0/providers (informational), then a verdict.
Exit 0 = the census would count this node; exit 1 = it would not.
Node definition and how to start a node: docs/NODES.md`;

function report(lines) {
  process.stdout.write(`${lines.join("\n")}\n`);
}

async function main(argv) {
  if (argv.includes("--help") || argv.includes("-h")) {
    report([USAGE]);
    return 0;
  }

  let url;
  let timeoutMs;
  let json = false;
  try {
    const positional = [];
    for (let i = 0; i < argv.length; i += 1) {
      const arg = argv[i];
      if (arg === "--json") {
        json = true;
      } else if (arg === "--timeout") {
        const value = argv[i + 1];
        if (value === undefined || value.startsWith("--")) throw new Error("--timeout requires a value");
        timeoutMs = parseTimeout(value);
        i += 1;
      } else if (arg.startsWith("-")) {
        throw new Error(`unknown argument: ${arg}`);
      } else {
        positional.push(arg);
      }
    }
    if (positional.length === 0) throw new Error("no URL given");
    if (positional.length > 1) throw new Error(`expected one URL, got ${positional.length}`);
    url = parseUrl(positional[0], "<url>");
  } catch (err) {
    process.stderr.write(`verify-node: ${err.message}\n${USAGE}\n`);
    return 1;
  }

  const { entry, checks } = await censusNode(url, { timeoutMs });

  if (json) {
    report([JSON.stringify({ entry, checks }, null, 2)]);
    return entry.status === "up" ? 0 : 1;
  }

  const required = checks.filter((check) => check.required !== false);
  const passed = required.filter((check) => check.ok).length;

  const lines = [`verify-node: ${url}`, ""];
  for (const check of checks) {
    const mark = check.ok ? "PASS" : "FAIL";
    const note = check.required === false ? "   (informational, not counted)" : "";
    lines.push(`${mark}  ${check.name} — ${check.detail}${note}`);
  }
  lines.push("");

  if (entry.status === "up") {
    lines.push(`PASS — the census counts this node: ${passed}/${required.length} required checks passed in ${entry.latencyMs} ms`);
  } else {
    lines.push(`FAIL — the census will not count this node: ${passed}/${required.length} required checks passed`);
    lines.push("A node needs both GET /v0/services and POST /mcp initialize to answer: docs/NODES.md");
  }
  report(lines);
  return entry.status === "up" ? 0 : 1;
}

process.exitCode = await main(process.argv.slice(2));
