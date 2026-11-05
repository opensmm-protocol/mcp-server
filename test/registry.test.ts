import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { OpenSmmCore, type ProviderFactory } from "../src/core/core.ts";
import { InMemoryCatalog, type CatalogEntry } from "../src/core/catalog.ts";
import { OpenSmmError } from "../src/core/errors.ts";
import { assertPublicProviderUrl, isPrivateAddress } from "../src/core/ssrf-guard.ts";
import { MockFacilitator, X402Rail } from "../src/adapters/payments/x402/index.ts";
import type {
  CanonicalExecutionInput,
  ExecutionReference,
  ExecutionSnapshot,
  OpenSmmProvider,
  ProviderCapabilities,
  ProviderOffer,
} from "../src/core/provider-spi.ts";

class StubProvider implements OpenSmmProvider {
  readonly providerId: string;
  created: CanonicalExecutionInput[] = [];

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
        category: "Telegram / Members",
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

  async createExecution(input: CanonicalExecutionInput): Promise<ExecutionReference> {
    this.created.push(input);
    return { externalExecutionId: `${this.providerId}-exec-${this.created.length}` };
  }

  async getExecution(): Promise<ExecutionSnapshot> {
    return { status: "COMPLETED", rawStatus: "Completed" };
  }
}

function entryFor(providerId: string, suffix: string): CatalogEntry {
  return {
    providerId,
    externalServiceId: "svc-1",
    service: {
      serviceId: `osmm_svc_${providerId}_${suffix}`,
      name: `${providerId} service`,
      platform: "telegram",
      objective: "members",
      rate: { value: "1.00", currency: "USD" },
      rateBasis: "PER_1000",
      minQuantity: 10,
      maxQuantity: 1000,
      parameters: [],
      capabilities: { refill: false, cancel: false, dripfeed: false },
      status: "ACTIVE",
    },
  };
}

const PUBLIC_DNS = async () => [{ address: "93.184.216.34", family: 4 }];

describe("SSRF guard", () => {
  it("accepts a public https endpoint resolving to a public IP", async () => {
    const url = await assertPublicProviderUrl("https://node.example/api/v2", { lookup: PUBLIC_DNS });
    assert.equal(url.hostname, "node.example");
  });

  it("rejects non-https endpoints", async () => {
    await assert.rejects(
      assertPublicProviderUrl("http://node.example/api", { lookup: PUBLIC_DNS }),
      /https/,
    );
  });

  it("rejects loopback, link-local and private hostnames/IPs", async () => {
    const blocked = [
      "https://localhost/api",
      "https://foo.local/api",
      "https://127.0.0.1/api",
      "https://169.254.169.254/latest/meta-data",
      "https://192.168.1.1/api",
      "https://10.0.0.5/api",
      "https://[::1]/api",
    ];
    for (const endpoint of blocked) {
      await assert.rejects(
        assertPublicProviderUrl(endpoint, { lookup: PUBLIC_DNS }),
        /rejected|public|resolve/i,
        endpoint,
      );
    }
  });

  it("rejects a public hostname that resolves to a private IP (DNS pinning check)", async () => {
    const sneakyDns = async () => [{ address: "10.1.2.3", family: 4 }];
    await assert.rejects(
      assertPublicProviderUrl("https://innocent-looking.example/api", { lookup: sneakyDns }),
      /non-public/,
    );
  });

  it("allowPrivate is an explicit dev-only escape hatch", async () => {
    const url = await assertPublicProviderUrl("http://localhost:3000/api/v1", {
      allowPrivate: true,
    });
    assert.equal(url.hostname, "localhost");
  });

  it("isPrivateAddress classifies edge ranges", () => {
    assert.equal(isPrivateAddress("100.64.0.1"), true); // CGNAT
    assert.equal(isPrivateAddress("100.63.255.255"), false);
    assert.equal(isPrivateAddress("172.16.0.1"), true);
    assert.equal(isPrivateAddress("172.32.0.1"), false);
    assert.equal(isPrivateAddress("::ffff:192.168.0.1"), true); // v4-mapped
    assert.equal(isPrivateAddress("8.8.8.8"), false);
    assert.equal(isPrivateAddress("2606:4700:4700::1111"), false);
  });
});

