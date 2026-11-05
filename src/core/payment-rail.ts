/**
 * Payment rail SPI: how a PaymentIntent gets settled without the core knowing
 * anything about x402, TON memos or CryptoBot webhooks. Adding a rail must not
 * change the order lifecycle (spec/v0 §4).
 */

import type { Money, PaymentIntent, PaymentMethod, PaymentRequirement } from "./types.ts";

export interface SettlementResult {
  /** settled: funds final, execution may start. pending: accepted, finality later — poll, never re-pay. */
  outcome: "settled" | "pending";
  txHash?: string;
}

export class PaymentRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PaymentRejectedError";
  }
}

export interface PaymentRail {
  readonly method: PaymentMethod;

  /**
   * What the payer needs to know to pay this intent via this rail.
   * payTo overrides the rail's default recipient — used for direct
   * settlement to the executing provider (spec/v0 §8).
   */
  buildRequirements(amount: Money, payTo?: string): PaymentRequirement;

  /**
   * Verify and settle a payer-submitted proof (signed x402 payload, tx hash, ...).
   * Must be idempotent: settling an already-settled intent returns settled again.
   * Throws PaymentRejectedError on definitive failure (bad signature, wrong amount).
   */
  settle(intent: PaymentIntent, proof?: unknown): Promise<SettlementResult>;
}
