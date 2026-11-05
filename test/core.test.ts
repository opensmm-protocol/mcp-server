import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createDevStack } from "../src/bootstrap.ts";
import { OpenSmmError } from "../src/core/errors.ts";
import type { Order } from "../src/core/types.ts";

const SVC = "osmm_svc_tg_members_std";
const LINK = "https://t.me/example_channel";

async function pollUntil(
  fn: () => Promise<Order>,
  predicate: (o: Order) => boolean,
  attempts = 20,
): Promise<Order> {
  let last = await fn();
  for (let i = 0; i < attempts && !predicate(last); i++) {
    last = await fn();
  }
  return last;
}

describe("core vertical slice", () => {
  it("search → quote → order → payment → execution → completion", async () => {
    const { core } = createDevStack();

    const found = core.searchServices({ query: "members", platform: "telegram" });
    assert.equal(found.services.length, 1);
    assert.equal(found.services[0]!.serviceId, SVC);

    const quote = core.getQuote({ serviceId: SVC, quantity: 1000, link: LINK });
    assert.equal(quote.amount.value, "2.412000");
    assert.equal(quote.amount.currency, "USDC");
    assert.equal(quote.confirmationRequired, true);

    const { order: created } = await core.createOrder({
      quoteId: quote.quoteId,
      link: LINK,
      clientReference: "accept-1",
    });
    assert.equal(created.paymentStatus, "REQUIRES_PAYMENT");
    assert.equal(created.executionStatus, "NOT_STARTED");
    assert.ok(created.paymentIntentId);
    assert.equal(created.paymentRequirements?.[0]?.method, "mock");

    const intent = await core.settlePayment(created.paymentIntentId!);
    assert.equal(intent.status, "SETTLED");

    const final = await pollUntil(
      () => core.getOrder(created.orderId),
      (o) => o.executionStatus === "COMPLETED",
    );
    assert.equal(final.paymentStatus, "SETTLED");
    assert.equal(final.executionStatus, "COMPLETED");
  });

  it("computes amounts on integer micro-units (no float drift)", () => {
    const { core } = createDevStack();
    // 0.19/1000 * 500 = 0.095 — a value that famously breaks naive float math.
    const quote = core.getQuote({ serviceId: "osmm_svc_tg_post_views", quantity: 500, link: LINK });
    assert.equal(quote.amount.value, "0.075000");
    const big = core.getQuote({ serviceId: "osmm_svc_tiktok_views_eco", quantity: 1000000, link: LINK });
    assert.equal(big.amount.value, "200.000000");
  });

  it("rejects out-of-range quantities", () => {
    const { core } = createDevStack();
    assert.throws(
      () => core.getQuote({ serviceId: SVC, quantity: 10 }),
      (err: unknown) => err instanceof OpenSmmError && err.code === "VALIDATION_FAILED",
    );
  });
});