describe("registerProvider", () => {
  it("is denied when the gateway has no provider factory", async () => {
    const core = new OpenSmmCore({
      catalog: new InMemoryCatalog([]),
      providers: [new StubProvider("base")],
    });
    await assert.rejects(
      core.registerProvider({ adapter: "rest-v1", endpoint: "https://x.example", apiKey: "k" }),
      (err: unknown) => {
        assert.ok(err instanceof OpenSmmError);
        assert.equal(err.code, "POLICY_DENIED");
        return true;
      },
    );
  });

  it("rejects SSRF-blocked endpoints before touching the factory", async () => {
    let factoryCalls = 0;
    const factory: ProviderFactory = async () => {
      factoryCalls += 1;
      throw new Error("must not be called");
    };
    const core = new OpenSmmCore({
      catalog: new InMemoryCatalog([]),
      providers: [new StubProvider("base")],
      providerFactory: factory,
    });
    await assert.rejects(
      core.registerProvider({ adapter: "rest-v1", endpoint: "https://169.254.169.254/", apiKey: "k" }),
      (err: unknown) => {
        assert.ok(err instanceof OpenSmmError);
        assert.equal(err.code, "POLICY_DENIED");
        return true;
      },
    );
    assert.equal(factoryCalls, 0);
  });

  it("a failed healthcheck registers nothing", async () => {
    const factory: ProviderFactory = async () => {
      throw new Error("connection refused");
    };
    const core = new OpenSmmCore({
      catalog: new InMemoryCatalog([]),
      providers: [new StubProvider("base")],
      providerFactory: factory,
      ssrf: { lookup: PUBLIC_DNS },
    });
    await assert.rejects(
      core.registerProvider({ adapter: "rest-v1", endpoint: "https://dead.example", apiKey: "k" }),
      (err: unknown) => {
        assert.ok(err instanceof OpenSmmError);
        assert.equal(err.code, "PROVIDER_REJECTED");
        assert.match(err.message, /healthcheck/);
        return true;
      },
    );
    const { providers } = await core.listProviders();
    assert.equal(providers.length, 1); // only the bootstrap provider
  });

  it("registers, syncs the catalog and is idempotent per endpoint", async () => {
    const factory: ProviderFactory = async (_input, providerId) => {
      const provider = new StubProvider(providerId);
      const offers = await provider.listOffers();
      return { provider, offers };
    };
    const catalog = new InMemoryCatalog([]);
    const core = new OpenSmmCore({
      catalog,
      providers: [new StubProvider("base")],
      providerFactory: factory,
      ssrf: { lookup: PUBLIC_DNS },
    });

    const first = await core.registerProvider({
      adapter: "rest-v1",
      endpoint: "https://node-a.example/api/v1",
      apiKey: "secret",
    });
    assert.equal(first.lifecycle, "UNVERIFIED");
    assert.equal(first.offersCount, 1);
    assert.match(first.providerKey, /^provider-/);

    // Catalog now serves the new provider's offers.
    const found = core.searchServices({ query: "telegram" });
    assert.ok(found.services.some((s) => s.name.includes("Telegram Members")));
    assert.equal(found.catalogVersion, first.catalogVersion);

    // Re-registration of the same endpoint returns the same node, no duplicates.
    const second = await core.registerProvider({
      adapter: "rest-v1",
      endpoint: "https://node-a.example/api/v1",
      apiKey: "secret",
    });
    assert.equal(second.providerKey, first.providerKey);
    const { providers } = await core.listProviders();
    assert.equal(providers.length, 2);
  });
});

describe("multi-provider routing and direct settlement", () => {
  it("executes on the provider that owns the catalog entry", async () => {
    const providerA = new StubProvider("prov-a");
    const providerB = new StubProvider("prov-b");
    const catalog = new InMemoryCatalog([entryFor("prov-a", "a"), entryFor("prov-b", "b")]);
    const core = new OpenSmmCore({ catalog, providers: [providerA, providerB] });

    const quote = core.getQuote({ serviceId: "osmm_svc_prov-b_b", quantity: 100, link: "https://t.me/x" });
    const { order } = await core.createOrder({
      quoteId: quote.quoteId,
      link: "https://t.me/x",
      clientReference: "route-1",
    });
    await core.settlePayment(order.paymentIntentId!);

    assert.equal(providerA.created.length, 0);
    assert.equal(providerB.created.length, 1);
    assert.equal(providerB.created[0]!.externalServiceId, "svc-1");
  });

  it("the provider's payoutAddress becomes the x402 payTo (direct settlement)", async () => {
    const provider = new StubProvider("prov-pay");
    const catalog = new InMemoryCatalog([entryFor("prov-pay", "p")]);
    const rail = new X402Rail({ payTo: "0xGatewayDefault", facilitator: new MockFacilitator() });
    const core = new OpenSmmCore({
      catalog,
      providers: [provider],
      paymentMethods: ["x402"],
      rails: [rail],
      providerInfo: { "prov-pay": { payoutAddress: "0xProviderWallet" } },
    });

    const quote = core.getQuote({ serviceId: "osmm_svc_prov-pay_p", quantity: 100, link: "https://t.me/x" });
    const { order } = await core.createOrder({
      quoteId: quote.quoteId,
      link: "https://t.me/x",
      clientReference: "pay-1",
    });
    const requirement = order.paymentRequirements!.find((r) => r.method === "x402")!;
    assert.equal(requirement.payTo, "0xProviderWallet");
  });

  it("without a payoutAddress the rail default payTo is used", async () => {
    const provider = new StubProvider("prov-nopay");
    const catalog = new InMemoryCatalog([entryFor("prov-nopay", "p")]);
    const rail = new X402Rail({ payTo: "0xGatewayDefault", facilitator: new MockFacilitator() });
    const core = new OpenSmmCore({
      catalog,
      providers: [provider],
      paymentMethods: ["x402"],
      rails: [rail],
    });

    const quote = core.getQuote({ serviceId: "osmm_svc_prov-nopay_p", quantity: 100, link: "https://t.me/x" });
    const { order } = await core.createOrder({
      quoteId: quote.quoteId,
      link: "https://t.me/x",
      clientReference: "pay-2",
    });
    const requirement = order.paymentRequirements!.find((r) => r.method === "x402")!;
    assert.equal(requirement.payTo, "0xGatewayDefault");
  });
});
