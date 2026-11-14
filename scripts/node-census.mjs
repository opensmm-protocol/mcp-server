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

const NODE_BUDGET_MS = 5000;
const MAX_NODES = 20;

const USAGE = `usage: node scripts/node-census.mjs (--url <url> | --file <path>)...
  --url <url>    gateway base URL, repeatable
  --file <path>  file with one URL per line ("#" starts a comment line)
  max ${MAX_NODES} unique URLs per run; output is JSON on stdout, a summary on stderr`;

class UsageError extends Error {}

export function parseUrl(value, source) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new UsageError(`${source}: not a URL: ${value}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new UsageError(`${source}: only http(s) URLs are supported: ${value}`);
  }
  if (url.username || url.password) {
    throw new UsageError(
      `${source}: credentials in the URL are not allowed: ${url.protocol}//${url.host}`,
    );
  }
  return url.href.replace(/\/+$/, "");
}

function parseArgs(argv) {
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

  const unique = [...new Set(urls)];
  if (unique.length === 0) throw new UsageError("no URLs given; pass --url or --file");
  if (unique.length > MAX_NODES) {
    throw new UsageError(`${unique.length} unique URLs given; the limit is ${MAX_NODES} per run`);
  }
  return unique;
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

async function probe(method, url, body, signal) {
  const headers = { accept: "application/json, text/event-stream" };
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(url, {
    method,
    headers,
    redirect: "manual",
    signal,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { res, body: await readBody(res) };
}

function countOf(payload, key) {
  const list = payload && typeof payload === "object" ? payload[key] : undefined;
  return Array.isArray(list) ? list.length : null;
}

function errorText(err) {
  if (err && err.name === "AbortError") return `no answer in ${NODE_BUDGET_MS / 1000} s`;
  const cause = err && err.cause && err.cause.message ? `: ${err.cause.message}` : "";
  return `${(err && err.message) || String(err)}${cause}`;
}

function pluralEn(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * Probes one node. Returns the census entry plus a per-check report, so callers
 * that explain a verdict (scripts/verify-node.mjs) use exactly these checks and
 * never re-implement them.
 *
 * @param {string} baseUrl
 */
export async function censusNode(baseUrl) {
  const started = Date.now();
  const entry = {
    url: baseUrl,
    services: null,
    providers: null,
    initialize: false,
    latencyMs: 0,
    status: "down",
  };
  const checks = [];
  const errors = [];
  let servicesOk = false;

  // One budget for all three probes, so a dead host costs 5 s, not 15.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), NODE_BUDGET_MS);

  try {
    try {
      const { res, body } = await probe("GET", `${baseUrl}/v0/services`, undefined, controller.signal);
      const services = countOf(body, "services");
      if (!res.ok) {
        errors.push(`GET /v0/services: HTTP ${res.status}`);
        checks.push({ name: "GET /v0/services", ok: false, detail: `HTTP ${res.status}` });
      } else if (services === null) {
        errors.push("GET /v0/services: not a JSON catalog");
        checks.push({ name: "GET /v0/services", ok: false, detail: "not a JSON catalog" });
      } else {
        servicesOk = true;
        entry.services = services;
        checks.push({
          name: "GET /v0/services",
          ok: true,
          detail: `${pluralEn(services, "service", "services")} in the catalog`,
        });
      }
    } catch (err) {
      errors.push(`GET /v0/services: ${errorText(err)}`);
      checks.push({ name: "GET /v0/services", ok: false, detail: errorText(err) });
    }

    try {
      const { res, body } = await probe(
        "POST",
        `${baseUrl}/mcp`,
        {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "opensmm-node-census", version: "0.1.0" },
          },
        },
        controller.signal,
      );
      entry.initialize = res.ok && Boolean(body && body.result);
      if (!entry.initialize) {
        errors.push(
          res.ok
            ? "POST /mcp initialize: not an MCP response"
            : `POST /mcp initialize: HTTP ${res.status}`,
        );
        checks.push({
          name: "POST /mcp initialize",
          ok: false,
          detail: res.ok ? "not an MCP response" : `HTTP ${res.status}`,
        });
      } else {
        const result = body.result;
        const protocol = result.protocolVersion ?? "unknown protocol version";
        const server = result.serverInfo && result.serverInfo.name ? `, server ${result.serverInfo.name}` : "";
        checks.push({ name: "POST /mcp initialize", ok: true, detail: `${protocol}${server}` });
      }
    } catch (err) {
      errors.push(`POST /mcp initialize: ${errorText(err)}`);
      checks.push({ name: "POST /mcp initialize", ok: false, detail: errorText(err) });
    }

    try {
      const { res, body } = await probe("GET", `${baseUrl}/v0/providers`, undefined, controller.signal);
      if (res.ok) entry.providers = countOf(body, "providers");
      let detail;
      if (!res.ok) detail = `HTTP ${res.status}`;
      else if (entry.providers === null) detail = "not a JSON provider list";
      else detail = `${pluralEn(entry.providers, "provider", "providers")} registered`;
      checks.push({ name: "GET /v0/providers", ok: res.ok && entry.providers !== null, detail, required: false });
    } catch (err) {
      // Providers are informational: a node is judged by services + initialize.
      checks.push({ name: "GET /v0/providers", ok: false, detail: errorText(err), required: false });
    }
  } finally {
    clearTimeout(timer);
  }

  entry.latencyMs = Date.now() - started;
  entry.status = servicesOk && entry.initialize ? "up" : "down";
  if (entry.status === "down" && errors.length > 0) entry.error = errors.join("; ");
  return { entry, checks };
}

async function census(baseUrl) {
  return (await censusNode(baseUrl)).entry;
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
