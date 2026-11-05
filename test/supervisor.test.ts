import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { OpenSmmCore } from "../src/core/core.ts";
import { InMemoryCatalog } from "../src/core/catalog.ts";
import { OpenSmmError } from "../src/core/errors.ts";
import { providerOfferToCatalogEntry } from "../src/core/catalog-map.ts";
import { NodeSupervisor } from "../src/core/supervisor.ts";
import { MockProvider } from "../src/adapters/providers/mock/index.ts";
import { mockCatalogEntries } from "../src/adapters/providers/mock/seed.ts";
import type {
  CanonicalExecutionInput,
  ExecutionReference,
  ExecutionSnapshot,
  OpenSmmProvider,
  ProviderCapabilities,
  ProviderOffer,
} from "../src/core/provider-spi.ts";

/** A provider whose offer list and availability are scriptable. */
class FlakyProvider implements OpenSmmProvider {
  readonly providerId = "flaky";
  offers: ProviderOffer[] = [
    {
      externalServiceId: "svc-1",
      name: "Flaky Telegram Members",
      rate: "1.00",
      rateBasis: "PER_1000",
      currency: "USD",
      minQuantity: 10,
      maxQuantity: 1000,
      refill: false,
      cancel: false,
      dripfeed: false,
    },
  ];
  healthy = true;

  async getCapabilities(): Promise<ProviderCapabilities> {
    return { cancel: false, refill: false, batchStatus: false };
  }

  async listOffers(): Promise<ProviderOffer[]> {
    if (!this.healthy) throw new Error("upstream timeout");
    return this.offers;
  }

  async createExecution(_input: CanonicalExecutionInput): Promise<ExecutionReference> {
    return { externalExecutionId: "flaky-exec-1" };
  }

  async getExecution(): Promise<ExecutionSnapshot> {
    return { status: "COMPLETED", rawStatus: "Completed" };
  }
}

function coreWithMock(retentionCheckMs?: number) {
  const provider = new MockProvider();
  const catalog = new InMemoryCatalog(mockCatalogEntries);
  const core = new OpenSmmCore({
    catalog,
    providers: [provider],
    paymentMethods: ["mock"],
    ...(retentionCheckMs !== undefined ? { retentionCheckMs } : {}),
  });
  const supervisor = new NodeSupervisor({
    registry: core.registry,
    catalog: core.catalog,
    pollActiveOrders: () => core.refreshActiveOrders(),
  });
  return { core, provider, catalog, supervisor };
}

async function createPaidOrder(core: OpenSmmCore, clientReference: string) {
  const service = core.searchServices({}).services[0]!;
  const quote = core.getQuote({
    serviceId: service.serviceId,
    quantity: service.minQuantity,
    link: "https://t.me/example",
  });
  const { order } = await core.createOrder({
    quoteId: quote.quoteId,
    link: "https://t.me/example",
    clientReference,
  });
  await core.settlePayment(order.paymentIntentId!);
  return order;
}

describe("gateway-measured metrics (spec §9)", () => {
  it("a completed order produces real metrics in listProviders", async () => {
    const { core } = coreWithMock();
    const order = await createPaidOrder(core, "m-1");
    // Poll to completion via the background path, not getOrder.
    for (let i = 0; i < 5; i++) await core.refreshActiveOrders();
    assert.equal(order.executionStatus, "COMPLETED");

    const { providers } = await core.listProviders();
    const metrics = providers[0]!.metrics;
    assert.equal(metrics.sampleSize, 1);
    assert.equal(metrics.deliveredRatio, 1);
    assert.equal(metrics.errorRate, 0);
    assert.equal(typeof metrics.measuredStartP50Sec, "number");
    assert.equal(typeof metrics.measuredCompletionP50Sec, "number");
  });

  it("a definitive provider rejection counts as an error outcome", async () => {
    const { core, provider } = coreWithMock();
    provider.failNextSubmission("bad link");
    const order = await createPaidOrder(core, "m-2");
    assert.equal(order.executionStatus, "ERROR");

    const { providers } = await core.listProviders();
    const metrics = providers[0]!.metrics;
    assert.equal(metrics.sampleSize, 1);
    assert.equal(metrics.errorRate, 1);
    assert.equal(metrics.deliveredRatio, 0);
  });

  it("a fresh provider publishes only sampleSize, never fabricated rates", async () => {
    const { core } = coreWithMock();
    const { providers } = await core.listProviders();
    assert.deepEqual(providers[0]!.metrics, { sampleSize: 0 });
  });
});

