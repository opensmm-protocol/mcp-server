/**
 * Composition-root factory for provider self-registration (spec/v0 §10).
 * Builds the adapter for the requested dialect and runs the healthcheck:
 * a successful offer listing proves endpoint reachability, auth and catalog.
 */

import type { ProviderFactory } from "../../core/core.ts";
import { SmmV2Provider } from "./smm-v2/index.ts";
import { PROFILES } from "./smm-v2/profile.ts";
import { RestV1Provider } from "./rest-v1/index.ts";

export const defaultProviderFactory: ProviderFactory = async (input, providerId) => {
  switch (input.adapter) {
    case "rest-v1": {
      const provider = new RestV1Provider({
        providerId,
        baseUrl: input.endpoint,
        apiKey: input.apiKey,
      });
      const offers = await provider.listOffers();
      return { provider, offers };
    }
    case "smm-v2": {
      const profileName = input.profile ?? "standard";
      if (!(profileName in PROFILES)) {
        throw new Error(
          `unknown smm-v2 profile "${profileName}" (available: ${Object.keys(PROFILES).join(", ")})`,
        );
      }
      const provider = new SmmV2Provider({
        providerId,
        baseUrl: input.endpoint,
        apiKey: input.apiKey,
        profile: profileName as keyof typeof PROFILES,
      });
      const offers = await provider.listOffers();
      return { provider, offers };
    }
    default:
      throw new Error(`unsupported adapter dialect: ${String((input as { adapter: unknown }).adapter)}`);
  }
};
