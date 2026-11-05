import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MockProvider } from "../src/adapters/providers/mock/index.ts";
import { MOCK_CATALOG_VERSION, mockCatalogEntries } from "../src/adapters/providers/mock/seed.ts";
import { MockFacilitator, X402Rail } from "../src/adapters/payments/x402/index.ts";
import { InMemoryCatalog } from "../src/core/catalog.ts";
import { OpenSmmCore } from "../src/core/core.ts";
import { OpenSmmError } from "../src/core/errors.ts";
import type { Order } from "../src/core/types.ts";

const SVC = "osmm_svc_tg_members_std";
const LINK = "https://t.me/example_channel";
const PAY_TO = "0xGatewayReceiverAddress";

function createX402Stack(facilitator = new MockFacilitator()) {
  const provider = new MockProvider();
  const catalog = new InMemoryCatalog(mockCatalogEntries, MOCK_CATALOG_VERSION);
  const rail = new X402Rail({ payTo: PAY_TO, facilitator });
  const core = new OpenSmmCore({ catalog, providers: [provider], paymentMethods: ["x402"], rails: [rail] });
  return { core, provider, facilitator };
}

async function pollUntilComplete(core: OpenSmmCore, orderId: string): Promise<Order> {
  let order = await core.getOrder(orderId);
  for (let i = 0; i < 20 && order.executionStatus !== "COMPLETED"; i++) {
    order = await core.getOrder(orderId);
  }
  return order;
}

describe("x402 payment rail", () => {
  it("orders carry x402 payment requirements (network, asset, payTo, amount)", async () => {
    const { core } = createX402Stack();
    const quote = core.getQuote({ serviceId: SVC, quantity: 1000, link: LINK });
    const { order } = await core.createOrder({ quoteId: quote.quoteId, link: LINK, clientReference: "x-1" });
    const req = order.paymentRequirements?.[0];
    assert.equal(req?.method, "x402");
    assert.equal(req?.network, "eip155:84532");
    assert.equal(req?.asset, "USDC");
    assert.equal(req?.payTo, PAY_TO);
    assert.deepEqual(req?.amount, { value: "2.412000", currency: "USDC" });
  });

  it("a valid signed payload settles the intent and starts execution", async () => {
    const { core, facilitator } = createX402Stack();
    const quote = core.getQuote({ serviceId: SVC, quantity: 1000, link: LINK });
    const { order } = await core.createOrder({ quoteId: quote.quoteId, link: LINK, clientReference: "x-2" });

    const intent = await core.settlePayment(order.paymentIntentId!, {
      method: "x402",
      proof: { x402Version: 2, payload: { signature: "0xdeadbeef" } },
    });
    assert.equal(intent.status, "SETTLED");
    assert.equal(intent.settledWith, "x402");
    assert.match(intent.txHash ?? "", /^0xmocktx/);
    assert.equal(facilitator.seenPayloads.length, 1);

    const final = await pollUntilComplete(core, order.orderId);
    assert.equal(final.executionStatus, "COMPLETED");
    assert.equal(final.paymentStatus, "SETTLED");
  });

  it("a missing payload keeps the intent REQUIRES_PAYMENT", async () => {
    const { core } = createX402Stack();
    const quote = core.getQuote({ serviceId: SVC, quantity: 1000, link: LINK });
    const { order } = await core.createOrder({ quoteId: quote.quoteId, link: LINK, clientReference: "x-3" });
    await assert.rejects(
      () => core.settlePayment(order.paymentIntentId!, { method: "x402" }),
      (err: unknown) => err instanceof OpenSmmError && err.code === "PAYMENT_REQUIRED",
    );
    assert.equal(core.getPayment(order.paymentIntentId!).status, "REQUIRES_PAYMENT");
  });

  it("settlement_pending is not an error: poll settles later, no re-payment", async () => {
    const facilitator = new MockFacilitator();
    facilitator.scriptPending(1);
    const { core } = createX402Stack(facilitator);
    const quote = core.getQuote({ serviceId: SVC, quantity: 1000, link: LINK });
    const { order } = await core.createOrder({ quoteId: quote.quoteId, link: LINK, clientReference: "x-4" });

    const proof = { x402Version: 2, payload: { signature: "0xabc" } };
    const first = await core.settlePayment(order.paymentIntentId!, { method: "x402", proof });
    assert.equal(first.status, "SETTLEMENT_PENDING");
    // Execution must NOT start while settlement is pending.
    const mid = await core.getOrder(order.orderId);
    assert.equal(mid.executionStatus, "NOT_STARTED");
    assert.equal(mid.paymentStatus, "SETTLEMENT_PENDING");

    // Polling the same intent (same payload) settles — the facilitator saw it twice,
    // which is exactly the replay-safe retry, not a second payment.
    const second = await core.settlePayment(order.paymentIntentId!, { method: "x402", proof });
    assert.equal(second.status, "SETTLED");
    assert.equal(facilitator.seenPayloads.length, 2);

    const final = await pollUntilComplete(core, order.orderId);
    assert.equal(final.executionStatus, "COMPLETED");
  });

  it("facilitator rejection maps to PAYMENT_REQUIRED with the reason", async () => {
    const facilitator = new MockFacilitator();
    facilitator.verify = async () => ({ valid: false, reason: "insufficient funds" });
    const { core } = createX402Stack(facilitator);
    const quote = core.getQuote({ serviceId: SVC, quantity: 1000, link: LINK });
    const { order } = await core.createOrder({ quoteId: quote.quoteId, link: LINK, clientReference: "x-5" });
    await assert.rejects(
      () => core.settlePayment(order.paymentIntentId!, { method: "x402", proof: { bad: true } }),
      (err: unknown) =>
        err instanceof OpenSmmError && err.code === "PAYMENT_REQUIRED" && /insufficient funds/.test(err.message),
    );
    assert.equal(core.getPayment(order.paymentIntentId!).status, "REQUIRES_PAYMENT");
  });
});
