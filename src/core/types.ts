/**
 * OpenSMM Protocol v0.1 canonical model.
 * Mirrors spec/v0/schemas/*. Transport-agnostic: no MCP/REST/A2A imports allowed here.
 */

export interface Money {
  /** Decimal string, e.g. "2.412000". Never a float. */
  value: string;
  /** ISO 4217 / asset code, or PROVIDER_CREDITS. */
  currency: string;
}

export type RateBasis = "PER_1000" | "PER_UNIT" | "PER_PACKAGE";

export type Platform =
  | "telegram"
  | "instagram"
  | "youtube"
  | "tiktok"
  | "x"
  | "vk"
  | "other";

export type Objective =
  | "followers"
  | "members"
  | "likes"
  | "views"
  | "reactions"
  | "comments"
  | "other";

export interface ServiceParameter {
  name: string;
  type: "string" | "string_list" | "integer" | "boolean";
  required: boolean;
  description?: string;
}

export interface Service {
  serviceId: string;
  name: string;
  description?: string;
  platform: Platform;
  objective: Objective;
  category?: string;
  rate: Money;
  rateBasis: RateBasis;
  minQuantity: number;
  maxQuantity: number;
  qualityTier?: "economy" | "standard" | "premium";
  parameters: ServiceParameter[];
  capabilities: { refill: boolean; cancel: boolean; dripfeed: boolean };
  status: "ACTIVE" | "DISABLED";
}

export interface Quote {
  quoteId: string;
  serviceId: string;
  quantity: number;
  link?: string;
  amount: Money;
  catalogVersion: string;
  expiresAt: string;
  createdAt: string;
  warnings: string[];
  confirmationRequired: boolean;
}

export const PAYMENT_STATUSES = [
  "NOT_REQUIRED",
  "REQUIRES_PAYMENT",
  "VERIFYING",
  "SETTLEMENT_PENDING",
  "SETTLED",
  "FAILED",
  "REFUNDING",
  "REFUNDED",
] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export const EXECUTION_STATUSES = [
  "NOT_STARTED",
  "SUBMITTING",
  "SUBMISSION_UNKNOWN",
  "PENDING",
  "IN_PROGRESS",
  "PARTIAL",
  "COMPLETED",
  "CANCELED",
  "ERROR",
  "UNKNOWN",
] as const;
export type ExecutionStatus = (typeof EXECUTION_STATUSES)[number];

export type PaymentMethod = "x402" | "ton" | "cryptobot" | "mock";

export interface PaymentRequirement {
  method: PaymentMethod;
  network?: string;
  asset?: string;
  amount: Money;
  payTo?: string;
  memo?: string;
  expiresAt?: string;
}

export interface Order {
  orderId: string;
  quoteId: string;
  clientReference: string;
  serviceId: string;
  link: string;
  quantity: number;
  parameters: Record<string, unknown>;
  amount: Money;
  paymentStatus: PaymentStatus;
  executionStatus: ExecutionStatus;
  paymentIntentId?: string;
  paymentRequirements?: PaymentRequirement[];
  createdAt: string;
  updatedAt: string;
}

export interface PaymentIntent {
  paymentIntentId: string;
  orderId: string;
  amount: Money;
  status: Exclude<PaymentStatus, "NOT_REQUIRED">;
  requirements: PaymentRequirement[];
  settledWith?: PaymentMethod;
  txHash?: string;
  createdAt: string;
  updatedAt: string;
}

export type CommandName =
  | "getCapabilities"
  | "searchServices"
  | "getService"
  | "getQuote"
  | "createOrder"
  | "getOrder"
  | "cancelOrder"
  | "requestRefill"
  | "listProviders"
  | "registerProvider";

/** Lifecycle of a provider node (spec/v0 §10). */
export type NodeLifecycle = "UNVERIFIED" | "ACTIVE" | "SUSPENDED";

/** Provider self-registration request (spec/v0 §10). */
export interface RegisterProviderInput {
  /** Adapter dialect of the provider's API. */
  adapter: "smm-v2" | "rest-v1";
  /** Base URL of the provider API. Must pass the SSRF guard. */
  endpoint: string;
  /** Provider-side credential. Stored in memory only, never returned by the API. */
  apiKey: string;
  /** smm-v2 only: behavior profile name (defaults to "standard"). */
  profile?: string;
  /** Published only when publiclyListed is true. */
  displayName?: string;
  publiclyListed?: boolean;
  /** Direct-settlement address used as payTo on this provider's orders. */
  payoutAddress?: string;
}

export interface RegisterProviderResult {
  providerKey: string;
  lifecycle: NodeLifecycle;
  offersCount: number;
  catalogVersion: string;
}

/** Gateway-measured execution quality for a provider (never self-reported). */
export interface ProviderMetrics {
  sampleSize: number;
  measuredStartP50Sec?: number;
  measuredCompletionP50Sec?: number;
  deliveredRatio?: number;
  errorRate?: number;
  retentionD7?: number;
}

/** Public, pseudonymous view of a connected execution provider. */
export interface ProviderInfo {
  providerKey: string;
  displayName?: string;
  lifecycle: NodeLifecycle;
  capabilities: { cancel: boolean; refill: boolean; batchStatus: boolean };
  offersCount: number;
  metrics: ProviderMetrics;
}

export interface Capabilities {
  protocolVersion: "0.1.0";
  commands: CommandName[];
  paymentMethods: PaymentMethod[];
  features: { cancel: boolean; refill: boolean };
  catalogVersion: string;
}

export interface CreateQuoteInput {
  serviceId: string;
  quantity: number;
  link?: string;
  parameters?: Record<string, unknown>;
}

export interface CreateOrderInput {
  quoteId: string;
  link: string;
  quantity?: number;
  parameters?: Record<string, unknown>;
  clientReference: string;
}

export interface SearchServicesQuery {
  query?: string;
  platform?: Platform;
  objective?: Objective;
}

export interface RefillResult {
  refillId: string;
  orderId: string;
  status: "REQUESTED";
}
