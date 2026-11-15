#!/usr/bin/env node
/**
 * OpenSMM MCP client example: talk JSON-RPC to a node's MCP endpoint on
 * POST /mcp — search the catalog, price a service, place an order on the
 * mock provider, then repeat it to show idempotency
 * (`clientReference` -> one `orderId`).
 *
 * Usage:
 *   node examples/mcp-client.mjs [base-url] [options]
 *
 * Options:
 *   --client-reference <ref>  idempotency key of the order
 *   --quote <quote-id>        reuse a quote issued earlier (e.g. by the REST example)
 *
 * Default base URL is http://127.0.0.1:8080 — a node from `npm run gateway`.
 * Needs Node.js >= 22.18, no dependencies, no MCP SDK, no API keys and no
 * money: the order stays REQUIRES_PAYMENT and nothing is executed.
 */

const DEFAULT_BASE_URL = "http://127.0.0.1:8080";
const QUANTITY = 100;
// Target of the order. The mock provider stores it and never touches it.
const LINK = "https://t.me/opensmm_example";

function usage() {
  return `Usage: node examples/mcp-client.mjs [base-url] [options]

Options:
  --client-reference <ref>  idempotency key of the order (default: examples-demo-<random>)
  --quote <quote-id>        reuse a quote issued earlier instead of pricing a new one
  -h, --help                show this help

Example:
  npm run gateway                                   # in another terminal
  node examples/mcp-client.mjs http://127.0.0.1:8080 --client-reference my-first-order
`;
}

function parseArgs(argv) {
  const options = { baseUrl: DEFAULT_BASE_URL };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") {
      options.help = true;
      continue;
    }
    if (arg === "--client-reference" || arg === "--quote") {
      const value = argv[i + 1];
      if (!value) throw new Error(`${arg} requires a value`);
      if (arg === "--client-reference") options.clientReference = value;
      else options.quoteId = value;
      i += 1;
      continue;
    }
    if (arg.startsWith("-")) throw new Error(`unknown option: ${arg}`);
    options.baseUrl = arg.replace(/\/+$/, "");
  }
  options.clientReference ??= `examples-demo-${Date.now().toString(36)}`;
  return options;
}

let nextId = 1;

/**
 * One JSON-RPC round trip on POST /mcp. The node is stateless, so every call
 * is a plain POST; the answer arrives as SSE (`data: {...}`) or as plain JSON.
 */
async function rpc(baseUrl, method, params = {}) {
  const response = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
  });
  const text = await response.text();
  const dataLine = text.split("\n").find((line) => line.startsWith("data: "));
  const payload = JSON.parse(dataLine ? dataLine.slice("data: ".length) : text);
  if (payload.error) {
    throw new Error(`${payload.error.code ?? "MCP_ERROR"}: ${payload.error.message}`);
  }
  return payload.result;
}

/** tools/call with the OpenSMM error body unwrapped. */
async function callTool(baseUrl, name, args) {
  const result = await rpc(baseUrl, "tools/call", { name, arguments: args });
  if (result?.isError) {
    // Tool errors travel as the canonical error body: { error: { code, message } }.
    const body = result.structuredContent ?? {};
    const error = body.error ?? body;
    throw new Error(`${error.code ?? "TOOL_ERROR"}: ${error.message ?? `tool ${name} failed`}`);
  }
  return result?.structuredContent;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }

  const baseUrl = options.baseUrl;
  console.log(`node:    ${baseUrl}`);
  console.log("transport: MCP over Streamable HTTP (JSON-RPC on POST /mcp)");

  await rpc(baseUrl, "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "opensmm-example", version: "0" },
  });

  // 1. The catalog, through the search_services tool.
  const catalog = await callTool(baseUrl, "search_services", {});
  const service = catalog.services?.[0];
  if (!service) throw new Error("the node returned an empty catalog: no services to order");

  if (service.synthetic !== true) {
    throw new Error(
      `refusing to place a demo order: ${service.serviceId} is not marked synthetic. ` +
        "This example orders only on the mock catalog — see examples/README.md.",
    );
  }
  console.log("catalog: MOCK — every service is marked synthetic: not real supply, no real money");
  console.log(`service: ${service.serviceId} — ${service.name}`);

  // 2. A quote. Pricing is mandatory before an order, and a quote is consumed once.
  let quoteId = options.quoteId;
  if (quoteId) {
    console.log(`quote:   ${quoteId} (reused)`);
  } else {
    const quote = await callTool(baseUrl, "get_quote", {
      serviceId: service.serviceId,
      quantity: QUANTITY,
      link: LINK,
    });
    quoteId = quote.quoteId;
    console.log(
      `quote:   ${quote.quoteId} — ${quote.amount.value} ${quote.amount.currency} for ${quote.quantity} (mock rate)`,
    );
  }

  // 3. The order. It stays unpaid: the example never pays and nothing executes.
  const orderArgs = { quoteId, link: LINK, clientReference: options.clientReference };
  const order = await callTool(baseUrl, "create_order", orderArgs);
  console.log(
    `order:   ${order.orderId} — ${order.paymentStatus}, clientReference "${order.clientReference}"`,
  );

  // 4. The same call again: same clientReference -> same order, nothing new created.
  const replay = await callTool(baseUrl, "create_order", orderArgs);
  if (replay.orderId !== order.orderId) {
    throw new Error(`the node returned a second orderId (${replay.orderId}) for one clientReference`);
  }
  console.log(`replay:  ${replay.orderId} — same orderId, no second order created`);
  console.log("done:    MCP client OK");
}

try {
  await main();
} catch (err) {
  console.error(`error: ${err.message}`);
  if (err.cause?.code === "ECONNREFUSED") {
    console.error(`hint: start a node first — npm run gateway (or bin/opensmm.mjs gateway --port 8080)`);
  }
  if (/^IDEMPOTENCY_CONFLICT/.test(err.message)) {
    console.error(
      "hint: that clientReference already belongs to an order made from another quote; " +
        "pass the --quote it was made with, or a new --client-reference",
    );
  }
  process.exitCode = 1;
}
