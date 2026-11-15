#!/usr/bin/env node
/**
 * OpenSMM REST client example: list the catalog, price a service, place an
 * order on the node's mock provider, then repeat the same order to show
 * idempotency (`clientReference` -> one `orderId`).
 *
 * Usage:
 *   node examples/rest-client.mjs [base-url] [options]
 *
 * Options:
 *   --client-reference <ref>  idempotency key of the order
 *   --quote <quote-id>        reuse a quote issued earlier (e.g. by the MCP example)
 *
 * Default base URL is http://127.0.0.1:8080 — a node from `npm run gateway`.
 * Needs Node.js >= 22.18, no dependencies, no API keys, no money: the order
 * stays REQUIRES_PAYMENT and nothing is executed.
 */

const DEFAULT_BASE_URL = "http://127.0.0.1:8080";
const QUANTITY = 100;
// Target of the order. The mock provider stores it and never touches it.
const LINK = "https://t.me/opensmm_example";

function usage() {
  return `Usage: node examples/rest-client.mjs [base-url] [options]

Options:
  --client-reference <ref>  idempotency key of the order (default: examples-demo-<random>)
  --quote <quote-id>        reuse a quote issued earlier instead of pricing a new one
  -h, --help                show this help

Example:
  npm run gateway                                   # in another terminal
  node examples/rest-client.mjs http://127.0.0.1:8080 --client-reference my-first-order
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

async function request(baseUrl, route, init = {}) {
  const response = await fetch(`${baseUrl}${route}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
  const body = await response.json().catch(() => null);
  return { status: response.status, body };
}

/** Turn an OpenSMM error body into a readable throw. */
function check(response, { acceptStatuses = [200] } = {}) {
  if (acceptStatuses.includes(response.status)) return response.body;
  const error = response.body?.error;
  throw new Error(
    error
      ? `${error.code}: ${error.message}`
      : `${response.status} from the node: ${JSON.stringify(response.body)}`,
  );
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }

  const baseUrl = options.baseUrl;
  console.log(`node:    ${baseUrl}`);

  // 1. The catalog. A node on defaults serves the mock catalog.
  const catalog = check(await request(baseUrl, "/v0/services"));
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
    const quote = check(
      await request(baseUrl, "/v0/quotes", {
        method: "POST",
        body: JSON.stringify({ serviceId: service.serviceId, quantity: QUANTITY, link: LINK }),
      }),
      { acceptStatuses: [201] },
    );
    quoteId = quote.quoteId;
    console.log(
      `quote:   ${quote.quoteId} — ${quote.amount.value} ${quote.amount.currency} for ${quote.quantity} (mock rate)`,
    );
  }

  // 3. The order. An unpaid order answers 402 and still carries the order body.
  const orderBody = { quoteId, link: LINK, clientReference: options.clientReference };
  const order = check(
    await request(baseUrl, "/v0/orders", { method: "POST", body: JSON.stringify(orderBody) }),
    { acceptStatuses: [200, 402] },
  );
  console.log(
    `order:   ${order.orderId} — ${order.paymentStatus}, clientReference "${order.clientReference}"`,
  );

  // 4. The same call again: same clientReference -> same order, nothing new created.
  const replay = check(
    await request(baseUrl, "/v0/orders", { method: "POST", body: JSON.stringify(orderBody) }),
    { acceptStatuses: [200, 402] },
  );
  if (replay.orderId !== order.orderId) {
    throw new Error(`the node returned a second orderId (${replay.orderId}) for one clientReference`);
  }
  console.log(`replay:  ${replay.orderId} — same orderId, no second order created`);
  console.log("done:    REST client OK");
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
