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
 *   OPENSMM_CURATED_CATALOG    — path to a curated public catalog JSON
 *                                (README «Public MVP»); when set it replaces
 *                                the dev seed / live sync as the served
 *                                catalog and disables background sync
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
import {
  assertCuratedProviders,
  CuratedCatalogError,
  loadCuratedCatalog,
  type LoadedCuratedCatalog,
} from "./core/curated-catalog.ts";

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
 * EIP-712 domain override for networks whose USDC contract is not in the
 * built-in table (paired with X402_USDC_ADDRESS). Both vars or neither.
 */
function eip712DomainFromEnv(): { name: string; version: string } | undefined {
  const name = process.env.X402_EIP712_DOMAIN_NAME;
  const version = process.env.X402_EIP712_DOMAIN_VERSION;
  if (!name && !version) return undefined;
  if (!name || !version) {
    throw new Error(
      "X402_EIP712_DOMAIN_NAME and X402_EIP712_DOMAIN_VERSION must be set together",
    );
  }
  return { name, version };
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
  const eip712Domain = eip712DomainFromEnv();
  const facilitator = new HttpFacilitator({
    url: facilitatorUrl,
    ...(process.env.X402_FACILITATOR_API_KEY
      ? { apiKey: process.env.X402_FACILITATOR_API_KEY }
      : {}),
    ...(process.env.X402_USDC_ADDRESS ? { usdcAddress: process.env.X402_USDC_ADDRESS } : {}),
    ...(eip712Domain ? { eip712Domain } : {}),
  });
  const rail = new X402Rail({
    payTo,
    ...(process.env.X402_NETWORK ? { network: process.env.X402_NETWORK } : {}),
    facilitator,
  });
  return { paymentMethods: ["x402"], rails: [rail] };
}

/**
 * Curated public catalog (README «Public MVP»). Optional: without
 * OPENSMM_CURATED_CATALOG the catalog is built exactly as before. A broken
 * file is fatal — a public catalog is either fully reviewed or not served.
 *
 * Example records are a stub for local development. `allowExamples` is false
 * as soon as a live provider is configured: a real gateway must not serve
 * placeholders that a buyer cannot tell apart from a sellable service.
 */
function curatedCatalogFromEnv(allowExamples: boolean): LoadedCuratedCatalog | undefined {
  const path = process.env.OPENSMM_CURATED_CATALOG;
  if (!path) return undefined;
  const loaded = loadCuratedCatalog(path);
  if (loaded.exampleCount === 0) return loaded;
  if (!allowExamples) {
    throw new CuratedCatalogError(path, [
      `contains ${loaded.exampleCount} example record(s); remove them before ` +
        "configuring a live provider (OPENSMM_REST_V1_BASE_URL)",
    ]);
  }
  console.error(
    `opensmm: curated catalog ${path} contains ${loaded.exampleCount} example record(s) — do not use in production`,
  );
  return loaded;
}

/**
 * Mock provider stack: local dev/tests, and the "mock provider + real x402"
 * testnet shape. One constructor so both branches cannot drift apart.
 */
function buildMockStack(
  payments: Pick<CoreOptions, "paymentMethods" | "rails">,
  curated?: LoadedCuratedCatalog,
): DevStack {
  const provider = new MockProvider();
  assertCuratedProviders(curated, [provider.providerId]);
  const catalog =
    curated?.catalog ?? new InMemoryCatalog(mockCatalogEntries, MOCK_CATALOG_VERSION);
  const core = new OpenSmmCore({
    catalog,
    providers: [provider],
    ...payments,
    ...coreOptionsFromEnv(),
  });
  // The mock stack is for local dev and tests: supervisor exists but is not started.
  const supervisor = new NodeSupervisor({
    registry: core.registry,
    catalog: core.catalog,
    pollActiveOrders: () => core.refreshActiveOrders(),
    runRetentionChecks: () => core.runRetentionChecks(),
    // A curated catalog is a reviewed snapshot: live sync must not overwrite it.
    ...(curated ? { syncCatalog: false } : {}),
  });
  return { core, provider, supervisor };
}

export function createDevStack(): DevStack {
  return buildMockStack({ paymentMethods: ["mock"] });
}

export async function createStackFromEnv(
  overrides: Partial<CoreOptions> = {},
): Promise<Stack> {
  const baseUrl = process.env.OPENSMM_REST_V1_BASE_URL;
  const apiKey = process.env.OPENSMM_REST_V1_API_KEY;
  // Example records are allowed only while no live provider is configured.
  const curated = curatedCatalogFromEnv(!(baseUrl && apiKey));
  if (!baseUrl || !apiKey) {
    const payments = paymentsFromEnv();
    if (!payments.rails && !curated) {
      const dev = createDevStack();
      const stateFile = await attachPersistence(dev.core);
      return { ...dev, ...(stateFile ? { stateFile } : {}) };
    }
    // Mock provider + real x402 payments: the testnet settlement shape.
    const stack = buildMockStack(payments, curated);
    const stateFile = await attachPersistence(stack.core);
    return { ...stack, ...(stateFile ? { stateFile } : {}) };
  }

  const providerId = process.env.OPENSMM_PROVIDER_ID ?? "rest-v1";
  const provider = new RestV1Provider({ providerId, baseUrl, apiKey });
  assertCuratedProviders(curated, [providerId]);
  // A curated catalog boots without any provider API call; the live sync
  // below is the alternative source of the same catalog.
  let catalog: InMemoryCatalog;
  if (curated) {
    catalog = curated.catalog;
  } else {
    const offers = await provider.listOffers();
    catalog = new InMemoryCatalog(
      offers.map((offer) => providerOfferToCatalogEntry(offer, providerId)),
    );
  }
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
    // A curated catalog is a reviewed snapshot: live sync must not overwrite it.
    ...(curated ? { syncCatalog: false } : {}),
  });
  // Live provider: catalog drifts, nodes degrade — supervise by default.
  if (process.env.OPENSMM_SUPERVISOR !== "0") {
    supervisor.start();
  }
  const stateFile = await attachPersistence(core);
  return { core, provider, supervisor, ...(stateFile ? { stateFile } : {}) };
}
