#!/usr/bin/env node
/**
 * OpenSMM example for a LangChain-style agent: the model emits tool calls,
 * the harness executes them over the node's MCP endpoint (POST /mcp).
 *
 * Flow: search_services -> get_quote -> create_order -> create_order (replay).
 * The replay proves the protocol invariant: the same clientReference lands on
 * one orderId on any transport.
 *
 * Usage:
 *   node examples/langchain/agent.mjs [base-url] [options]
 *
 * Options:
 *   --client-reference <ref>  idempotency key of the order
 *   --quote <quote-id>        reuse a quote issued earlier
 *   -h, --help                show this help
 *
 * Needs Node.js >= 22.18 and a node from `npm run gateway`. No API key, no
 * LangChain package, no money: the tools are called directly and the order
 * stays REQUIRES_PAYMENT on the mock catalog.
 */

const DEFAULT_BASE_URL = "http://127.0.0.1:8080";
const QUANTITY = 100;
// Target of the order. The mock provider stores it and never touches it.
const LINK = "https://t.me/opensmm_example";

/** The tool surface an MCP-equipped LangChain agent sees (names + intent). */
const TOOLS = [
  {
    name: "search_services",
    description: "Find a service in the catalog. On the mock node every service is synthetic.",
    parameters: { type: "object", properties: { query: { type: "string" } } },
  },
  {
    name: "get_quote",
    description: "Price one service for a quantity and a link. A quote is consumed once.",
    parameters: {
      type: "object",
      required: ["serviceId", "quantity", "link"],
      properties: {
        serviceId: { type: "string" },
        quantity: { type: "integer" },
        link: { type: "string" },
      },
    },
  },
  {
    name: "create_order",
    description: "Create an unpaid order from a quote; the same clientReference replays it.",
    parameters: {
      type: "object",
      required: ["quoteId", "link", "clientReference"],
      properties: {
        quoteId: { type: "string" },
        link: { type: "string" },
        clientReference: { type: "string" },
      },
    },
  },
];

function usage() {
  return `Usage: node examples/langchain/agent.mjs [base-url] [options]

Options:
  --client-reference <ref>  idempotency key of the order (default: langchain-demo-<random>)
  --quote <quote-id>        reuse a quote issued earlier instead of pricing a new one
  -h, --help                show this help

Example:
  npm run gateway                                          # in another terminal
  node examples/langchain/agent.mjs http://127.0.0.1:8080 --client-reference my-first-order
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
  options.clientReference ??= `langchain-demo-${Date.now().toString(36)}`;
  return options;
}

let nextId = 1;

/** One tool call = one JSON-RPC POST /mcp, the wire shape an MCP adapter uses. */
async function callTool(baseUrl, name, args) {
  const response = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: nextId++,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  const text = await response.text();
  const dataLine = text.split("\n").find((line) => line.startsWith("data: "));
  const payload = JSON.parse(dataLine ? dataLine.slice("data: ".length) : text);
  if (payload.error) throw new Error(`${payload.error.code ?? "MCP_ERROR"}: ${payload.error.message}`);
  const result = payload.result ?? {};
  if (result.isError) {
    const body = result.structuredContent ?? {};
    const error = body.error ?? body;
    throw new Error(`${error.code ?? "TOOL_ERROR"}: ${error.message ?? `tool ${name} failed`}`);
  }
  return result.structuredContent;
}

/** Print the call the way an agent trace shows it, then execute it. */
async function emit(baseUrl, name, args) {
  console.log(`tool:      ${name}(${JSON.stringify(args)})`);
  return callTool(baseUrl, name, args);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }

  const baseUrl = options.baseUrl;
  console.log(`node:      ${baseUrl}`);
  console.log("transport: MCP tools over POST /mcp (LangChain-style tool calls)");
  console.log(`tools:     ${TOOLS.map((tool) => tool.name).join(", ")}`);

  // 1. The model picks search_services from TOOLS and calls it with no filters.
  const catalog = await emit(baseUrl, "search_services", {});
  const service = catalog.services?.[0];
  if (!service) throw new Error("the node returned an empty catalog: no services to order");
  if (service.synthetic !== true) {
    throw new Error(
      `refusing to place a demo order: ${service.serviceId} is not marked synthetic. ` +
        "This example orders only on the mock catalog — see examples/README.md.",
    );
  }
  console.log("catalog:   MOCK — every service is marked synthetic: not real supply, no real money");
  console.log(`service:   ${service.serviceId} — ${service.name}`);

  // 2. A quote is priced once and consumed once.
  let quoteId = options.quoteId;
  if (quoteId) {
    console.log(`quote:     ${quoteId} (reused)`);
  } else {
    const quote = await emit(baseUrl, "get_quote", {
      serviceId: service.serviceId,
      quantity: QUANTITY,
      link: LINK,
    });
    quoteId = quote.quoteId;
    console.log(
      `quote:     ${quote.quoteId} — ${quote.amount.value} ${quote.amount.currency} for ${quote.quantity} (mock rate)`,
    );
  }

  // 3. The agent places the order. Nothing is paid, nothing is executed.
  const orderArgs = { quoteId, link: LINK, clientReference: options.clientReference };
  const order = await emit(baseUrl, "create_order", orderArgs);
  console.log(
    `order:     ${order.orderId} — ${order.paymentStatus}, clientReference "${order.clientReference}"`,
  );

  // 4. Same tool call again: one clientReference, one orderId.
  const replay = await emit(baseUrl, "create_order", orderArgs);
  if (replay.orderId !== order.orderId) {
    throw new Error(`the node returned a second orderId (${replay.orderId}) for one clientReference`);
  }
  console.log(`replay:    ${replay.orderId} — same orderId, no second order created`);
  console.log("done:      LangChain-style agent OK");
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
