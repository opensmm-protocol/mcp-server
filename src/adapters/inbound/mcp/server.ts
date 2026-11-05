/**
 * OpenSMM MCP adapter. Thin: every tool validates arguments, calls one core
 * command and returns structuredContent. No business logic here (spec/v0 §2).
 *
 * Run over stdio: `npm run mcp`.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type { OpenSmmCore } from "../../../core/core.ts";
import { toErrorBody } from "../../../core/errors.ts";

type ToolResult = {
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

function ok(data: unknown): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    structuredContent: data as Record<string, unknown>,
  };
}

function fail(err: unknown): ToolResult {
  const { body } = toErrorBody(err);
  return {
    content: [{ type: "text", text: JSON.stringify(body, null, 2) }],
    structuredContent: body,
    isError: true,
  };
}

export function createMcpServer(core: OpenSmmCore): McpServer {
  const server = new McpServer(
    { name: "opensmm", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.registerTool(
    "get_capabilities",
    {
      title: "Get OpenSMM capabilities",
      description:
        "Protocol version, supported commands, payment methods and catalog version of this OpenSMM gateway.",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async () => ok(core.getCapabilities()),
  );

  server.registerTool(
    "list_providers",
    {
      title: "List execution providers",
      description:
        "Pseudonymous list of connected execution providers with capabilities and gateway-measured quality metrics (sampleSize always shown; metric fields appear only with sufficient data). displayName is present only for providers that opted in to public listing.",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async () => {
      try {
        return ok(await core.listProviders());
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "register_provider",
    {
      title: "Register an execution provider",
      description:
        "Self-register a provider node on this gateway (spec/v0 §10). The endpoint must be a public https URL (SSRF guard); the gateway healthchecks the API by listing its offers, then syncs them into the catalog. The apiKey is used only to call the provider and is never returned. Re-registering the same endpoint returns the existing node.",
      inputSchema: {
        adapter: z
          .enum(["smm-v2", "rest-v1"])
          .describe("API dialect of the provider: classic key+action panel API or reseller-style REST v1"),
        endpoint: z.string().describe("Public https base URL of the provider API"),
        apiKey: z.string().describe("Provider-side credential; never returned by the API"),
        profile: z.string().optional().describe("smm-v2 only: behavior profile (default 'standard')"),
        displayName: z.string().optional().describe("Public name, shown only with publiclyListed=true"),
        publiclyListed: z.boolean().optional().describe("Opt in to publishing displayName"),
        payoutAddress: z.string().optional().describe("Direct-settlement payTo address for this provider's orders"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async (args) => {
      try {
        return ok(await core.registerProvider(args));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "search_services",
    {
      title: "Search SMM services",
      description:
        "Search the curated catalog of sellable SMM services by free text, platform and objective. Returns services with per-1000 rates, min/max and refill/cancel support.",
      inputSchema: {
        query: z.string().optional().describe("Free text, e.g. 'telegram members' or 'views'"),
        platform: z
          .enum(["telegram", "instagram", "youtube", "tiktok", "x", "vk", "other"])
          .optional(),
        objective: z
          .enum(["followers", "members", "likes", "views", "reactions", "comments", "other"])
          .optional(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async (args) => {
      try {
        return ok(core.searchServices(args));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "get_service",
    {
      title: "Get service details",
      description: "Full details of one service: rate, rateBasis, min/max, parameters, refill/cancel support.",
      inputSchema: {
        serviceId: z.string().regex(/^osmm_svc_/).describe("Service id from search_services"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async ({ serviceId }) => {
      try {
        return ok(core.getService(serviceId));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "get_quote",
    {
      title: "Get a price quote",
      description:
        "Price a service for a quantity (and optionally the target link). Returns an expiring quote with the total amount. A quote is MANDATORY before create_order.",
      inputSchema: {
        serviceId: z.string().regex(/^osmm_svc_/),
        quantity: z.number().int().min(1),
        link: z.string().optional().describe("Target URL/identifier, e.g. https://t.me/channel"),
        parameters: z.record(z.string(), z.unknown()).optional(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async (args) => {
      try {
        return ok(core.getQuote(args));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "create_order",
    {
      title: "Create an order",
      description:
        "Create an order from a quote. REQUIRES explicit user confirmation: first call get_quote, show the user the amount, then call this tool. " +
        "Idempotent via clientReference: repeating with the same clientReference returns the same order without charging twice. " +
        "The order is created with paymentStatus REQUIRES_PAYMENT and includes paymentRequirements; execution starts only after payment settles.",
      inputSchema: {
        quoteId: z.string().regex(/^osmm_quote_/),
        link: z.string().min(1).describe("Target URL/identifier"),
        quantity: z.number().int().min(1).optional().describe("Defaults to the quoted quantity"),
        parameters: z.record(z.string(), z.unknown()).optional(),
        clientReference: z
          .string()
          .min(1)
          .max(128)
          .describe("Your idempotency key, unique per intended order"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async (args) => {
      try {
        const { order } = await core.createOrder(args);
        return ok(order);
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "get_order_status",
    {
      title: "Get order status",
      description:
        "Poll an order. paymentStatus and executionStatus are independent: SETTLED payment + IN_PROGRESS execution is normal. Poll with pauses; do not re-pay on SETTLEMENT_PENDING.",
      inputSchema: { orderId: z.string().regex(/^osmm_order_/) },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async ({ orderId }) => {
      try {
        return ok(await core.getOrder(orderId));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "cancel_order",
    {
      title: "Cancel an order",
      description:
        "Cancel an order when the service supports it. Unpaid orders cancel immediately; executing orders are canceled at the provider and the payment moves to REFUNDING.",
      inputSchema: { orderId: z.string().regex(/^osmm_order_/) },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async ({ orderId }) => {
      try {
        return ok(await core.cancelOrder(orderId));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "request_refill",
    {
      title: "Request a refill",
      description: "Request a refill for a COMPLETED or PARTIAL order whose service supports refill.",
      inputSchema: { orderId: z.string().regex(/^osmm_order_/) },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ orderId }) => {
      try {
        return ok(await core.requestRefill(orderId));
      } catch (err) {
        return fail(err);
      }
    },
  );

  return server;
}

/** Start the stdio server. Called by direct execution and by bin/opensmm.mjs. */
export async function serveStdio(): Promise<void> {
  const { createStackFromEnv } = await import("../../../bootstrap.ts");
  const { core, provider } = await createStackFromEnv();
  const server = createMcpServer(core);
  await server.connect(new StdioServerTransport());
  console.error(`OpenSMM 0.1.0 MCP server running on stdio (provider: ${provider.providerId})`);
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"));
if (isMain) {
  await serveStdio();
}