describe("idempotency and quotes", () => {
  it("same clientReference + same payload returns the same order", async () => {
    const { core } = createDevStack();
    const quote = core.getQuote({ serviceId: SVC, quantity: 1000, link: LINK });
    const first = await core.createOrder({ quoteId: quote.quoteId, link: LINK, clientReference: "k-1" });
    // consumed quote would normally block a second order — replay must win.
    const second = await core.createOrder({ quoteId: quote.quoteId, link: LINK, clientReference: "k-1" });
    assert.equal(second.order.orderId, first.order.orderId);
    assert.equal(second.replayed, true);
  });

  it("same clientReference + different payload → IDEMPOTENCY_CONFLICT", async () => {
    const { core } = createDevStack();
    const q1 = core.getQuote({ serviceId: SVC, quantity: 1000, link: LINK });
    await core.createOrder({ quoteId: q1.quoteId, link: LINK, clientReference: "k-2" });
    const q2 = core.getQuote({ serviceId: SVC, quantity: 2000, link: LINK });
    await assert.rejects(
      () => core.createOrder({ quoteId: q2.quoteId, link: LINK, quantity: 2000, clientReference: "k-2" }),
      (err: unknown) => err instanceof OpenSmmError && err.code === "IDEMPOTENCY_CONFLICT",
    );
  });

  it("expired quote → QUOTE_EXPIRED", async () => {
    const { core } = createDevStack();
    (core as unknown as { quoteTtlMs: number }).quoteTtlMs = -1;
    const quote = core.getQuote({ serviceId: SVC, quantity: 1000, link: LINK });
    await assert.rejects(
      () => core.createOrder({ quoteId: quote.quoteId, link: LINK, clientReference: "k-3" }),
      (err: unknown) => err instanceof OpenSmmError && err.code === "QUOTE_EXPIRED",
    );
  });

  it("quantity differing from the quote → QUOTE_MISMATCH", async () => {
    const { core } = createDevStack();
    const quote = core.getQuote({ serviceId: SVC, quantity: 1000, link: LINK });
    await assert.rejects(
      () => core.createOrder({ quoteId: quote.quoteId, link: LINK, quantity: 2000, clientReference: "k-4" }),
      (err: unknown) => err instanceof OpenSmmError && err.code === "QUOTE_MISMATCH",
    );
  });

  it("a consumed quote returns the original order instead of double-charging", async () => {
    const { core, provider } = createDevStack();
    const quote = core.getQuote({ serviceId: SVC, quantity: 1000, link: LINK });
    const first = await core.createOrder({ quoteId: quote.quoteId, link: LINK, clientReference: "k-5" });
    const second = await core.createOrder({ quoteId: quote.quoteId, link: LINK, clientReference: "k-5-other" });
    assert.equal(second.order.orderId, first.order.orderId);
    await core.settlePayment(first.order.paymentIntentId!);
    assert.equal(provider.getExecutionCount(), 1);
  });
});

describe("provider failure scenarios", () => {
  it("definitive provider rejection → execution ERROR, payment REFUNDING", async () => {
    const { core, provider } = createDevStack();
    const quote = core.getQuote({ serviceId: SVC, quantity: 1000, link: LINK });
    const { order } = await core.createOrder({ quoteId: quote.quoteId, link: LINK, clientReference: "f-1" });
    provider.failNextSubmission();
    await core.settlePayment(order.paymentIntentId!);
    const after = await core.getOrder(order.orderId);
    assert.equal(after.executionStatus, "ERROR");
    assert.equal(after.paymentStatus, "REFUNDING");
  });

  it("ambiguous submission → SUBMISSION_UNKNOWN, never blindly resubmitted", async () => {
    const { core, provider } = createDevStack();
    const quote = core.getQuote({ serviceId: SVC, quantity: 1000, link: LINK });
    const { order } = await core.createOrder({ quoteId: quote.quoteId, link: LINK, clientReference: "f-2" });
    provider.hangNextSubmission();
    await core.settlePayment(order.paymentIntentId!);
    const after = await core.getOrder(order.orderId);
    assert.equal(after.executionStatus, "SUBMISSION_UNKNOWN");
    // exactly one provider-side execution exists; polling must not create another
    assert.equal(provider.getExecutionCount(), 1);
  });

  it("cancel of an unpaid order", async () => {
    const { core } = createDevStack();
    const quote = core.getQuote({ serviceId: SVC, quantity: 1000, link: LINK });
    const { order } = await core.createOrder({ quoteId: quote.quoteId, link: LINK, clientReference: "f-3" });
    const canceled = await core.cancelOrder(order.orderId);
    assert.equal(canceled.executionStatus, "CANCELED");
    assert.equal(canceled.paymentStatus, "FAILED");
  });

  it("refill on a completed order", async () => {
    const { core } = createDevStack();
    const quote = core.getQuote({ serviceId: SVC, quantity: 1000, link: LINK });
    const { order } = await core.createOrder({ quoteId: quote.quoteId, link: LINK, clientReference: "f-4" });
    await core.settlePayment(order.paymentIntentId!);
    await pollUntil(() => core.getOrder(order.orderId), (o) => o.executionStatus === "COMPLETED");
    const refill = await core.requestRefill(order.orderId);
    assert.equal(refill.status, "REQUESTED");
    assert.ok(refill.refillId.startsWith("mock_refill_"));
  });
});
