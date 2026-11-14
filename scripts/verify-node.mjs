#!/usr/bin/env node
/**
 * Check one OpenSMM node before the weekly census: same probes as
 * scripts/node-census.mjs (imported, not copied), PASS/FAIL per check, a
 * verdict, exit 0 when the census would count the node and 1 otherwise.
 *
 * Usage: npm run verify:node -- http://127.0.0.1:8080
 */

import { censusNode, parseUrl } from "./node-census.mjs";

const USAGE = `usage: npm run verify:node -- <url>
  <url>  gateway base URL, e.g. http://127.0.0.1:8080

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
  if (argv.length !== 1) {
    process.stderr.write(
      `verify-node: ${argv.length === 0 ? "no URL given" : `expected one URL, got ${argv.length}`}\n${USAGE}\n`,
    );
    return 1;
  }

  let url;
  try {
    url = parseUrl(argv[0], "<url>");
  } catch (err) {
    process.stderr.write(`verify-node: ${err.message}\n${USAGE}\n`);
    return 1;
  }

  const { entry, checks } = await censusNode(url);
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
