/**
 * OpenSMM plugin for ElizaOS agents (tested against the ElizaOS 1.x plugin
 * shape: `{ name, description, init, actions: [{ name, validate, handler }] }`).
 *
 * Three actions — SEARCH_SERVICES, GET_QUOTE, CREATE_ORDER — over the node's
 * MCP endpoint (`POST /mcp`: `initialize`, then `tools/call`). No `@elizaos/*`
 * import: the plugin is a plain object, so it loads with `plugins: [opensmmPlugin]`
 * in a character and runs under plain Node.js >= 22.18 in the smoke test.
 *
 * Node URL: runtime setting `OPENSMM_NODE_URL`, else env, else localhost:8080.
 */

const DEFAULT_NODE_URL = "http://127.0.0.1:8080";

function nodeUrl(runtime) {
  const configured = runtime?.getSetting?.("OPENSMM_NODE_URL") ?? process.env.OPENSMM_NODE_URL;
  return String(configured || DEFAULT_NODE_URL).replace(/\/+$/, "");
}

let nextId = 1;

async function rpc(baseUrl, method, params) {
  const response = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
  });
  const text = await response.text();
  const dataLine = text.split("\n").find((line) => line.startsWith("data: "));
  const payload = JSON.parse(dataLine ? dataLine.slice("data: ".length) : text);
  if (payload.error) throw new Error(`${payload.error.code ?? "MCP_ERROR"}: ${payload.error.message}`);
  return payload.result ?? {};
}

async function callTool(runtime, name, args) {
  const result = await rpc(nodeUrl(runtime), "tools/call", { name, arguments: args });
  if (result.isError) {
    const body = result.structuredContent ?? {};
    const error = body.error ?? body;
    throw new Error(`${error.code ?? "TOOL_ERROR"}: ${error.message ?? `tool ${name} failed`}`);
  }
  return result.structuredContent;
}

/** Arguments come from structured action options, falling back to message content. */
const argsOf = (message, options) => ({ ...(message?.content ?? {}), ...(options?.parameters ?? options ?? {}) });

function action(name, similes, description, tool, pick, describe) {
  return {
    name,
    similes,
    description,
    examples: [],
    validate: async () => true,
    handler: async (runtime, message, _state, options, callback) => {
      try {
        const data = await callTool(runtime, tool, pick(argsOf(message, options)));
        const text = describe(data);
        await callback?.({ text, content: data });
        return { success: true, text, data };
      } catch (err) {
        const text = `OpenSMM ${tool} failed: ${err.message}`;
        await callback?.({ text });
        return { success: false, text, error: err };
      }
    },
  };
}

export const opensmmPlugin = {
  name: "opensmm",
  description: "Order SMM services from an OpenSMM node: search, quote, create an idempotent order.",
  init: async (_config, runtime) => {
    await rpc(nodeUrl(runtime), "initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "opensmm-eliza-plugin", version: "0.1.0" },
    });
  },
  actions: [
    action(
      "SEARCH_SERVICES",
      ["FIND_SMM_SERVICE", "LIST_SMM_SERVICES"],
      "Find SMM services in the OpenSMM node catalog.",
      "search_services",
      ({ query }) => (query ? { query } : {}),
      (data) => `Found ${data.services?.length ?? 0} service(s): ${(data.services ?? []).map((s) => s.serviceId).join(", ")}`,
    ),
    action(
      "GET_QUOTE",
      ["PRICE_SMM_SERVICE"],
      "Price one service for a quantity and a link. A quote is consumed once.",
      "get_quote",
      ({ serviceId, quantity, link }) => ({ serviceId, quantity: Number(quantity), link }),
      (q) => `Quote ${q.quoteId}: ${q.amount?.value} ${q.amount?.currency} for ${q.quantity}`,
    ),
    action(
      "CREATE_ORDER",
      ["PLACE_SMM_ORDER"],
      "Create an unpaid order from a quote; the same clientReference returns the same order.",
      "create_order",
      ({ quoteId, link, clientReference }) => ({ quoteId, link, clientReference }),
      (o) => `Order ${o.orderId}: ${o.paymentStatus}, clientReference "${o.clientReference}"`,
    ),
  ],
};

export default opensmmPlugin;
