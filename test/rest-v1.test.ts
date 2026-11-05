import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { RestV1Provider } from "../src/adapters/providers/rest-v1/index.ts";
import { restV1OfferToCatalogEntry } from "../src/adapters/providers/rest-v1/catalog.ts";
import {
  ProviderRejectedError,
  SubmissionAmbiguousError,
} from "../src/core/provider-spi.ts";

type Responder = (url: string, init?: RequestInit) => { status?: number; body: unknown };

function makeProvider(responder: Responder) {
  const calls: { url: string; method: string; auth?: string; body?: unknown }[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    calls.push({
      url: String(url),
      method: init?.method ?? "GET",
      auth: headers.get("authorization") ?? undefined,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    const { status = 200, body } = responder(String(url), init);
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  const provider = new RestV1Provider({
    providerId: "test-node",
    baseUrl: "https://node.example/api/v1",
    apiKey: "secret-key",
    fetchImpl,
  });
  return { provider, calls };
}

const SERVICES_RESPONSE = {
  success: true,
  count: 2,
  services: [
    {
      service: 101,
      name: "Telegram Channel Members",
      type: "Default",
      category: "Telegram / Members",
      rate: "0.45",
      min: 100,
      max: 50000,
      description: "Fast start",
      price: 12,
      dripfeed: true,
      refill: true,
      cancel: false,
    },
    {
      service: 102,
      name: "Instagram Likes",
      type: "Default",
      category: "Instagram / Likes",
      rate: "0.10",
      min: 50,
      max: 5000,
      description: null,
      price: null,
      dripfeed: false,
      refill: false,
      cancel: true,
    },
  ],
};

describe("rest-v1 adapter: wire format", () => {
  it("sends Bearer auth and maps services into offers", async () => {
    const { provider, calls } = makeProvider(() => ({ body: SERVICES_RESPONSE }));
    const offers = await provider.listOffers();

    assert.equal(calls[0]!.url, "https://node.example/api/v1/services");
    assert.equal(calls[0]!.method, "GET");
    assert.equal(calls[0]!.auth, "Bearer secret-key");

    assert.equal(offers.length, 2);
    assert.equal(offers[0]!.externalServiceId, "101");
    assert.equal(offers[0]!.rate, "0.45");
    assert.equal(offers[0]!.rateBasis, "PER_1000");
    assert.equal(offers[0]!.currency, "USD");
    assert.equal(offers[0]!.minQuantity, 100);
    assert.equal(offers[0]!.maxQuantity, 50000);
    assert.equal(offers[0]!.dripfeed, true);
    assert.equal(offers[0]!.refill, true);
    assert.equal(offers[0]!.cancel, false);
  });

  it("posts service/link/quantity on order creation and returns the id", async () => {
    const { provider, calls } = makeProvider(() => ({
      status: 201,
      body: {
        success: true,
        order: { id: "ord_abc123", service: 101, status: "SUBMITTING" },
      },
    }));
    const ref = await provider.createExecution({
      externalServiceId: "101",
      link: "https://t.me/example",
      quantity: 1000,
    });

    assert.equal(calls[0]!.url, "https://node.example/api/v1/orders");
    assert.equal(calls[0]!.method, "POST");
    assert.deepEqual(calls[0]!.body, { service: 101, link: "https://t.me/example", quantity: 1000 });
    assert.equal(ref.externalExecutionId, "ord_abc123");
  });

  it("maps order statuses, preserving the raw value", async () => {
    const { provider, calls } = makeProvider(() => ({
      body: { id: "ord_abc123", status: "PROCESSING" },
    }));
    const snap = await provider.getExecution("ord_abc123");

    assert.equal(calls[0]!.url, "https://node.example/api/v1/orders/ord_abc123");
    assert.equal(snap.status, "IN_PROGRESS");
    assert.equal(snap.rawStatus, "PROCESSING");
  });

  it("maps every documented lifecycle status", async () => {
    const cases: [string, string][] = [
      ["AWAITING_PAYMENT", "PENDING"],
      ["SUBMITTING", "PENDING"],
      ["PENDING", "PENDING"],
      ["PROCESSING", "IN_PROGRESS"],
      ["PARTIAL", "PARTIAL"],
      ["COMPLETED", "COMPLETED"],
      ["CANCELED", "CANCELED"],
      ["ERROR", "ERROR"],
    ];
    for (const [raw, expected] of cases) {
      const { provider } = makeProvider(() => ({ body: { id: "x", status: raw } }));
      const snap = await provider.getExecution("x");
      assert.equal(snap.status, expected, `status ${raw}`);
    }
  });

  it("unknown statuses become UNKNOWN, never COMPLETED", async () => {
    const { provider } = makeProvider(() => ({ body: { id: "x", status: "WEIRD_NEW_STATUS" } }));
    const snap = await provider.getExecution("x");
    assert.equal(snap.status, "UNKNOWN");
    assert.equal(snap.rawStatus, "WEIRD_NEW_STATUS");
  });
});

describe("rest-v1 adapter: error semantics", () => {
  it("4xx with an error message is a definitive rejection", async () => {
    const { provider } = makeProvider(() => ({
      status: 402,
      body: { error: "Insufficient Stars balance. Need 100, have 5" },
    }));
    await assert.rejects(
      provider.createExecution({ externalServiceId: "101", link: "https://t.me/x", quantity: 1000 }),
      (err: unknown) => {
        assert.ok(err instanceof ProviderRejectedError);
        assert.match(err.message, /Insufficient/);
        return true;
      },
    );
  });

  it("401 is a definitive rejection (bad key)", async () => {
    const { provider } = makeProvider(() => ({
      status: 401,
      body: { error: "Unauthorized. Provide Bearer <apiKey>" },
    }));
    await assert.rejects(provider.listOffers(), ProviderRejectedError);
  });

  it("network failure on a mutation is ambiguous, never silently retried", async () => {
    const fetchImpl = (async () => {
      throw new Error("socket hang up");
    }) as typeof fetch;
    const provider = new RestV1Provider({
      providerId: "test-node",
      baseUrl: "https://node.example/api/v1",
      apiKey: "k",
      fetchImpl,
    });
    await assert.rejects(
      provider.createExecution({ externalServiceId: "101", link: "https://t.me/x", quantity: 1000 }),
      SubmissionAmbiguousError,
    );
  });

  it("5xx on a mutation is ambiguous", async () => {
    const { provider } = makeProvider(() => ({ status: 500, body: { error: "Internal server error" } }));
    await assert.rejects(
      provider.createExecution({ externalServiceId: "101", link: "https://t.me/x", quantity: 1000 }),
      SubmissionAmbiguousError,
    );
  });

  it("an order response without an id is ambiguous", async () => {
    const { provider } = makeProvider(() => ({ status: 201, body: { success: true } }));
    await assert.rejects(
      provider.createExecution({ externalServiceId: "101", link: "https://t.me/x", quantity: 1000 }),
      SubmissionAmbiguousError,
    );
  });
});

describe("rest-v1 catalog mapping", () => {
  it("infers platform and objective from category and name", async () => {
    const { provider } = makeProvider(() => ({ body: SERVICES_RESPONSE }));
    const offers = await provider.listOffers();

    const tg = restV1OfferToCatalogEntry(offers[0]!, "test-node");
    assert.equal(tg.service.platform, "telegram");
    assert.equal(tg.service.objective, "members");
    assert.equal(tg.service.serviceId, "osmm_svc_test-node_101");
    assert.deepEqual(tg.service.rate, { value: "0.45", currency: "USD" });

    const ig = restV1OfferToCatalogEntry(offers[1]!, "test-node");
    assert.equal(ig.service.platform, "instagram");
    assert.equal(ig.service.objective, "likes");
  });

  it("falls back to other/other for unrecognized text", () => {
    const entry = restV1OfferToCatalogEntry(
      {
        externalServiceId: "9",
        name: "Mystery Package Deluxe",
        rate: "1.00",
        rateBasis: "PER_1000",
        currency: "USD",
        minQuantity: 1,
        maxQuantity: 10,
        refill: false,
        cancel: false,
        dripfeed: false,
      },
      "test-node",
    );
    assert.equal(entry.service.platform, "other");
    assert.equal(entry.service.objective, "other");
  });
});
