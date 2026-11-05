/**
 * SmmV2Provider: one adapter for the de-facto SMM API v2 standard
 * (POST /api/v2, key+action, JSON answers) with semantic profiles for panel
 * deviations. Onboarding a new panel = baseUrl + apiKey + profile.
 *
 * Hard rules from the protocol spec:
 * - HTTP 200 is NOT success: {"error": ...} may arrive with 200.
 * - Mutations (add/refill/cancel) are never blindly retried; an ambiguous
 *   outcome throws SubmissionAmbiguousError.
 * - Unknown statuses map to UNKNOWN with rawStatus preserved, never to COMPLETED.
 * - rate/currency semantics come from the profile, not from the panel's claims.
 */

import {
  ProviderRejectedError,
  SubmissionAmbiguousError,
  type CanonicalExecutionInput,
  type CancellationResult,
  type ExecutionReference,
  type ExecutionSnapshot,
  type OpenSmmProvider,
  type ProviderCapabilities,
  type ProviderOffer,
  type RefillReference,
} from "../../../core/provider-spi.ts";
import { PROFILES, type SmmV2Profile } from "./profile.ts";

export interface SmmV2ProviderOptions {
  providerId: string;
  baseUrl: string;
  apiKey: string;
  profile: SmmV2Profile | keyof typeof PROFILES;
  timeoutMs?: number;
  /** Test hook: replace global fetch. */
  fetchImpl?: typeof fetch;
}

type FetchImpl = typeof fetch;

const COMMON_STATUS_MAP: Record<string, ExecutionSnapshot["status"]> = {
  pending: "PENDING",
  processing: "IN_PROGRESS",
  "in progress": "IN_PROGRESS",
  partial: "PARTIAL",
  completed: "COMPLETED",
  canceled: "CANCELED",
  cancelled: "CANCELED",
};

/** Error strings that prove the provider did NOT accept the mutation. */
const DEFINITIVE_ERROR_PATTERNS = [
  /not enough funds/i,
  /invalid (api )?key/i,
  /invalid service/i,
  /incorrect order/i,
  /order (id )?not found/i,
  /missing (link|quantity|service)/i,
  /invalid (link|quantity)/i,
];

export class SmmV2Provider implements OpenSmmProvider {
  readonly providerId: string;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly profile: SmmV2Profile;
  private readonly timeoutMs: number;
  private readonly fetchImpl: FetchImpl;

