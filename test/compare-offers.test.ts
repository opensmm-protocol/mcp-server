import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MockProvider } from "../src/adapters/providers/mock/index.ts";
import type { CatalogEntry } from "../src/core/catalog.ts";
import { InMemoryCatalog } from "../src/core/catalog.ts";
import { OpenSmmCore } from "../src/core/core.ts";
import type {
  ExecutionReference,
  ExecutionSnapshot,
  OpenSmmProvider,
  ProviderCapabilities,
  ProviderOffer,
} from "../src/core/provider-spi.ts";
import type { Service } from "../src/core/types.ts";

function makeService(serviceId: string, rate: string, overrides: Partial<Service> = {}): Service {
  return {
    serviceId,
    name: serviceId,
    platform: "telegram",
    objective: "members",
    rate: { value: rate, currency: "USDC" },
    rateBasis: "PER_1000",
    minQuantity: 100,
    maxQuantity: 50000,
    parameters: [],
    capabilities: { refill: false, cancel: false, dripfeed: false },
    status: "ACTIVE",
    ...overrides,
  };
}

function makeEntry(providerId: string, service: Service, externalServiceId: string): CatalogEntry {
  return { providerId, externalServiceId, service };
}

/** Second provider node: catalog-only, no execution behavior needed here. */
class StubProvider implements OpenSmmProvider {
  readonly providerId: string;
  constructor(providerId: string) {
    this.providerId = providerId;
  }
  async getCapabilities(): Promise<ProviderCapabilities> {
    return { cancel: false, refill: false, batchStatus: false };
  }
  async listOffers(): Promise<ProviderOffer[]> {
    return [];
  }
  async createExecution(): Promise<ExecutionReference> {
    throw new Error("not implemented");
  }
  async getExecution(): Promise<ExecutionSnapshot> {
    throw new Error("not implemented");
  }
}

/** Two providers offering the same telegram/members service at different rates. */
function createTwoProviderCore(): OpenSmmCore {
  const catalog = new InMemoryCatalog(
    [
      makeEntry(
        "mock",
        makeService("osmm_svc_tg_members_std", "2.400000", { maxQuantity: 100000 }),
        "1001",
      ),
      makeEntry(
        "mock-2",
        makeService("osmm_svc_tg_members_eco", "1.800000", { qualityTier: "economy" }),
        "2001",
      ),
    ],
    "2026-11-08T00:00:00Z",
  );
  return new OpenSmmCore({
    catalog,
    providers: [new MockProvider(), new StubProvider("mock-2")],
  });
}

describe("search_services enrichment", () => {
  it("two providers with one service each → two offers, each with providerRef + quality", () => {
    const core = createTwoProviderCore();
    const { services } = core.searchServices({ platform: "telegram", objective: "members" });
    assert.equal(services.length, 2);
    const refs = services.map((s) => s.providerRef).sort();
    assert.deepEqual(refs, ["provider-alpha", "provider-beta"]);
    for (const s of services) {
      assert.ok(s.quality, "quality must be present on every offer");
      assert.equal(s.quality.orders, 0);
    }
  });

  it("sort=price orders offers by normalized unit price, cheapest first", () => {
    const core = createTwoProviderCore();
    const { services } = core.searchServices({
      platform: "telegram",
      objective: "members",
      sort: "price",
    });
    assert.deepEqual(
      services.map((s) => s.rate.value),
      ["1.800000", "2.400000"],
    );
  });

  it("sort=quality orders by measured quality, best first", () => {
    const core = createTwoProviderCore();
    // provider-alpha (mock): half of the units dropped; slow start.
    core.metrics.recordTerminal("mock", "COMPLETED", { orderedUnits: 1000, deliveredUnits: 500 });
    core.metrics.recordStart("mock", 60);
    // provider-beta (mock-2): full delivery; fast start.
    core.metrics.recordTerminal("mock-2", "COMPLETED", { orderedUnits: 1000, deliveredUnits: 1000 });
    core.metrics.recordStart("mock-2", 10);

    const { services } = core.searchServices({
      platform: "telegram",
      objective: "members",
      sort: "quality",
    });
    assert.equal(services[0]!.providerRef, "provider-beta");
    assert.ok(services[0]!.quality);
    assert.equal(services[0]!.quality.deliveredRatio, 1);
    assert.equal(services[0]!.quality.startLatencyMs, 10000);
    assert.equal(services[1]!.providerRef, "provider-alpha");
    assert.ok(services[1]!.quality);
    assert.equal(services[1]!.quality.deliveredRatio, 0.5);
  });

  it("default sort keeps the catalog order (relevance)", () => {
    const core = createTwoProviderCore();
    const { services } = core.searchServices({ platform: "telegram", objective: "members" });
    assert.deepEqual(
      services.map((s) => s.serviceId),
      ["osmm_svc_tg_members_std", "osmm_svc_tg_members_eco"],
    );
  });

  it("SUSPENDED node is excluded from search results", () => {
    const core = createTwoProviderCore();
    core.registry.setLifecycle("mock-2", "SUSPENDED");
    const { services } = core.searchServices({ platform: "telegram", objective: "members" });
    assert.equal(services.length, 1);
    assert.equal(services[0]!.providerRef, "provider-alpha");
  });
});

describe("compare_offers", () => {
  it("returns one offer per provider, cheapest first, with total for quantity", () => {
    const core = createTwoProviderCore();
    const result = core.compareOffers({ platform: "telegram", objective: "members", quantity: 1000 });
    assert.equal(result.offers.length, 2);
    assert.equal(result.offers[0]!.providerRef, "provider-beta");
    assert.equal(result.offers[0]!.quantityPriced, 1000);
    assert.equal(result.offers[0]!.total.value, "1.800000");
    assert.equal(result.offers[1]!.providerRef, "provider-alpha");
    assert.equal(result.offers[1]!.total.value, "2.400000");
    for (const offer of result.offers) {
      assert.equal(offer.quality.orders, 0);
    }
  });

  it("single provider → one offer, no crash", () => {
    const core = createTwoProviderCore();
    core.registry.setLifecycle("mock-2", "SUSPENDED");
    const result = core.compareOffers({ platform: "telegram", objective: "members", quantity: 1000 });
    assert.equal(result.offers.length, 1);
    assert.equal(result.offers[0]!.providerRef, "provider-alpha");
    assert.equal(result.offers[0]!.total.value, "2.400000");
  });

  it("empty result when nothing matches the platform/objective", () => {
    const core = createTwoProviderCore();
    const result = core.compareOffers({ platform: "vk", objective: "likes", quantity: 100 });
    assert.equal(result.offers.length, 0);
  });

  it("SUSPENDED node is excluded from compare_offers", () => {
    const core = createTwoProviderCore();
    core.registry.setLifecycle("mock-2", "SUSPENDED");
    const result = core.compareOffers({ platform: "telegram", objective: "members" });
    assert.equal(result.offers.length, 1);
    // Without a quantity each offer is priced at its own service minimum.
    assert.equal(result.offers[0]!.quantityPriced, 100);
  });

  it("provider that cannot deliver the quantity is skipped", () => {
    const core = createTwoProviderCore();
    // mock-2 caps at 50000; ask for more — only provider-alpha remains.
    const result = core.compareOffers({ platform: "telegram", objective: "members", quantity: 60000 });
    assert.equal(result.offers.length, 1);
    assert.equal(result.offers[0]!.providerRef, "provider-alpha");
  });
});
