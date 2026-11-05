import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SmmV2Provider } from "../src/adapters/providers/smm-v2/index.ts";
import {
  ProviderRejectedError,
  SubmissionAmbiguousError,
} from "../src/core/provider-spi.ts";

type Responder = (body: URLSearchParams) => unknown;

function makeProvider(responder: Responder, profile: string = "standard") {
  const calls: { url: string; body: URLSearchParams }[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = new URLSearchParams(String(init?.body ?? ""));
    calls.push({ url: String(url), body });
    const data = responder(body);
    return new Response(JSON.stringify(data), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  const provider = new SmmV2Provider({
    providerId: "test-panel",
    baseUrl: "https://panel.example/api/v2",
    apiKey: "secret-key",
    profile,
    fetchImpl,
  });
  return { provider, calls };
}

describe("smm-v2 adapter: wire format", () => {
  it("posts form-encoded key+action to /api/v2", async () => {
    const { provider, calls } = makeProvider(() => ({ balance: "10.00", currency: "USD" }));
    await provider.listOffers().catch(() => {});
    assert.equal(calls[0]!.url, "https://panel.example/api/v2");
    assert.equal(calls[0]!.body.get("key"), "secret-key");
    assert.equal(calls[0]!.body.get("action"), "services");
  });

  it("maps a standard services list into offers", async () => {
    const { provider } = makeProvider(() => [
      {
        service: 4905,
        name: "Telegram 0% Drop",
        type: "Default",
        category: "Telegram Members",
        rate: "0.19",
        min: "500",
        max: "100000",
        refill: true,
        cancel: false,
      },
    ]);
    const offers = await provider.listOffers();
    assert.equal(offers.length, 1);
    assert.equal(offers[0]!.externalServiceId, "4905");
    assert.equal(offers[0]!.rate, "0.19");
    assert.equal(offers[0]!.rateBasis, "PER_1000");
    assert.equal(offers[0]!.minQuantity, 500);
    assert.equal(offers[0]!.refill, true);
    assert.equal(offers[0]!.cancel, false);
  });

  it("understands field aliases (Category/services variants)", async () => {
    const { provider } = makeProvider(
      () => [{ services: 7, name: "X", Category: "Seo", rate: "1", min: "1", max: "9", refill: false, cancel: false }],
      "success-message",
    );
    const offers = await provider.listOffers();
    assert.equal(offers[0]!.externalServiceId, "7");
    assert.equal(offers[0]!.category, "Seo");
  });

  it("per-unit profile reports PER_UNIT pricing", async () => {
    const { provider } = makeProvider(
      () => [{ service: 1, name: "60 UC", rate: "0.85", min: "1", max: "1", refill: false, cancel: false }],
      "per-unit",
    );
    const offers = await provider.listOffers();
    assert.equal(offers[0]!.rateBasis, "PER_UNIT");
  });

  it("provider-credits profile flags balance as provider credits and disables refill", async () => {
    const { provider } = makeProvider(
      () => [{ service: 1, name: "X", rate: "1", min: "1", max: "9", refill: true, cancel: true }],
      "provider-credits",
    );
    const offers = await provider.listOffers();
    assert.equal(offers[0]!.currency, "PROVIDER_CREDITS");
    assert.equal(offers[0]!.refill, false);
    const caps = await provider.getCapabilities();
    assert.equal(caps.refill, false);
  });
});

describe("smm-v2 adapter: order submission", () => {
  it("add returns the external order id", async () => {
    const { provider, calls } = makeProvider(() => ({ order: 23501 }));
    const ref = await provider.createExecution({
      externalServiceId: "4905",
      link: "https://t.me/x",
      quantity: 1000,
    });
    assert.equal(ref.externalExecutionId, "23501");
    assert.equal(calls[0]!.body.get("action"), "add");
    assert.equal(calls[0]!.body.get("service"), "4905");
    assert.equal(calls[0]!.body.get("quantity"), "1000");
  });

  it("HTTP 200 with a definitive error → ProviderRejectedError (no retry ambiguity)", async () => {
    const { provider } = makeProvider(() => ({ error: "Not enough funds" }));
    await assert.rejects(
      () => provider.createExecution({ externalServiceId: "1", link: "x", quantity: 1 }),
      (err: unknown) => err instanceof ProviderRejectedError,
    );
  });

  it("network failure on add → SubmissionAmbiguousError (never blindly retried)", async () => {
    const fetchImpl = (async () => {
      throw new Error("socket hang up");
    }) as typeof fetch;
    const provider = new SmmV2Provider({
      providerId: "t",
      baseUrl: "https://panel.example/api/v2",
      apiKey: "k",
      profile: "standard",
      fetchImpl,
    });
    await assert.rejects(
      () => provider.createExecution({ externalServiceId: "1", link: "x", quantity: 1 }),
      (err: unknown) => err instanceof SubmissionAmbiguousError,
    );
  });

  it("unknown error on add → SubmissionAmbiguousError (cannot prove non-execution)", async () => {
    const { provider } = makeProvider(() => ({ error: "Upstream provider glitch" }));
    await assert.rejects(
      () => provider.createExecution({ externalServiceId: "1", link: "x", quantity: 1 }),
      (err: unknown) => err instanceof SubmissionAmbiguousError,
    );
  });

  it("non-JSON response on add → SubmissionAmbiguousError", async () => {
    const fetchImpl = (async () =>
      new Response("<html>Cloudflare</html>", { status: 200 })) as typeof fetch;
    const provider = new SmmV2Provider({
      providerId: "t",
      baseUrl: "https://panel.example/api/v2",
      apiKey: "k",
      profile: "standard",
      fetchImpl,
    });
    await assert.rejects(
      () => provider.createExecution({ externalServiceId: "1", link: "x", quantity: 1 }),
      (err: unknown) => err instanceof SubmissionAmbiguousError,
    );
  });
});

describe("smm-v2 adapter: statuses, refill, cancel", () => {
  it("maps documented statuses and parses remains", async () => {
    const { provider } = makeProvider(() => ({
      charge: "0.27819",
      start_count: "3572",
      status: "Partial",
      remains: "157",
      currency: "USD",
    }));
    const snap = await provider.getExecution("23501");
    assert.equal(snap.status, "PARTIAL");
    assert.equal(snap.rawStatus, "Partial");
    assert.equal(snap.startCount, 3572);
    assert.equal(snap.remains, 157);
  });

  it("unrecognized status → UNKNOWN with rawStatus preserved (never COMPLETED)", async () => {
    const { provider } = makeProvider(() => ({ status: "WeirdNewState", remains: "5" }));
    const snap = await provider.getExecution("1");
    assert.equal(snap.status, "UNKNOWN");
    assert.equal(snap.rawStatus, "WeirdNewState");
  });

  it("refunded-status profile maps the extra Refunded status", async () => {
    const { provider } = makeProvider(() => ({ status: "Refunded", remains: "0" }), "refunded-status");
    const snap = await provider.getExecution("1");
    assert.equal(snap.status, "CANCELED");
    assert.equal(snap.rawStatus, "Refunded");
  });

  it("standard refill returns the refill id", async () => {
    const { provider } = makeProvider(() => ({ refill: "1" }));
    const ref = await provider.requestRefill("23501");
    assert.equal(ref.externalRefillId, "1");
  });

  it("success-message refill is explicitly marked untrackable", async () => {
    const { provider } = makeProvider(
      () => ({ success: "Your order will be refill asap. Thank you for patience." }),
      "success-message",
    );
    const ref = await provider.requestRefill("23501");
    assert.equal(ref.externalRefillId, "untracked:23501");
  });

  it("cancel parses per-order results, including errors inside the batch", async () => {
    const responder = (body: URLSearchParams) =>
      body.get("action") === "cancel" && body.get("orders") === "2"
        ? [{ order: 2, cancel: 1 }]
        : [{ order: 9, cancel: { error: "Incorrect order ID" } }];
    const { provider } = makeProvider(responder);
    const ok = await provider.cancelExecution("2");
    assert.equal(ok.canceled, true);
    const bad = await provider.cancelExecution("9");
    assert.equal(bad.canceled, false);
    assert.match(bad.reason ?? "", /Incorrect order ID/);
  });

  it("success-message profile cancels a single order via order param", async () => {
    const { provider, calls } = makeProvider(() => ({ success: "canceled" }), "success-message");
    const result = await provider.cancelExecution("77");
    assert.equal(result.canceled, true);
    assert.equal(calls[0]!.body.get("order"), "77");
    assert.equal(calls[0]!.body.get("orders"), null);
  });
});
