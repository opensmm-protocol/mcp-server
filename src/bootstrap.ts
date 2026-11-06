/**
 * Shared bootstrap.
 * Default: MockProvider with the curated mock catalog (local dev, tests).
 * If OPENSMM_REST_V1_BASE_URL + OPENSMM_REST_V1_API_KEY are set, the gateway
 * boots against a live rest-v1 provider with the catalog synced from its API.
 *
 * Env:
 *   OPENSMM_REST_V1_BASE_URL / OPENSMM_REST_V1_API_KEY — live provider config
 *   OPENSMM_PROVIDER_ID          — providerId override (default "rest-v1")
 *   OPENSMM_PROVIDER_LISTED_NAME — opt-in public displayName (spec/v0 §9)
 *   OPENSMM_PROVIDER_PAYOUT      — direct-settlement payTo address (spec/v0 §8)
 *   OPENSMM_ALLOW_PRIVATE_ENDPOINTS=1 — dev-only SSRF escape hatch
 *   OPENSMM_SYNC_INTERVAL_MS / OPENSMM_POLL_INTERVAL_MS — supervision cadence
 *   OPENSMM_SUPERVISOR=0       — disable background supervision (default: on
 *                                for live providers, off for the mock stack)
 *   OPENSMM_STATE_FILE         — path to the JSON state snapshot; when set,
 *                                state is restored on boot and autosaved
 *   OPENSMM_STATE_SAVE_MS      — autosave cadence (default 30000)
 *
 * x402 payment rail (when X402_FACILITATOR_URL is set, replaces the dev-only
 * mock rail — see docs/X402_TESTNET.md):
 *   X402_FACILITATOR_URL       — facilitator base URL (testnet:
 *                                https://x402.org/facilitator)
 *   X402_PAYTO_ADDRESS         — gateway's receiving address (required)
 *   X402_FACILITATOR_API_KEY   — Bearer token for auth-gated facilitators (CDP)
 *   X402_NETWORK               — CAIP-2 network (default eip155:84532, Base Sepolia)
 *   X402_USDC_ADDRESS          — USDC contract override (known: Base, Base Sepolia)
 */

import { InMemoryCatalog } from "./core/catalog.ts";
import { OpenSmmCore, type CoreOptions } from "./core/core.ts";
import type { OpenSmmProvider } from "./core/provider-spi.ts";
import { StateFile } from "./core/state-file.ts";
import { NodeSupervisor } from "./core/supervisor.ts";
import { MockProvider } from "./adapters/providers/mock/index.ts";
import { MOCK_CATALOG_VERSION, mockCatalogEntries } from "./adapters/providers/mock/seed.ts";
import { RestV1Provider } from "./adapters/providers/rest-v1/index.ts";
import { providerOfferToCatalogEntry } from "./core/catalog-map.ts";
import { buildProviderAdapter, defaultProviderFactory } from "./adapters/providers/factory.ts";
import { X402Rail } from "./adapters/payments/x402/index.ts";
import { HttpFacilitator } from "./adapters/payments/x402/facilitator-http.ts";

export interface DevStack {
  core: OpenSmmCore;
  provider: MockProvider;
  supervisor: NodeSupervisor;
}

export interface Stack {
  core: OpenSmmCore;
  provider: OpenSmmProvider;
  supervisor: NodeSupervisor;
  stateFile?: StateFile;
}

/**
 * When OPENSMM_STATE_FILE is set: restore orders/metrics/self-registered
 * nodes from the snapshot and start autosaving. The state file contains
 * provider credentials — it is written with mode 0600 (spec/v0 §10.3).
 */
async function attachPersistence(core: OpenSmmCore): Promise<StateFile | undefined> {
  const path = process.env.OPENSMM_STATE_FILE;
  if (!path) return undefined;
  const stateFile = new StateFile(path);
  const snapshot = stateFile.load();
  if (snapshot) {
    const { restoredNodes } = await core.importState(snapshot, buildProviderAdapter);
    if (restoredNodes > 0) {
      console.error(`opensmm: restored ${restoredNodes} node(s) from ${path}`);
    }
  }
  stateFile.startAutosave(
    () => core.exportState(),
    Number(process.env.OPENSMM_STATE_SAVE_MS ?? 30_000),
  );
  return stateFile;
}

function coreOptionsFromEnv(): Pick<CoreOptions, "providerFactory" | "ssrf"> {
  return {
    providerFactory: defaultProviderFactory,
    ssrf: { allowPrivate: process.env.OPENSMM_ALLOW_PRIVATE_ENDPOINTS === "1" },
  };
}

/**
 * When X402_FACILITATOR_URL is set, payments go through a real x402
 * facilitator and the dev-only mock rail is disabled. Without it the stack
 * keeps the mock rail, so local dev and tests never need keys.
 */
