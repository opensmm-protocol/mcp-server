/**
 * OpenSMM Provider SPI (spec session: Provider Adapter API).
 * Providers know nothing about MCP, payments, client wallets or clientReference.
 */

import type { ExecutionStatus } from "./types.ts";

export interface ProviderCapabilities {
  cancel: boolean;
  refill: boolean;
  batchStatus: boolean;
}

/** Provider-side offer, in provider terms. The gateway maps these to its own Services. */
export interface ProviderOffer {
  externalServiceId: string;
  name: string;
  description?: string;
  category?: string;
  /** Decimal-string rate in `currency`, interpreted per `rateBasis`. */
  rate: string;
  rateBasis: "PER_1000" | "PER_UNIT" | "PER_PACKAGE";
  currency: string;
  minQuantity: number;
  maxQuantity: number;
  refill: boolean;
  cancel: boolean;
  dripfeed: boolean;
}

export interface CanonicalExecutionInput {
  /** Provider's own service id (externalServiceId), not the gateway serviceId. */
  externalServiceId: string;
  link: string;
  quantity: number;
  parameters?: Record<string, unknown>;
}

export interface ExecutionReference {
  externalExecutionId: string;
}

export interface ExecutionSnapshot {
  /** Canonical status as interpreted by the provider adapter. */
  status: Extract<
    ExecutionStatus,
    "PENDING" | "IN_PROGRESS" | "PARTIAL" | "COMPLETED" | "CANCELED" | "ERROR" | "UNKNOWN"
  >;
  /** Provider's raw status string, preserved for audit. */
  rawStatus?: string;
  startCount?: number;
  remains?: number;
  delivered?: number;
}

export interface CancellationResult {
  canceled: boolean;
  reason?: string;
}

export interface RefillReference {
  externalRefillId: string;
}

/** Thrown when the provider definitively refused the order (bad link, no funds, ...). */
export class ProviderRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderRejectedError";
  }
}

/**
 * Thrown when the submission outcome is unknowable (timeout, connection reset).
 * The gateway MUST move the order to SUBMISSION_UNKNOWN and reconcile — never
 * blindly resubmit, because the provider may have accepted the order.
 */
export class SubmissionAmbiguousError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SubmissionAmbiguousError";
  }
}

export interface OpenSmmProvider {
  readonly providerId: string;

  getCapabilities(): Promise<ProviderCapabilities>;

  listOffers(): Promise<ProviderOffer[]>;

  /** May throw ProviderRejectedError or SubmissionAmbiguousError. No idempotency here. */
  createExecution(input: CanonicalExecutionInput): Promise<ExecutionReference>;

  getExecution(externalExecutionId: string): Promise<ExecutionSnapshot>;

  cancelExecution?(externalExecutionId: string): Promise<CancellationResult>;

  requestRefill?(externalExecutionId: string): Promise<RefillReference>;
}
