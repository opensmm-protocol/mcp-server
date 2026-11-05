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
 */

import { InMemoryCatalog } from "./core/catalog.ts";
import { OpenSmmCore, type CoreOptions } from "./core/core.ts";
import type { OpenSmmProvider } from "./core/provider-spi.ts";
import { MockProvider } from "./adapters/providers/mock/index.ts";
import { MOCK_CATALOG_VERSION, mockCatalogEntries } from "./adapters/providers/mock/seed.ts";
import { RestV1Provider } from "./adapters/providers/rest-v1/index.ts";
import { providerOfferToCatalogEntry } from "./core/catalog-map.ts";
import { defaultProviderFactory } from "./adapters/providers/factory.ts";

export interface DevStack {
  core: OpenSmmCore;
  provider: MockProvider;
}

export interface Stack {
  core: OpenSmmCore;
  provider: OpenSmmProvider;
}

function coreOptionsFromEnv(): Pick<CoreOptions, "providerFactory" | "ssrf"> {
  return {
    providerFactory: defaultProviderFactory,
    ssrf: { allowPrivate: process.env.OPENSMM_ALLOW_PRIVATE_ENDPOINTS === "1" },
  };
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
  return { core, provider };
}

export async function createStackFromEnv(
  overrides: Partial<CoreOptions> = {},
): Promise<Stack> {
  const baseUrl = process.env.OPENSMM_REST_V1_BASE_URL;
  const apiKey = process.env.OPENSMM_REST_V1_API_KEY;
  if (!baseUrl || !apiKey) {
    return createDevStack();
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
    paymentMethods: ["mock"],
    providerInfo: {
      [providerId]: {
        ...(listedName ? { displayName: listedName, publiclyListed: true } : {}),
        ...(payout ? { payoutAddress: payout } : {}),
      },
    },
    ...coreOptionsFromEnv(),
    ...overrides,
  });
  return { core, provider };
}
