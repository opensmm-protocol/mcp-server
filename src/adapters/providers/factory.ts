/**
 * Composition-root factory for provider self-registration (spec/v0 §10).
 * Builds the adapter for the requested dialect and runs the healthcheck:
 * a successful offer listing proves endpoint reachability, auth and catalog.
 */

import type { ProviderFactory } from "../../core/core.ts";
import type { OpenSmmProvider } from "../../core/provider-spi.ts";
import type { RegisterProviderInput } from "../../core/types.ts";
import { SmmV2Provider } from "./smm-v2/index.ts";
import { PROFILES } from "./smm-v2/profile.ts";
import { RestV1Provider } from "./rest-v1/index.ts";

/**
 * Build the adapter only — no healthcheck. Used by state restore, where a
 * temporarily unreachable provider must still come back (as SUSPENDED) and
 * the supervisor re-syncs it later.
 */
export function buildProviderAdapter(
  input: RegisterProviderInput,
  providerId: string,
): OpenSmmProvider {
  switch (input.adapter) {
    case "rest-v1":
      return new RestV1Provider({
        providerId,
        baseUrl: input.endpoint,
        apiKey: input.apiKey,
      });
    case "smm-v2": {
      const profileName = input.profile ?? "standard";
      if (!(profileName in PROFILES)) {
        throw new Error(
          `unknown smm-v2 profile "${profileName}" (available: ${Object.keys(PROFILES).join(", ")})`,
        );
      }
      return new SmmV2Provider({
        providerId,
        baseUrl: input.endpoint,
        apiKey: input.apiKey,
        profile: profileName as keyof typeof PROFILES,
      });
    }
    default:
      throw new Error(`unsupported adapter dialect: ${String((input as { adapter: unknown }).adapter)}`);
  }
}

export const defaultProviderFactory: ProviderFactory = async (input, providerId) => {
  const provider = buildProviderAdapter(input, providerId);
  const offers = await provider.listOffers();
  return { provider, offers };
};