function paymentsFromEnv(): Pick<CoreOptions, "paymentMethods" | "rails"> {
  const facilitatorUrl = process.env.X402_FACILITATOR_URL;
  if (!facilitatorUrl) return { paymentMethods: ["mock"] };
  const payTo = process.env.X402_PAYTO_ADDRESS;
  if (!payTo) {
    throw new Error("X402_FACILITATOR_URL is set but X402_PAYTO_ADDRESS is missing");
  }
  const facilitator = new HttpFacilitator({
    url: facilitatorUrl,
    ...(process.env.X402_FACILITATOR_API_KEY
      ? { apiKey: process.env.X402_FACILITATOR_API_KEY }
      : {}),
    ...(process.env.X402_USDC_ADDRESS ? { usdcAddress: process.env.X402_USDC_ADDRESS } : {}),
  });
  const rail = new X402Rail({
    payTo,
    ...(process.env.X402_NETWORK ? { network: process.env.X402_NETWORK } : {}),
    facilitator,
  });
  return { paymentMethods: ["x402"], rails: [rail] };
}

export function createDevStack(): DevStack {
  const provider = new MockProvider();
  const catalog = new InMemoryCatalog(mockCatalogEntries, MOCK_CATALOG_VERSION);
  const core = new OpenSmmCore({
    catalog,
    providers: [provider],
    paymentMethods: ["mock"],
    ...coreOptionsFromEnv(),
  });
  // The mock stack is for local dev and tests: supervisor exists but is not started.
  const supervisor = new NodeSupervisor({
    registry: core.registry,
    catalog: core.catalog,
    pollActiveOrders: () => core.refreshActiveOrders(),
    runRetentionChecks: () => core.runRetentionChecks(),
  });
  return { core, provider, supervisor };
}

export async function createStackFromEnv(
  overrides: Partial<CoreOptions> = {},
): Promise<Stack> {
  const baseUrl = process.env.OPENSMM_REST_V1_BASE_URL;
  const apiKey = process.env.OPENSMM_REST_V1_API_KEY;
  if (!baseUrl || !apiKey) {
    const payments = paymentsFromEnv();
    if (!payments.rails) {
      const dev = createDevStack();
      const stateFile = await attachPersistence(dev.core);
      return { ...dev, ...(stateFile ? { stateFile } : {}) };
    }
    // Mock provider + real x402 payments: the testnet settlement shape.
    const provider = new MockProvider();
    const catalog = new InMemoryCatalog(mockCatalogEntries, MOCK_CATALOG_VERSION);
    const core = new OpenSmmCore({
      catalog,
      providers: [provider],
      ...payments,
      ...coreOptionsFromEnv(),
    });
    const supervisor = new NodeSupervisor({
      registry: core.registry,
      catalog: core.catalog,
      pollActiveOrders: () => core.refreshActiveOrders(),
      runRetentionChecks: () => core.runRetentionChecks(),
    });
    const stateFile = await attachPersistence(core);
    return { core, provider, supervisor, ...(stateFile ? { stateFile } : {}) };
  }

  const providerId = process.env.OPENSMM_PROVIDER_ID ?? "rest-v1";
  const provider = new RestV1Provider({ providerId, baseUrl, apiKey });
  const offers = await provider.listOffers();
  const catalog = new InMemoryCatalog(
    offers.map((offer) => providerOfferToCatalogEntry(offer, providerId)),
  );
  const listedName = process.env.OPENSMM_PROVIDER_LISTED_NAME;
  const payout = process.env.OPENSMM_PROVIDER_PAYOUT;
  const core = new OpenSmmCore({
    catalog,
    providers: [provider],
    ...paymentsFromEnv(),
    ...(process.env.OPENSMM_RETENTION_CHECK_MS
      ? { retentionCheckMs: Number(process.env.OPENSMM_RETENTION_CHECK_MS) }
      : {}),
    providerInfo: {
      [providerId]: {
        ...(listedName ? { displayName: listedName, publiclyListed: true } : {}),
        ...(payout ? { payoutAddress: payout } : {}),
      },
    },
    ...coreOptionsFromEnv(),
    ...overrides,
  });
  const supervisor = new NodeSupervisor({
    registry: core.registry,
    catalog: core.catalog,
    pollActiveOrders: () => core.refreshActiveOrders(),
    runRetentionChecks: () => core.runRetentionChecks(),
    ...(process.env.OPENSMM_SYNC_INTERVAL_MS
      ? { syncIntervalMs: Number(process.env.OPENSMM_SYNC_INTERVAL_MS) }
      : {}),
    ...(process.env.OPENSMM_POLL_INTERVAL_MS
      ? { pollIntervalMs: Number(process.env.OPENSMM_POLL_INTERVAL_MS) }
      : {}),
  });
  // Live provider: catalog drifts, nodes degrade — supervise by default.
  if (process.env.OPENSMM_SUPERVISOR !== "0") {
    supervisor.start();
  }
  const stateFile = await attachPersistence(core);
  return { core, provider, supervisor, ...(stateFile ? { stateFile } : {}) };
}
