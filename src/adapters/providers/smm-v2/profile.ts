/**
 * SMM API v2 provider profiles.
 *
 * Most panels share one wire format (POST /api/v2, key+action, JSON responses),
 * but differ in semantics: what `rate` means, whether refill returns an id or a
 * success string, what `currency: "USD"` actually is. A profile captures those
 * deviations so onboarding a panel is baseUrl + apiKey + profile — and nothing
 * gets silently mispriced. Profile names describe BEHAVIOR, not vendors.
 */

export interface SmmV2Profile {
  /** Human-readable profile name, e.g. "standard", "extended". */
  name: string;

  /** Field carrying the API key. Almost always "key"; some panels accept api_key. */
  authField: "key" | "api_key";

  /** What `rate` in the services list means (some game top-up panels: per unit). */
  rateBasis: "PER_1000" | "PER_UNIT" | "PER_PACKAGE";

  /** What `currency` in balance/status responses actually is (some panels: tokens). */
  balanceKind: "fiat" | "provider_credits";

  /** Refill creation response shape: {"refill":"1"} vs {"success":"..."}. */
  refillResponse: "id" | "success_message";

  /** Cancel request takes "orders" (csv, standard) or a single "order". */
  cancelParameter: "orders" | "order";

  /** Field aliases in the services list (e.g. "Category", sometimes "services"). */
  serviceFields: {
    id: string[];
    category: string[];
    description: string[];
  };

  /** Extra raw service fields to preserve (e.g. desc, icon, speed, timelastorders). */
  preserveServiceFields?: string[];

  /** Panel-specific status strings beyond the common set, mapped to canonical ones. */
  extraStatusMap?: Record<string, "PENDING" | "IN_PROGRESS" | "PARTIAL" | "COMPLETED" | "CANCELED" | "ERROR">;

  /** Set false when refill/cancel is documented but not actually implemented. */
  supportsRefill: boolean;
  supportsCancel: boolean;
}

/** The common denominator shared by most panels. */
export const STANDARD_PROFILE: SmmV2Profile = {
  name: "standard",
  authField: "key",
  rateBasis: "PER_1000",
  balanceKind: "fiat",
  refillResponse: "id",
  cancelParameter: "orders",
  serviceFields: {
    id: ["service"],
    category: ["category", "Category"],
    description: ["description", "desc"],
  },
  supportsRefill: true,
  supportsCancel: true,
};

/** Panels exposing extra telemetry fields (desc, icon, speed, timelastorders). */
export const EXTENDED_FIELDS_PROFILE: SmmV2Profile = {
  ...STANDARD_PROFILE,
  name: "extended",
  preserveServiceFields: ["desc", "icon", "speed", "timelastorders"],
};

/** Refill & cancel answer {"success": "..."} (no refill id), single-order cancel param. */
export const SUCCESS_MESSAGE_PROFILE: SmmV2Profile = {
  ...STANDARD_PROFILE,
  name: "success-message",
  refillResponse: "success_message",
  cancelParameter: "order",
  serviceFields: {
    id: ["service", "services"],
    category: ["category", "Category"],
    description: ["description", "desc"],
  },
};

/** Standard + an extra terminal "Refunded" status. */
export const REFUNDED_STATUS_PROFILE: SmmV2Profile = {
  ...STANDARD_PROFILE,
  name: "refunded-status",
  extraStatusMap: { Refunded: "CANCELED" },
};

/** Rate is per unit (typical for game top-ups); link is a player/server id. */
export const PER_UNIT_PROFILE: SmmV2Profile = {
  ...STANDARD_PROFILE,
  name: "per-unit",
  rateBasis: "PER_UNIT",
  supportsRefill: false,
};

/** Balance currency is provider credits, not fiat; refill unimplemented. */
export const PROVIDER_CREDITS_PROFILE: SmmV2Profile = {
  ...STANDARD_PROFILE,
  name: "provider-credits",
  balanceKind: "provider_credits",
  supportsRefill: false,
};

export const PROFILES: Record<string, SmmV2Profile> = {
  standard: STANDARD_PROFILE,
  extended: EXTENDED_FIELDS_PROFILE,
  "success-message": SUCCESS_MESSAGE_PROFILE,
  "refunded-status": REFUNDED_STATUS_PROFILE,
  "per-unit": PER_UNIT_PROFILE,
  "provider-credits": PROVIDER_CREDITS_PROFILE,
};