  constructor(options: SmmV2ProviderOptions) {
    this.providerId = options.providerId;
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.profile =
      typeof options.profile === "string" ? PROFILES[options.profile]! : options.profile;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async getCapabilities(): Promise<ProviderCapabilities> {
    return {
      cancel: this.profile.supportsCancel,
      refill: this.profile.supportsRefill,
      batchStatus: true,
    };
  }

  async listOffers(): Promise<ProviderOffer[]> {
    const data = await this.call("services", {}, { mutating: false });
    if (!Array.isArray(data)) {
      throw new Error("smm-v2: services response is not an array (unexpected envelope)");
    }
    return data.map((raw) => this.mapOffer(raw as Record<string, unknown>));
  }

  async createExecution(input: CanonicalExecutionInput): Promise<ExecutionReference> {
    const params: Record<string, string> = {
      service: input.externalServiceId,
      link: input.link,
      quantity: String(input.quantity),
    };
    const p = input.parameters ?? {};
    if (typeof p.runs === "number") params.runs = String(p.runs);
    if (typeof p.interval === "number") params.interval = String(p.interval);
    if (Array.isArray(p.comments)) params.comments = (p.comments as string[]).join("\n");

    const data = await this.call("add", params, { mutating: true });
    const orderId = (data as Record<string, unknown>).order;
    if (orderId === undefined || orderId === null) {
      throw new SubmissionAmbiguousError(
        `smm-v2: add returned no order id: ${JSON.stringify(data).slice(0, 200)}`,
      );
    }
    return { externalExecutionId: String(orderId) };
  }

  async getExecution(externalExecutionId: string): Promise<ExecutionSnapshot> {
    const data = (await this.call("status", { order: externalExecutionId }, { mutating: false })) as Record<
      string,
      unknown
    >;
    const rawStatus = typeof data.status === "string" ? data.status : "";
    return {
      status: this.mapStatus(rawStatus),
      rawStatus,
      ...(data.start_count !== undefined ? { startCount: toInt(data.start_count) } : {}),
      ...(data.remains !== undefined ? { remains: toInt(data.remains) } : {}),
    };
  }

  async requestRefill(externalExecutionId: string): Promise<RefillReference> {
    if (!this.profile.supportsRefill) {
      throw new ProviderRejectedError(`profile ${this.profile.name}: refill not supported`);
    }
    const data = (await this.call(
      "refill",
      { order: externalExecutionId },
      { mutating: true },
    )) as Record<string, unknown>;

    if (this.profile.refillResponse === "success_message" && typeof data.success === "string") {
      // Success-message panels return no refill id — the refill is untrackable
      // via refill_status. The marker makes that explicit instead of inventing an id.
      return { externalRefillId: `untracked:${externalExecutionId}` };
    }
    const refillId = data.refill;
    if (refillId === undefined || refillId === null) {
      throw new SubmissionAmbiguousError(
        `smm-v2: refill returned no id: ${JSON.stringify(data).slice(0, 200)}`,
      );
    }
    return { externalRefillId: String(refillId) };
  }

  async cancelExecution(externalExecutionId: string): Promise<CancellationResult> {
    if (!this.profile.supportsCancel) {
      return { canceled: false, reason: `profile ${this.profile.name}: cancel not supported` };
    }
    const params: Record<string, string> =
      this.profile.cancelParameter === "orders"
        ? { orders: externalExecutionId }
        : { order: externalExecutionId };

    let data: unknown;
    try {
      data = await this.call("cancel", params, { mutating: true });
    } catch (err) {
      if (err instanceof ProviderRejectedError) {
        return { canceled: false, reason: err.message };
      }
      throw err;
    }

    if (!Array.isArray(data)) {
      const obj = data as Record<string, unknown>;
      if (typeof obj.success === "string") return { canceled: true };
      return { canceled: false, reason: `unexpected cancel response: ${JSON.stringify(data).slice(0, 200)}` };
    }
    const entry = data.find(
      (e) => String((e as Record<string, unknown>).order) === externalExecutionId,
    ) as Record<string, unknown> | undefined;
    if (!entry) {
      return { canceled: false, reason: "order not present in cancel response" };
    }
    const result = entry.cancel;
    if (result === 1 || result === "1" || result === true) {
      return { canceled: true };
    }
    const reason =
      typeof result === "object" && result !== null && "error" in result
        ? String((result as Record<string, unknown>).error)
        : "provider refused cancellation";
    return { canceled: false, reason };
  }

  // --- internals -----------------------------------------------------------

  private async call(
    action: string,
    params: Record<string, string>,
    opts: { mutating: boolean },
  ): Promise<unknown> {
    const body = new URLSearchParams({
      [this.profile.authField]: this.apiKey,
      action,
      ...params,
    });

    let res: Response;
    try {
      res = await this.fetchImpl(this.baseUrl, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: body.toString(),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      // Network failure / timeout: for mutations the outcome is unknowable.
      if (opts.mutating) {
        throw new SubmissionAmbiguousError(
          `smm-v2: ${action} request failed after sending: ${(err as Error).message}`,
        );
      }
      throw err;
    }

    const text = await res.text();
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      if (opts.mutating) {
        throw new SubmissionAmbiguousError(
          `smm-v2: ${action} returned non-JSON (HTTP ${res.status}): ${text.slice(0, 120)}`,
        );
      }
      throw new Error(`smm-v2: non-JSON response (HTTP ${res.status}): ${text.slice(0, 120)}`);
    }

    // HTTP 200 does NOT mean success in SMM API v2.
    const errorMessage = extractError(data);
    if (errorMessage) {
      if (DEFINITIVE_ERROR_PATTERNS.some((re) => re.test(errorMessage))) {
        throw new ProviderRejectedError(`smm-v2: ${errorMessage}`);
      }
      if (opts.mutating) {
        // Unknown error semantics on a mutation: cannot prove non-execution.
        throw new SubmissionAmbiguousError(`smm-v2: ${action} error: ${errorMessage}`);
      }
      throw new ProviderRejectedError(`smm-v2: ${errorMessage}`);
    }
    return data;
  }

  private mapOffer(raw: Record<string, unknown>): ProviderOffer {
    const id = pickField(raw, this.profile.serviceFields.id);
    if (id === undefined) {
      throw new Error(`smm-v2: service entry without id: ${JSON.stringify(raw).slice(0, 200)}`);
    }
    const description = pickField(raw, this.profile.serviceFields.description);
    const category = pickField(raw, this.profile.serviceFields.category);
    return {
      externalServiceId: String(id),
      name: String(raw.name ?? `#${id}`) + (description ? ` — ${String(description).slice(0, 120)}` : ""),
      ...(category !== undefined ? { category: String(category) } : {}),
      rate: String(raw.rate ?? "0"),
      rateBasis: this.profile.rateBasis,
      currency: this.profile.balanceKind === "provider_credits" ? "PROVIDER_CREDITS" : "USD",
      minQuantity: toInt(raw.min),
      maxQuantity: toInt(raw.max),
      refill: raw.refill === true && this.profile.supportsRefill,
      cancel: raw.cancel === true && this.profile.supportsCancel,
      dripfeed: raw.dripfeed === true,
    };
  }

  private mapStatus(rawStatus: string): ExecutionSnapshot["status"] {
    const normalized = rawStatus.trim().toLowerCase();
    const common = COMMON_STATUS_MAP[normalized];
    if (common) return common;
    for (const [raw, mapped] of Object.entries(this.profile.extraStatusMap ?? {})) {
      if (raw.toLowerCase() === normalized) return mapped;
    }
    // Never guess: an unrecognized provider status is UNKNOWN, not COMPLETED.
    return "UNKNOWN";
  }
}

function extractError(data: unknown): string | null {
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const err = (data as Record<string, unknown>).error;
    if (typeof err === "string" && err) return err;
  }
  return null;
}

function pickField(raw: Record<string, unknown>, candidates: string[]): unknown {
  for (const name of candidates) {
    if (raw[name] !== undefined) return raw[name];
  }
  return undefined;
}

function toInt(value: unknown): number {
  const n = Number.parseInt(String(value), 10);
  return Number.isFinite(n) ? n : 0;
}
