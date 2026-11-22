#!/usr/bin/env node
/**
 * Smoke test for the ElizaOS plugin: drives its actions the way the ElizaOS
 * runtime does (stub runtime, no @elizaos/* install) against a node.
 * Flow: init -> SEARCH_SERVICES -> GET_QUOTE -> CREATE_ORDER -> CREATE_ORDER (replay).
 *
 * Usage: node examples/eliza/smoke.mjs [base-url] [--client-reference <ref>]
 * Mock catalog only: refuses to order a service not marked synthetic.
 */
import plugin from "./plugin.mjs";

const args = process.argv.slice(2);
const refIndex = args.indexOf("--client-reference");
const clientReference = refIndex >= 0 ? args[refIndex + 1] : `eliza-demo-${Date.now().toString(36)}`;
const baseUrl = (args.find((a, i) => !a.startsWith("-") && i !== refIndex + 1) ?? "http://127.0.0.1:8080").replace(/\/+$/, "");
const LINK = "https://t.me/opensmm_example";

const runtime = { getSetting: (key) => (key === "OPENSMM_NODE_URL" ? baseUrl : undefined) };
const run = async (name, parameters) => {
  const result = await plugin.actions.find((a) => a.name === name).handler(runtime, { content: {} }, undefined, { parameters });
  if (!result.success) throw new Error(result.text);
  console.log(`action:    ${name} — ${result.text}`);
  return result.data;
};

try {
  console.log(`node:      ${baseUrl}`);
  await plugin.init({}, runtime);
  const catalog = await run("SEARCH_SERVICES", {});
  const service = catalog.services?.[0];
  if (!service) throw new Error("the node returned an empty catalog");
  if (service.synthetic !== true) {
    throw new Error(`refusing to order: ${service.serviceId} is not marked synthetic (mock catalog only)`);
  }
  const quote = await run("GET_QUOTE", { serviceId: service.serviceId, quantity: 100, link: LINK });
  const orderArgs = { quoteId: quote.quoteId, link: LINK, clientReference };
  const order = await run("CREATE_ORDER", orderArgs);
  const replay = await run("CREATE_ORDER", orderArgs);
  if (replay.orderId !== order.orderId) throw new Error(`second orderId ${replay.orderId} for one clientReference`);
  console.log(`replay:    ${replay.orderId} — same orderId, no second order created`);
  console.log("done:      ElizaOS plugin OK");
} catch (err) {
  console.error(`error: ${err.message}`);
  if (err.cause?.code === "ECONNREFUSED") console.error("hint: start a node first — npm run gateway");
  process.exitCode = 1;
}
