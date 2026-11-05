/**
 * RestV1Provider: adapter for reseller-style REST v1 APIs:
 *   GET    {baseUrl}/services          (Bearer auth) -> { success, services: [...] }
 *   POST   {baseUrl}/orders            { service, link, quantity } -> 201 { success, order: {...} }
 *   GET    {baseUrl}/orders/:id        -> { id, status, ... }
 *
 * Onboarding such a provider = baseUrl + apiKey. Same hard rules as smm-v2:
 * - Definitive rejections (validation, insufficient funds, not found, bad key)
 *   throw ProviderRejectedError.
 * - Network failures / timeouts / non-JSON on mutations throw
 *   SubmissionAmbiguousError — the order may have been accepted.
 * - Unknown statuses map to UNKNOWN with rawStatus preserved, never to COMPLETED.
 */

import {
  ProviderRejectedError,
  SubmissionAmbiguousError,
  type CanonicalExecutionInput,
  type ExecutionReference,
  type ExecutionSnapshot,
  type OpenSmmProvider,
  type ProviderCapabilities,
  type ProviderOffer,
} from "../../../core/provider-spi.ts";

export interface RestV1ProviderOptions {
  providerId: string;
  /** Base URL of the v1 API, e.g. "https://example.com/api/v1". */
  baseUrl: string;
  apiKey: string;
  timeoutMs?: number;
  /** Test hook: replace global fetch. */
  fetchImpl?: typeof fetch;
}

type FetchImpl = typeof fetch;

const STATUS_MAP: Record<string, ExecutionSnapshot["status"]> = {
  awaiting_payment: "PENDING",
  submitting: "PENDING",
  pending: "PENDING",
  processing: "IN_PROGRESS",
  in_progress: "IN_PROGRESS",
  partial: "PARTIAL",
  completed: "COMPLETED",
  canceled: "CANCELED",
  cancelled: "CANCELED",
  error: "ERROR",
};

export class RestV1Provider implements OpenSmmProvider {
  readonly providerId: string;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: FetchImpl;

  constructor(options: RestV1ProviderOptions) {
    this.providerId = options.providerId;
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async getCapabilities(): Promise<ProviderCapabilities> {
    return { cancel: false, refill: false, batchStatus: false };
  }

  async listOffers(): Promise<ProviderOffer[]> {
    const data = await this.request("GET", "/services", undefined, { mutating: false });
    const services = (data as Record<string, unknown>).services;
    if (!Array.isArray(services)) {
      throw new Error("rest-v1: services response has no services array (unexpected envelope)");
    }
    return services.map((raw) => this.mapOffer(raw as Record<string, unknown>));
  }

  async createExecution(input: CanonicalExecutionInput): Promise<ExecutionReference> {
    const data = await this.request(
      "POST",
      "/orders",
      {
        service: Number(input.externalServiceId),
        link: input.link,
        quantity: input.quantity,
      },
      { mutating: true },
    );
    const order = (data as Record<string, unknown>).order as Record<string, unknown> | undefined;
    if (!order || order.id === undefined || order.id === null) {
      throw new SubmissionAmbiguousError(
        `rest-v1: create order returned no order id: ${JSON.stringify(data).slice(0, 200)}`,
      );
    }
    return { externalExecutionId: String(order.id) };
  }

  async getExecution(externalExecutionId: string): Promise<ExecutionSnapshot> {
    const data = (await this.request("GET", `/orders/${encodeURIComponent(externalExecutionId)}`, undefined, {
      mutating: false,
    })) as Record<string, unknown>;
    const rawStatus = typeof data.status === "string" ? data.status : "";
    return {
      status: STATUS_MAP[rawStatus.trim().toLowerCase()] ?? "UNKNOWN",
      rawStatus,
    };
  }

  // --- internals -----------------------------------------------------------

  private async request(
    method: "GET" | "POST",
    path: string,
    body: Record<string, unknown> | undefined,
    opts: { mutating: boolean },
  ): Promise<unknown> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          ...(body ? { "content-type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      if (opts.mutating) {
        throw new SubmissionAmbiguousError(
          `rest-v1: ${method} ${path} failed after sending: ${(err as Error).message}`,
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
          `rest-v1: ${method} ${path} returned non-JSON (HTTP ${res.status}): ${text.slice(0, 120)}`,
        );
      }
      throw new Error(`rest-v1: non-JSON response (HTTP ${res.status}): ${text.slice(0, 120)}`);
    }

    const errorMessage = extractError(data);
    if (!res.ok || errorMessage) {
      const detail = errorMessage ?? `HTTP ${res.status}`;
      // 4xx answers are definitive: the provider read the request and refused it.
      if (res.status === 401 || res.status === 403) {
        throw new ProviderRejectedError(`rest-v1: unauthorized (${detail})`);
      }
      if (res.status >= 400 && res.status < 500) {
        throw new ProviderRejectedError(`rest-v1: ${detail}`);
      }
      if (opts.mutating) {
        // 5xx on a mutation: cannot prove the order was not accepted.
        throw new SubmissionAmbiguousError(`rest-v1: ${method} ${path} error: ${detail}`);
      }
      throw new ProviderRejectedError(`rest-v1: ${detail}`);
    }
    return data;
  }

  private mapOffer(raw: Record<string, unknown>): ProviderOffer {
    const id = raw.service;
    if (id === undefined || id === null) {
      throw new Error(`rest-v1: service entry without id: ${JSON.stringify(raw).slice(0, 200)}`);
    }
    const description = typeof raw.description === "string" ? raw.description : "";
    return {
      externalServiceId: String(id),
      name: String(raw.name ?? `#${id}`) + (description ? ` — ${description.slice(0, 120)}` : ""),
      ...(raw.category !== undefined ? { category: String(raw.category) } : {}),
      rate: String(raw.rate ?? "0"),
      rateBasis: "PER_1000",
      currency: "USD",
      minQuantity: toInt(raw.min),
      maxQuantity: toInt(raw.max),
      refill: raw.refill === true,
      cancel: raw.cancel === true,
      dripfeed: raw.dripfeed === true,
    };
  }
}

function extractError(data: unknown): string | null {
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const err = (data as Record<string, unknown>).error;
    if (typeof err === "string" && err) return err;
  }
  return null;
}

function toInt(value: unknown): number {
  const n = Number.parseInt(String(value), 10);
  return Number.isFinite(n) ? n : 0;
}
