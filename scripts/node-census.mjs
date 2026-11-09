#!/usr/bin/env node
/**
 * OpenSMM node census: probes a short list of known gateway URLs and reports
 * whether each one serves the protocol. A node is "up" when GET /v0/services
 * answers 200 and POST /mcp answers an `initialize` JSON-RPC request.
 * An unreachable URL is data, not an error: it is reported with status "down"
 * and the process still exits 0. Exit 1 is reserved for broken arguments.
 *
 * Usage: node scripts/node-census.mjs --url http://127.0.0.1:8080 [--url ...]
 *        node scripts/node-census.mjs --file nodes.txt
 */

import { readFileSync } from "node:fs";

const TIMEOUT_MS = 5000;
const MAX_NODES = 20;

const USAGE = `usage: node scripts/node-census.mjs (--url <url> | --file <path>)...
  --url <url>    gateway base URL, repeatable
  --file <path>  file with one URL per line ("#" starts a comment line)
  max ${MAX_NODES} URLs per run; output is JSON on stdout, a summary on stderr`;

class UsageError extends Error {}

function parseUrl(value, source) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new UsageError(`${source}: not a URL: ${value}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new UsageError(`${source}: only http(s) URLs are supported: ${value}`);
  }
  return value.replace(/\/+$/, "");
}

export function parseArgs(argv) {
  const urls = [];
  const files = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--url" || arg === "--file") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new UsageError(`${arg} requires a value`);
      }
      if (arg === "--url") urls.push(parseUrl(value, "--url"));
      else files.push(value);
      i += 1;
    } else if (arg === "--help" || arg === "-h") {
      process.stdout.write(`${USAGE}\n`);
      process.exit(0);
    } else {
      throw new UsageError(`unknown argument: ${arg}`);
    }
  }

  for (const file of files) {
    let text;
    try {
      text = readFileSync(file, "utf8");
    } catch (err) {
      throw new UsageError(`--file ${file}: ${(err && err.message) || "cannot read file"}`);
    }
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      urls.push(parseUrl(line, `--file ${file}`));
    }
  }

  if (urls.length === 0) throw new UsageError("no URLs given; pass --url or --file");
  if (urls.length > MAX_NODES) {
    throw new UsageError(`${urls.length} URLs given; the limit is ${MAX_NODES} per run`);
  }
  return urls;
}

async function readBody(res) {
  const text = await res.text();
  if (!text) return undefined;
  const type = res.headers.get("content-type") ?? "";
  if (type.includes("text/event-stream")) {
    const line = text.split(/\r?\n/).find((l) => l.startsWith("data:"));
    if (!line) return undefined;
    return JSON.parse(line.slice("data:".length).trim());
  }
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

async function probe(method, url, body) {
  const headers = { accept: "application/json, text/event-stream" };
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(url, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  return { res, body: await readBody(res) };
}

function countOf(payload, key) {
  const list = payload && typeof payload === "object" ? payload[key] : undefined;
  return Array.isArray(list) ? list.length : null;
}

function errorText(err) {
  const cause = err && err.cause && err.cause.message ? `: ${err.cause.message}` : "";
  return `${(err && err.message) || String(err)}${cause}`;
}

export async function census(baseUrl) {
  const started = Date.now();
  const entry = { url: baseUrl, services: null, providers: null, initialize: false, latencyMs: 0, status: "down" };
  let servicesOk = false;

  try {
    const { res, body } = await probe("GET", `${baseUrl}/v0/services`);
    if (res.ok) {
      servicesOk = true;
      entry.services = countOf(body, "services");
    } else {
      entry.error = `GET /v0/services: HTTP ${res.status}`;
    }
  } catch (err) {
    entry.error = `GET /v0/services: ${errorText(err)}`;
  }

  try {
    const { res, body } = await probe("POST", `${baseUrl}/mcp`, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "opensmm-node-census", version: "0.1.0" },
      },
    });
    entry.initialize = res.ok && Boolean(body && body.result);
    if (!entry.initialize && !entry.error) entry.error = `POST /mcp initialize: HTTP ${res.status}`;
  } catch (err) {
    if (!entry.error) entry.error = `POST /mcp initialize: ${errorText(err)}`;
  }

  try {
    const { res, body } = await probe("GET", `${baseUrl}/v0/providers`);
    if (res.ok) entry.providers = countOf(body, "providers");
  } catch {
    // Providers are informational: a node is judged by services + initialize.
  }

  entry.latencyMs = Date.now() - started;
  entry.status = servicesOk && entry.initialize ? "up" : "down";
  if (entry.status === "up") delete entry.error;
  return entry;
}

function pluralNodes(n) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return "узел";
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return "узла";
  return "узлов";
}

async function main() {
  let urls;
  try {
    urls = parseArgs(process.argv.slice(2));
  } catch (err) {
    if (err instanceof UsageError) {
      process.stderr.write(`node-census: ${err.message}\n${USAGE}\n`);
      process.exit(1);
    }
    throw err;
  }

  const results = [];
  for (const url of urls) results.push(await census(url));

  const up = results.filter((r) => r.status === "up").length;
  process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
  process.stderr.write(
    `${results.length} ${pluralNodes(results.length)}: ${up} up, ${results.length - up} down\n`,
  );
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"));
if (isMain) await main();
