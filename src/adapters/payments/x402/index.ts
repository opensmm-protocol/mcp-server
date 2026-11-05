/**
 * x402 payment rail (draft): USDC on Base, settled through a facilitator.
 * The rail never touches private keys — it only passes payment requirements to
 * the payer and the signed payload to the facilitator's verify/settle calls.
 *
 * Networks: "eip155:8453" (Base mainnet), "eip155:84532" (Base Sepolia testnet).
 */

import {
  PaymentRejectedError,
  type PaymentRail,
  type SettlementResult,
} from "../../../core/payment-rail.ts";
import type { Money, PaymentIntent, PaymentMethod, PaymentRequirement } from "../../../core/types.ts";

/** Facilitator API surface (CDP-style). The real client lands with mainnet config. */
export interface X402Facilitator {
  /** Is this signed payload a valid payment for these requirements? */
  verify(
    payload: unknown,
    requirement: PaymentRequirement,
  ): Promise<{ valid: boolean; reason?: string }>;
  /** Settle a verified payload on-chain. May legitimately answer "pending". */
  settle(payload: unknown, requirement: PaymentRequirement): Promise<SettlementResult>;
}

export interface X402RailOptions {
  payTo: string;
  network?: string;
  asset?: string;
  facilitator: X402Facilitator;
}

export class X402Rail implements PaymentRail {
  readonly method: PaymentMethod = "x402";

  private readonly payTo: string;
  private readonly network: string;
  private readonly asset: string;
  private readonly facilitator: X402Facilitator;

  constructor(options: X402RailOptions) {
    this.payTo = options.payTo;
    this.network = options.network ?? "eip155:84532";
    this.asset = options.asset ?? "USDC";
    this.facilitator = options.facilitator;
  }

  buildRequirements(amount: Money, payTo?: string): PaymentRequirement {
    return {
      method: "x402",
      network: this.network,
      asset: this.asset,
      amount: { ...amount },
      // Direct settlement: the executing provider's address wins over the
      // rail default (spec/v0 §8).
      payTo: payTo ?? this.payTo,
    };
  }

  async settle(intent: PaymentIntent, proof?: unknown): Promise<SettlementResult> {
    const requirement = intent.requirements.find((r) => r.method === "x402");
    if (!requirement) {
      throw new PaymentRejectedError("payment intent has no x402 requirement");
    }
    if (proof === undefined || proof === null) {
      throw new PaymentRejectedError("missing x402 payment payload");
    }
    const verification = await this.facilitator.verify(proof, requirement);
    if (!verification.valid) {
      throw new PaymentRejectedError(verification.reason ?? "x402 payload rejected by facilitator");
    }
    return this.facilitator.settle(proof, requirement);
  }
}

/**
 * Test double for the facilitator: accepts any non-null payload, can be
 * scripted to answer "pending" before settling (the settlement_pending flow).
 */
export class MockFacilitator implements X402Facilitator {
  private pendingResponses = 0;
  private nextTxSeq = 1;
  readonly seenPayloads: unknown[] = [];

  /** Make the next N settle() calls answer "pending" instead of "settled". */
  scriptPending(count: number): void {
    this.pendingResponses = count;
  }

  async verify(payload: unknown): Promise<{ valid: boolean; reason?: string }> {
    if (payload === null || typeof payload !== "object") {
      return { valid: false, reason: "payload must be an object" };
    }
    return { valid: true };
  }

  async settle(payload: unknown): Promise<SettlementResult> {
    this.seenPayloads.push(payload);
    if (this.pendingResponses > 0) {
      this.pendingResponses -= 1;
      return { outcome: "pending" };
    }
    return { outcome: "settled", txHash: `0xmocktx${this.nextTxSeq++}` };
  }
}
