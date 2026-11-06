/**
 * HTTP client for a real x402 facilitator (x402 v2 wire format).
 * Speaks to any facilitator exposing the standard `POST /verify` and
 * `POST /settle` endpoints — the public https://x402.org/facilitator
 * (testnet) or a production facilitator such as Coinbase CDP (mainnet,
 * Bearer API key).
 *
 * The gateway's internal PaymentRequirement is asset-agnostic
 * (`{ asset: "USDC", amount: { value: "2.412000" } }`); this client translates
 * it to the facilitator's wire shape: scheme "exact", the network's USDC
 * contract address and atomic units (USDC has 6 decimals — the same scale the
 * core uses for decimal strings, so the conversion is exact integer math).
 */

import { PaymentRejectedError, type SettlementResult } from "../../../core/payment-rail.ts";
import { parseDecimal } from "../../../core/money.ts";
import type { PaymentRequirement } from "../../../core/types.ts";
import type { X402Facilitator } from "./index.ts";

/** Canonical USDC contract addresses per CAIP-2 network. Override via options. */
export const USDC_ADDRESSES: Record<string, string> = {
  "eip155:8453": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", // Base mainnet
  "eip155:84532": "0x036CbD53842c5426634e7929541eC2318f3dCF7e", // Base Sepolia
};

/**
 * EIP-712 domain of each network's USDC contract. The facilitator derives the
 * domain from `extra` when verifying the payer's signature, so the name must
 * match the token contract exactly: "USDC"/"2" on Base Sepolia,
 * "USD Coin"/"2" on Base mainnet.
 */
export const USDC_EIP712_DOMAINS: Record<string, { name: string; version: string }> = {
  "eip155:8453": { name: "USD Coin", version: "2" }, // Base mainnet
  "eip155:84532": { name: "USDC", version: "2" }, // Base Sepolia
};

export const DEFAULT_FACILITATOR_TIMEOUT_MS = 90_000;
export const DEFAULT_MAX_TIMEOUT_SECONDS = 300;

/** x402 v2 payment requirements as the facilitator expects them. */
export interface WirePaymentRequirements {
  scheme: "exact";
  network: string;
  /** Atomic units as a decimal string (6-decimal USDC: "2412000" = 2.412 USDC). */
  amount: string;
  /** ERC-20 contract address. */
  asset: string;
  payTo: string;
  maxTimeoutSeconds: number;
  /** EIP-712 domain of the asset contract; without it the facilitator rejects the payload. */
  extra: { name: string; version: string };
}

export interface HttpFacilitatorOptions {
  /** Facilitator base URL, no trailing slash needed (e.g. https://x402.org/facilitator). */
  url: string;
  /** Bearer token for facilitators that require auth (e.g. CDP API key/JWT). */
  apiKey?: string;
  /** Per-request deadline; settle may legitimately wait on a receipt. */
  timeoutMs?: number;
  /** USDC contract override for networks outside USDC_ADDRESSES. */
  usdcAddress?: string;
  /** EIP-712 domain override for the asset contract (defaults per network). */
  eip712Domain?: { name: string; version: string };
  maxTimeoutSeconds?: number;
  /** Test seam. */
  fetchImpl?: typeof fetch;
}

interface VerifyResponse {
  isValid: boolean;
  invalidReason?: string;
  invalidMessage?: string;
}

interface SettleResponse {
  success: boolean;
  errorReason?: string;
  errorMessage?: string;
  transaction?: string;
  network?: string;
}

/** Translate the internal requirement to the facilitator wire shape. */
export function toWireRequirements(
  requirement: PaymentRequirement,
  options: {
    usdcAddress?: string;
    eip712Domain?: { name: string; version: string };
    maxTimeoutSeconds?: number;
  } = {},
): WirePaymentRequirements {
  if (!requirement.network) {
    throw new PaymentRejectedError("x402 requirement has no network");
  }
  if (!requirement.payTo) {
    throw new PaymentRejectedError("x402 requirement has no payTo");
  }
  const asset = options.usdcAddress ?? USDC_ADDRESSES[requirement.network];
  if (!asset) {
    throw new PaymentRejectedError(
      `no USDC contract address known for network ${requirement.network}`,
    );
  }
  const extra =
    options.eip712Domain ??
    USDC_EIP712_DOMAINS[requirement.network] ??
    { name: "USDC", version: "2" };
  return {
    scheme: "exact",
    network: requirement.network,
    // Decimal string → atomic units: parseDecimal gives micro-units (1e-6),
    // exactly USDC's 6 decimals.
    amount: parseDecimal(requirement.amount.value).toString(),
    asset,
    payTo: requirement.payTo,
    maxTimeoutSeconds: options.maxTimeoutSeconds ?? DEFAULT_MAX_TIMEOUT_SECONDS,
    extra,
  };
}

export class HttpFacilitator implements X402Facilitator {
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly timeoutMs: number;
  private readonly usdcAddress?: string;
  private readonly eip712Domain?: { name: string; version: string };
  private readonly maxTimeoutSeconds: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: HttpFacilitatorOptions) {
    this.baseUrl = options.url.replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_FACILITATOR_TIMEOUT_MS;
    this.usdcAddress = options.usdcAddress;
    this.eip712Domain = options.eip712Domain;
    this.maxTimeoutSeconds = options.maxTimeoutSeconds ?? DEFAULT_MAX_TIMEOUT_SECONDS;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private wire(requirement: PaymentRequirement): WirePaymentRequirements {
    return toWireRequirements(requirement, {
      ...(this.usdcAddress ? { usdcAddress: this.usdcAddress } : {}),
      ...(this.eip712Domain ? { eip712Domain: this.eip712Domain } : {}),
      maxTimeoutSeconds: this.maxTimeoutSeconds,
    });
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.apiKey) headers["authorization"] = `Bearer ${this.apiKey}`;
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const text = await response.text();
    if (!response.ok) {
      // Not a payment rejection: the facilitator itself failed (auth, outage).
      // Surface as a plain error so the intent stays retryable.
      throw new Error(`x402 facilitator ${path} answered HTTP ${response.status}: ${text.slice(0, 300)}`);
    }
    return JSON.parse(text) as T;
  }

  async verify(
    payload: unknown,
    requirement: PaymentRequirement,
  ): Promise<{ valid: boolean; reason?: string }> {
    const result = await this.post<VerifyResponse>("/verify", {
      paymentPayload: payload,
      paymentRequirements: this.wire(requirement),
    });
    if (result.isValid) return { valid: true };
    return {
      valid: false,
      reason: result.invalidMessage ?? result.invalidReason ?? "facilitator rejected the payload",
    };
  }

  async settle(payload: unknown, requirement: PaymentRequirement): Promise<SettlementResult> {
    const result = await this.post<SettleResponse>("/settle", {
      paymentPayload: payload,
      paymentRequirements: this.wire(requirement),
    });
    if (result.success) {
      return { outcome: "settled", ...(result.transaction ? { txHash: result.transaction } : {}) };
    }
    // settlement_pending: broadcast happened, receipt unknown — reconcile on
    // chain via the tx hash, never re-pay (spec/v0 §4).
    if (result.errorReason === "settlement_pending" || result.transaction) {
      return { outcome: "pending", ...(result.transaction ? { txHash: result.transaction } : {}) };
    }
    throw new PaymentRejectedError(
      result.errorMessage ?? result.errorReason ?? "facilitator failed to settle",
    );
  }
}
