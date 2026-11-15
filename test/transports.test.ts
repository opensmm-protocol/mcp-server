import assert from "node:assert/strict";
import fs from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Ajv2020 } from "ajv/dist/2020.js";
import { createDevStack } from "../src/bootstrap.ts";
import { createRestHandler } from "../src/adapters/inbound/rest/handler.ts";
import { createMcpServer } from "../src/adapters/inbound/mcp/server.ts";

const SVC = "osmm_svc_tg_members_std";
const LINK = "https://t.me/example_channel";

// spec/v0 §5: both transports answer with the same canonical error body.
const errorSchema = JSON.parse(
  fs.readFileSync(path.resolve(import.meta.dirname, "../spec/v0/schemas/error.json"), "utf8"),
);
const validateError = new Ajv2020({ allErrors: true }).compile(errorSchema);

describe("REST and MCP are one protocol", () => {
  let server: Server;
  let baseUrl: string;
  let mcpClient: Client;
  const stack = createDevStack();

  before(async () => {
    server = createServer((req, res) => void createRestHandler(stack.core)(req, res));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const mcpServer = createMcpServer(stack.core);
    await mcpServer.connect(serverTransport);
    mcpClient = new Client({ name: "acceptance-test", version: "0.0.1" });
    await mcpClient.connect(clientTransport);
  });

  after(async () => {
    await mcpClient.close();
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  });

  async function rest(path: string, init?: RequestInit): Promise<{ status: number; body: any }> {
    const res = await fetch(`${baseUrl}${path}`, init);
    return { status: res.status, body: await res.json() };
  }

  async function mcpCall(name: string, args: Record<string, unknown>): Promise<any> {
    const result = await mcpClient.callTool({ name, arguments: args });
    return result.structuredContent;
  }

  /** Payment intents attached to an order: a replay must never add a second one. */
  function paymentIntentsFor(orderId: string) {
    return stack.core.exportState().payments.filter((p) => p.orderId === orderId);
  }

  function assertCanonicalError(body: unknown): void {
    assert.ok(validateError(body), JSON.stringify(validateError.errors));
  }

  it("capabilities match across transports", async () => {
    const viaRest = await rest("/v0/capabilities");
    const viaMcp = await mcpCall("get_capabilities", {});
    assert.equal(viaRest.status, 200);
    assert.deepEqual(viaMcp, viaRest.body);
    assert.equal(viaRest.body.protocolVersion, "0.1.0");
  });

  it("the acceptance flow works end-to-end over pure REST", async () => {
    const found = await rest("/v0/services?query=members&platform=telegram");
    assert.equal(found.body.services[0].serviceId, SVC);

    const quote = await rest("/v0/quotes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ serviceId: SVC, quantity: 1000, link: LINK }),
    });
    assert.equal(quote.status, 201);
    assert.equal(quote.body.amount.value, "2.412000");

    const created = await rest("/v0/orders", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "rest-flow-1" },
      body: JSON.stringify({ quoteId: quote.body.quoteId, link: LINK }),
    });
    // spec §7: 402 carries the Order body
    assert.equal(created.status, 402);
    assert.equal(created.body.paymentStatus, "REQUIRES_PAYMENT");
    assert.equal(created.body.paymentRequirements[0].method, "mock");

    // replay with the same Idempotency-Key: same order, no second charge, 200
    const replay = await rest("/v0/orders", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "rest-flow-1" },
      body: JSON.stringify({ quoteId: quote.body.quoteId, link: LINK }),
    });
    assert.equal(replay.status, 200);
    assert.equal(replay.body.orderId, created.body.orderId);

    const settled = await rest(`/v0/payments/${created.body.paymentIntentId}/settle`, {
      method: "POST",
    });
    assert.equal(settled.body.status, "SETTLED");

    let order = created.body;
    for (let i = 0; i < 20 && order.executionStatus !== "COMPLETED"; i++) {
      order = (await rest(`/v0/orders/${created.body.orderId}`)).body;
    }
    assert.equal(order.executionStatus, "COMPLETED");
    assert.equal(order.paymentStatus, "SETTLED");
  });

  it("REST and MCP return the same orderId for the same clientReference", async () => {
    const quoteMcp = await mcpCall("get_quote", { serviceId: SVC, quantity: 500, link: LINK });
    const orderMcp = await mcpCall("create_order", {
      quoteId: quoteMcp.quoteId,
      link: LINK,
      clientReference: "shared-key-1",
    });
    assert.match(orderMcp.orderId, /^osmm_order_/);

    // Repeat via REST with the same key as Idempotency-Key header:
    const orderRest = await rest("/v0/orders", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "shared-key-1" },
      body: JSON.stringify({ quoteId: quoteMcp.quoteId, link: LINK }),
    });
    assert.equal(orderRest.status, 200);
    assert.equal(orderRest.body.orderId, orderMcp.orderId);
    // No second charge: the replay reuses the original payment intent.
    assert.equal(orderRest.body.paymentIntentId, orderMcp.paymentIntentId);
    assert.equal(paymentIntentsFor(orderMcp.orderId).length, 1);

    // And the other way around: REST first, MCP replay second.
    const quoteRest = await rest("/v0/quotes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ serviceId: SVC, quantity: 700, link: LINK }),
    });
    const orderRest2 = await rest("/v0/orders", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "shared-key-2" },
      body: JSON.stringify({ quoteId: quoteRest.body.quoteId, link: LINK }),
    });
    const orderMcp2 = await mcpCall("create_order", {
      quoteId: quoteRest.body.quoteId,
      link: LINK,
      clientReference: "shared-key-2",
    });
    assert.equal(orderMcp2.orderId, orderRest2.body.orderId);
    assert.equal(orderMcp2.paymentIntentId, orderRest2.body.paymentIntentId);
    assert.equal(paymentIntentsFor(orderRest2.body.orderId).length, 1);
  });

  it("the same clientReference with a different body is IDEMPOTENCY_CONFLICT across transports", async () => {
    // REST first, then MCP with the same key and different order parameters.
    const restQuote = await rest("/v0/quotes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ serviceId: SVC, quantity: 1000, link: LINK }),
    });
    const restOrder = await rest("/v0/orders", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "conflict-key-rest" },
      body: JSON.stringify({ quoteId: restQuote.body.quoteId, link: LINK }),
    });
    assert.equal(restOrder.status, 402);

    const mcpQuote = await mcpCall("get_quote", { serviceId: SVC, quantity: 2000, link: LINK });
    const viaMcp: any = await mcpClient.callTool({
      name: "create_order",
      arguments: {
        quoteId: mcpQuote.quoteId,
        link: LINK,
        quantity: 2000,
        clientReference: "conflict-key-rest",
      },
    });
    assert.equal(viaMcp.isError, true);
    assertCanonicalError(viaMcp.structuredContent);
    assert.equal(viaMcp.structuredContent.error.code, "IDEMPOTENCY_CONFLICT");
    // The conflict creates nothing: one order, one payment intent.
    assert.equal(paymentIntentsFor(restOrder.body.orderId).length, 1);
    assert.equal(
      (await rest(`/v0/orders/${restOrder.body.orderId}`)).body.paymentIntentId,
      restOrder.body.paymentIntentId,
    );

    // MCP first, then REST with the same key sent as a body clientReference.
    const mcpQuote2 = await mcpCall("get_quote", { serviceId: SVC, quantity: 500, link: LINK });
    const mcpOrder = await mcpCall("create_order", {
      quoteId: mcpQuote2.quoteId,
      link: LINK,
      clientReference: "conflict-key-mcp",
    });
    const restQuote2 = await rest("/v0/quotes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ serviceId: SVC, quantity: 2000, link: LINK }),
    });
    const viaRest = await rest("/v0/orders", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        quoteId: restQuote2.body.quoteId,
        link: LINK,
        quantity: 2000,
        clientReference: "conflict-key-mcp",
      }),
    });
    assert.equal(viaRest.status, 409);
    assertCanonicalError(viaRest.body);
    assert.equal(viaRest.body.error.code, "IDEMPOTENCY_CONFLICT");
    assert.equal(paymentIntentsFor(mcpOrder.orderId).length, 1);
  });

  it("MCP exposes exactly the 11 protocol tools", async () => {
    const { tools } = await mcpClient.listTools();
    assert.deepEqual(
      tools.map((t) => t.name).sort(),
      [
        "cancel_order",
        "compare_offers",
        "create_order",
        "get_capabilities",
        "get_order_status",
        "get_quote",
        "get_service",
        "list_providers",
        "register_provider",
        "request_refill",
        "search_services",
      ],
    );
  });

  it("compare_offers rejects a currency code longer than 16 chars (ZHC-416)", async () => {
    // The catalog caps currency codes at 16 chars (core/curated-catalog.ts); the
    // MCP schema must reject longer input instead of answering with an empty list.
    const result: any = await mcpClient.callTool({
      name: "compare_offers",
      arguments: { platform: "telegram", objective: "members", currency: "X".repeat(17) },
    });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /currency/);
  });

  it("providers are pseudonymous by default and match across transports", async () => {
    const viaRest = await rest("/v0/providers");
    const viaMcp = await mcpCall("list_providers", {});
    assert.equal(viaRest.status, 200);
    assert.deepEqual(viaMcp, viaRest.body);
    const provider = viaRest.body.providers[0];
    assert.equal(provider.providerKey, "provider-alpha");
    assert.equal(provider.displayName, undefined);
    assert.equal(provider.lifecycle, "ACTIVE");
    // Metrics are gateway-measured; earlier tests in this suite completed orders.
    assert.equal(typeof provider.metrics.sampleSize, "number");
    assert.ok(provider.offersCount > 0);
  });

  it("unknown routes and ids produce canonical errors", async () => {
    const notFound = await rest("/v0/orders/osmm_order_doesnotexist");
    assert.equal(notFound.status, 404);
    assert.equal(notFound.body.error.code, "NOT_FOUND");

    const badQuote = await rest("/v0/quotes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ serviceId: "nope", quantity: 1 }),
    });
    assert.equal(badQuote.status, 400);
    assert.equal(badQuote.body.error.code, "VALIDATION_FAILED");
  });

  it("health endpoints answer 200 with status and uptime on both paths", async () => {
    for (const path of ["/health", "/v0/health"]) {
      const res = await fetch(`${baseUrl}${path}`);
      assert.equal(res.status, 200);
      assert.match(res.headers.get("content-type") ?? "", /^application\/json/);
      assert.equal(res.headers.get("access-control-allow-origin"), "*");
      const body = (await res.json()) as Record<string, unknown>;
      assert.equal(body.status, "ok");
      assert.equal(body.version, "0.1.0");
      assert.equal(typeof body.uptime, "number");
    }

    // Browsers and monitoring UIs probe with a preflight first.
    const preflight = await fetch(`${baseUrl}/health`, {
      method: "OPTIONS",
      headers: { origin: "https://opensmm.dev" },
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("access-control-allow-origin"), "*");
  });

  it("REST answers CORS preflight and marks JSON responses cross-origin readable", async () => {
    const res = await fetch(`${baseUrl}/v0/services`, {
      method: "OPTIONS",
      headers: { origin: "https://opensmm.dev" },
    });
    assert.equal(res.status, 204);
    assert.equal(res.headers.get("access-control-allow-origin"), "*");

    const get = await fetch(`${baseUrl}/v0/capabilities`);
    assert.equal(get.headers.get("access-control-allow-origin"), "*");
  });
});
