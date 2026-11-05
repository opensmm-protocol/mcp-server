import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createDevStack } from "../src/bootstrap.ts";
import { createRestHandler } from "../src/adapters/inbound/rest/handler.ts";
import { createMcpServer } from "../src/adapters/inbound/mcp/server.ts";

const SVC = "osmm_svc_tg_members_std";
const LINK = "https://t.me/example_channel";

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

  it("capabilities match across transports", async () => {
    const viaRest = await rest("/v0/capabilities");
    const viaMcp = await mcpCall("get_capabilities", {});
    assert.equal(viaRest.status, 200);
    assert.deepEqual(viaMcp, viaRest.body);
    assert.equal(viaRest.body.protocolVersion, "0.1.0-draft");
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
  });

  it("MCP exposes exactly the 10 protocol tools", async () => {
    const { tools } = await mcpClient.listTools();
    assert.deepEqual(
      tools.map((t) => t.name).sort(),
      [
        "cancel_order",
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
});