describe("node supervision (spec §10.4)", () => {
  function coreWithFlaky() {
    const provider = new FlakyProvider();
    const catalog = new InMemoryCatalog(
      provider.offers.map((o) => providerOfferToCatalogEntry(o, "flaky")),
    );
    const core = new OpenSmmCore({ catalog, providers: [provider], paymentMethods: ["mock"] });
    const supervisor = new NodeSupervisor({
      registry: core.registry,
      catalog: core.catalog,
      failureThreshold: 3,
    });
    return { core, provider, catalog, supervisor };
  }

  it("sync refreshes the catalog when provider offers change", async () => {
    const { core, provider, catalog, supervisor } = coreWithFlaky();
    const versionBefore = catalog.version;
    provider.offers = [
      ...provider.offers,
      {
        externalServiceId: "svc-2",
        name: "Flaky YouTube Views",
        rate: "0.50",
        rateBasis: "PER_1000",
        currency: "USD",
        minQuantity: 100,
        maxQuantity: 10000,
        refill: false,
        cancel: false,
        dripfeed: false,
      },
    ];
    const [report] = await supervisor.tickSyncAll();
    assert.equal(report!.ok, true);
    assert.equal(report!.offersCount, 2);
    assert.notEqual(catalog.version, versionBefore);
    assert.ok(core.searchServices({ query: "youtube" }).services.length === 1);
  });

  it("three consecutive sync failures suspend the node; recovery reactivates it", async () => {
    const { core, provider, supervisor } = coreWithFlaky();
    provider.healthy = false;

    await supervisor.tickSyncAll();
    await supervisor.tickSyncAll();
    assert.equal(core.registry.get("flaky")!.lifecycle, "ACTIVE");
    assert.equal(supervisor.consecutiveFailures("flaky"), 2);

    await supervisor.tickSyncAll();
    assert.equal(core.registry.get("flaky")!.lifecycle, "SUSPENDED");

    // SUSPENDED: excluded from search and new quotes (spec §10.1).
    assert.equal(core.searchServices({}).services.length, 0);
    const entry = core.catalog.list()[0]!;
    assert.throws(
      () => core.getQuote({ serviceId: entry.service.serviceId, quantity: 10, link: "https://t.me/x" }),
      (err: unknown) => {
        assert.ok(err instanceof OpenSmmError);
        assert.equal(err.code, "SERVICE_UNAVAILABLE");
        return true;
      },
    );

    // The provider heals: one successful sync reactivates the node.
    provider.healthy = true;
    const [report] = await supervisor.tickSyncAll();
    assert.equal(report!.ok, true);
    assert.equal(core.registry.get("flaky")!.lifecycle, "ACTIVE");
    assert.equal(supervisor.consecutiveFailures("flaky"), 0);
    assert.ok(core.searchServices({}).services.length > 0);
  });

  it("tickPoll drives in-flight orders without client polling", async () => {
    const { core, supervisor } = coreWithMock();
    const order = await createPaidOrder(core, "m-3");
    assert.equal(order.executionStatus, "PENDING");

    let refreshed = 0;
    for (let i = 0; i < 5; i++) refreshed = await supervisor.tickPoll();
    assert.equal(order.executionStatus, "COMPLETED");
    assert.equal(refreshed, 0); // terminal orders are no longer polled
  });

  it("retentionD7 is measured by delayed re-checks after completion (spec §9.1)", async () => {
    const { core, provider } = coreWithMock(0); // retention due immediately
    const order = await createPaidOrder(core, "ret-1");
    for (let i = 0; i < 5; i++) await core.refreshActiveOrders();
    assert.equal(order.executionStatus, "COMPLETED");

    // No retention data yet.
    let { providers } = await core.listProviders();
    assert.equal(providers[0]!.metrics.retentionD7, undefined);

    // Half the delivered volume dropped after completion.
    provider.setDeliveredDrop(0.5);
    const checked = await core.runRetentionChecks();
    assert.equal(checked, 1);

    ({ providers } = await core.listProviders());
    assert.equal(providers[0]!.metrics.retentionD7, 0.5);

    // Each order is re-checked exactly once.
    assert.equal(await core.runRetentionChecks(), 0);
  });
});

/** A provider that completes instantly and reports full delivery. */
class DeliveringProvider implements OpenSmmProvider {
  readonly providerId: string;
  private readonly quantities = new Map<string, number>();
  private seq = 0;

  constructor(providerId: string) {
    this.providerId = providerId;
  }

