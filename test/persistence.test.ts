import assert from "node:assert/strict";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { InMemoryCatalog } from "../src/core/catalog.ts";
import { OpenSmmCore, type CoreSnapshot } from "../src/core/core.ts";
import { StateFile } from "../src/core/state-file.ts";
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

const PUBLIC_DNS = async () => [{ address: "93.184.216.34", family: 4 }];

class StubProvider implements OpenSmmProvider {
  readonly providerId: string;

  constructor(providerId: string) {
    this.providerId = providerId;
  }

  async getCapabilities(): Promise<ProviderCapabilities> {
    return { cancel: false, refill: false, batchStatus: false };
  }

  async listOffers(): Promise<ProviderOffer[]> {
    return [
      {
        externalServiceId: "svc-1",
        name: `${this.providerId} Telegram Members`,
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
  }

  async createExecution(_input: CanonicalExecutionInput): Promise<ExecutionReference> {
    return { externalExecutionId: `${this.providerId}-exec-1` };
  }

  async getExecution(): Promise<ExecutionSnapshot> {
    return { status: "COMPLETED", rawStatus: "Completed", delivered: 100, remains: 0 };
  }
}

async function stackWithRegisteredNode() {
  const core = new OpenSmmCore({
    catalog: new InMemoryCatalog(mockCatalogEntries),
    providers: [new MockProvider()],
    paymentMethods: ["mock"],
    ssrf: { lookup: PUBLIC_DNS },
    providerFactory: async (_input, providerId) => {
      const provider = new StubProvider(providerId);
      return { provider, offers: await provider.listOffers() };
    },
  });
  const reg = await core.registerProvider({
    adapter: "rest-v1",
    endpoint: "https://stub.example/api/v1",
    apiKey: "secret-key",
  });

  const entry = core.catalog.list().find((e) => e.providerId !== "mock")!;
  const service = entry.service;
  const quote = core.getQuote({ serviceId: service.serviceId, quantity: 100, link: "https://t.me/x" });
  const { order } = await core.createOrder({
    quoteId: quote.quoteId,
    link: "https://t.me/x",
    clientReference: "persist-1",
  });
  await core.settlePayment(order.paymentIntentId!);
  await core.getOrder(order.orderId);
  return { core, order, reg };
}

describe("state persistence", () => {
  it("StateFile round-trips a snapshot atomically with 0600 perms", () => {
    const dir = mkdtempSync(join(tmpdir(), "opensmm-state-"));
    const file = new StateFile(join(dir, "nested", "state.json"));
    assert.equal(file.load(), undefined); // missing file is fine

    const snapshot: CoreSnapshot = {
      format: 1,
      savedAt: new Date().toISOString(),
      quotes: [],
      orders: [],
      payments: [],
      executions: [],
      refills: [],
      idempotency: [],
      metrics: {},
      nodes: [],
    };
    file.save(snapshot);
    assert.equal(statSync(file.path).mode & 0o777, 0o600);
    assert.deepEqual(file.load(), snapshot);
  });

  it("orders, idempotency, metrics and self-registered nodes survive a restart", async () => {
    const { core: core1, order, reg } = await stackWithRegisteredNode();
    assert.equal(order.executionStatus, "COMPLETED");
    const before = await core1.listProviders();
    const nodeBefore = before.providers.find((p) => p.providerKey === reg.providerKey)!;
    assert.equal(nodeBefore.metrics.sampleSize, 1);

    const snapshot = core1.exportState();

    // "Restart": a fresh core with a fresh catalog, no bootstrap knowledge.
    const core2 = new OpenSmmCore({
      catalog: new InMemoryCatalog(mockCatalogEntries),
      providers: [new MockProvider()],
      paymentMethods: ["mock"],
      ssrf: { lookup: PUBLIC_DNS },
    });
    const { restoredNodes } = await core2.importState(
      snapshot,
      (_input, providerId) => new StubProvider(providerId),
    );
    assert.equal(restoredNodes, 1);

    // The order survived with its idempotent identity.
    const restored = await core2.getOrder(order.orderId);
    assert.equal(restored.orderId, order.orderId);
    assert.equal(restored.executionStatus, "COMPLETED");

    // Replay of the same clientReference + same (restored) quote returns the
    // original order — no second charge, no second execution.
    const { order: replayed, replayed: wasReplayed } = await core2.createOrder({
      quoteId: order.quoteId,
      link: "https://t.me/x",
      clientReference: "persist-1",
    });
    assert.equal(wasReplayed, true);
    assert.equal(replayed.orderId, order.orderId);

    // Pseudonymous key and gateway-measured metrics are stable across restarts.
    const after = await core2.listProviders();
    const nodeAfter = after.providers.find((p) => p.providerKey === reg.providerKey)!;
    assert.equal(nodeAfter.metrics.sampleSize, 1);

    // The restored node is routable: its offers are back in the catalog.
    const restoredEntry = core2.catalog.list().find((e) => e.providerId !== "mock");
    assert.ok(restoredEntry);
    assert.ok(core2.searchServices({ query: "Telegram Members" }).services.length > 0);
  });

  it("an unreachable node at boot comes back SUSPENDED, not lost", async () => {
    const { core: core1 } = await stackWithRegisteredNode();
    const snapshot = core1.exportState();

    const core2 = new OpenSmmCore({
      catalog: new InMemoryCatalog(mockCatalogEntries),
      providers: [new MockProvider()],
      paymentMethods: ["mock"],
      ssrf: { lookup: PUBLIC_DNS },
    });
    class DeadProvider extends StubProvider {
      override async listOffers(): Promise<ProviderOffer[]> {
        throw new Error("connection refused");
      }
    }
    await core2.importState(snapshot, (_input, providerId) => new DeadProvider(providerId));

    const node = core2.registry.list().find((n) => n.providerId !== "mock")!;
    assert.equal(node.lifecycle, "SUSPENDED");
    // Its order history survived even though the node itself is down.
    const orderId = core2.exportState().orders[0]!.orderId;
    assert.equal((await core2.getOrder(orderId)).orderId, orderId);
  });
});