  async getCapabilities(): Promise<ProviderCapabilities> {
    return { cancel: false, refill: false, batchStatus: false };
  }

  async listOffers(): Promise<ProviderOffer[]> {
    return [
      {
        externalServiceId: "svc-big",
        name: "Delivering Telegram Members",
        rate: "1.00",
        rateBasis: "PER_1000",
        currency: "USD",
        minQuantity: 10,
        maxQuantity: 1_000_000,
        refill: false,
        cancel: false,
        dripfeed: false,
      },
    ];
  }

  async createExecution(input: CanonicalExecutionInput): Promise<ExecutionReference> {
    const id = `${this.providerId}-exec-${++this.seq}`;
    this.quantities.set(id, input.quantity);
    return { externalExecutionId: id };
  }

  async getExecution(externalExecutionId: string): Promise<ExecutionSnapshot> {
    return {
      status: "COMPLETED",
      rawStatus: "Completed",
      remains: 0,
      delivered: this.quantities.get(externalExecutionId) ?? 0,
    };
  }
}

const PUBLIC_DNS = async () => [{ address: "93.184.216.34", family: 4 }];

describe("verification tier (spec §10.1)", () => {
  async function registerDelivering(core: OpenSmmCore): Promise<string> {
    const result = await core.registerProvider({
      adapter: "rest-v1",
      endpoint: "https://delivering.example/api/v1",
      apiKey: "secret",
    });
    const { providers } = await core.listProviders();
    return providers.find((p) => p.providerKey === result.providerKey)!.providerKey;
  }

  function coreWithFactory() {
    let lastProvider: DeliveringProvider | undefined;
    const core = new OpenSmmCore({
      catalog: new InMemoryCatalog(mockCatalogEntries),
      providers: [new MockProvider()],
      paymentMethods: ["mock"],
      ssrf: { lookup: PUBLIC_DNS },
      providerFactory: async (_input, providerId) => {
        const provider = new DeliveringProvider(providerId);
        lastProvider = provider;
        return { provider, offers: await provider.listOffers() };
      },
    });
    return { core, getProvider: () => lastProvider };
  }

  it("UNVERIFIED nodes are volume-capped; the cap lifts on promotion", async () => {
    const { core } = coreWithFactory();
    await registerDelivering(core);
    const service = core.searchServices({ query: "delivering" }).services[0]!;
    const nodeId = core.catalog.get(service.serviceId)!.providerId;
    assert.equal(core.registry.get(nodeId)!.lifecycle, "UNVERIFIED");

    // 100_000 units × $1.00/1k = $100 — over the default $50 cap.
    assert.throws(
      () => core.getQuote({ serviceId: service.serviceId, quantity: 100_000, link: "https://t.me/x" }),
      (err: unknown) => {
        assert.ok(err instanceof OpenSmmError);
        assert.equal(err.code, "POLICY_DENIED");
        return true;
      },
    );

    // Within the cap the node is routable; five good orders promote it.
    for (let i = 0; i < 5; i++) {
      const quote = core.getQuote({ serviceId: service.serviceId, quantity: 1000, link: "https://t.me/x" });
      assert.ok(quote.warnings.some((w) => w.includes("UNVERIFIED")));
      const { order } = await core.createOrder({
        quoteId: quote.quoteId,
        link: "https://t.me/x",
        clientReference: `verify-${i}`,
      });
      await core.settlePayment(order.paymentIntentId!);
      await core.getOrder(order.orderId);
      assert.equal(order.executionStatus, "COMPLETED");
    }
    assert.equal(core.registry.get(nodeId)!.lifecycle, "ACTIVE");

    // Cap lifted: the $100 quote now succeeds.
    const big = core.getQuote({ serviceId: service.serviceId, quantity: 100_000, link: "https://t.me/x" });
    assert.equal(big.amount.value, "100.000000");
  });

  it("an ACTIVE node with measured errorRate > 0.5 is demoted to SUSPENDED", async () => {
    const { core, provider } = coreWithMock();
    for (let i = 0; i < 10; i++) {
      provider.failNextSubmission("bad link");
      const order = await createPaidOrder(core, `fail-${i}`);
      assert.equal(order.executionStatus, "ERROR");
    }
    const metrics = core.metrics.snapshot("mock");
    assert.equal(metrics.sampleSize, 10);
    assert.equal(metrics.errorRate, 1);
    assert.equal(core.registry.get("mock")!.lifecycle, "SUSPENDED");

    // Demoted: out of search and quotes.
    assert.equal(core.searchServices({}).services.length, 0);
  });
});
