/**
 * OpenSMM domain core: catalog, quotes, orders, payments, execution.
 * Transport-agnostic. REST and MCP adapters call these commands and nothing else.
 */

import { createHash } from "node:crypto";
import type { Catalog, CatalogEntry } from "./catalog.ts";
import { providerOfferToCatalogEntry } from "./catalog-map.ts";
import { OpenSmmError } from "./errors.ts";
import { newId, nowIso } from "./ids.ts";
import { MetricsRecorder, type MetricsState } from "./metrics.ts";
import { parseDecimal, quoteAmount } from "./money.ts";
import { PaymentRejectedError, type PaymentRail } from "./payment-rail.ts";
import { ProviderRegistry, type ProviderNode } from "./provider-registry.ts";
import {
  ProviderRejectedError,
  SubmissionAmbiguousError,
  type ExecutionSnapshot,
  type OpenSmmProvider,
  type ProviderOffer,
} from "./provider-spi.ts";
import { assertPublicProviderUrl, SsrfBlockedError, type SsrfGuardOptions } from "./ssrf-guard.ts";
import type {
  Capabilities,
  CommandName,
  CreateOrderInput,
  CreateQuoteInput,
  Money,
  NodeLifecycle,
  OfferComparison,
  OfferComparisonEntry,
  OfferQuality,
  Order,
  PaymentIntent,
  PaymentMethod,
  PaymentRequirement,
  PaymentStatus,
  ProviderInfo,
  Quote,
  RefillResult,
  RegisterProviderInput,
  RegisterProviderResult,
  SearchServicesQuery,
  Service,
  ServiceSort,
} from "./types.ts";

const PROTOCOL_VERSION = "0.1.0" as const;
const ALL_COMMANDS: CommandName[] = [
  "getCapabilities",
  "searchServices",
  "getService",
  "getQuote",
  "createOrder",
  "getOrder",
  "cancelOrder",
  "requestRefill",
  "listProviders",
  "registerProvider",
];

/**
 * Builds a provider adapter for a registration request and runs the
 * healthcheck: a successful offer listing proves endpoint, auth and catalog.
 * Injected by the composition root so the core never imports adapters.
 */
export type ProviderFactory = (
  input: RegisterProviderInput,
  providerId: string,
) => Promise<{ provider: OpenSmmProvider; offers: ProviderOffer[] }>;

const TERMINAL_EXECUTION = new Set(["COMPLETED", "CANCELED", "ERROR"]);

/**
 * Compares normalized unit prices across rate bases without floats:
 * PER_1000 rates are scaled down by 1000 via cross-multiplication.
 */
function compareUnitPrice(
  a: Pick<Service, "rate" | "rateBasis">,
  b: Pick<Service, "rate" | "rateBasis">,
): number {
  const divisor = (basis: Service["rateBasis"]) => (basis === "PER_1000" ? 1000n : 1n);
  const left = parseDecimal(a.rate.value) * divisor(b.rateBasis);
  const right = parseDecimal(b.rate.value) * divisor(a.rateBasis);
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Quality order for sorting: better (higher ratio, lower latency, more orders) first. */
function compareQuality(a?: OfferQuality, b?: OfferQuality): number {
  const ratioDiff = (b?.deliveredRatio ?? -1) - (a?.deliveredRatio ?? -1);
  if (ratioDiff !== 0) return ratioDiff;
  const latencyDiff =
    (a?.startLatencyMs ?? Number.POSITIVE_INFINITY) -
    (b?.startLatencyMs ?? Number.POSITIVE_INFINITY);
  if (latencyDiff !== 0) return latencyDiff;
  return (b?.orders ?? 0) - (a?.orders ?? 0);
}

export interface QuoteRecord {
  quote: Quote;
  parameters: Record<string, unknown>;
  consumedByOrderId?: string;
}

export interface IdempotencyRecord {
  requestHash: string;
  orderId: string;
}

/** Everything needed to rebuild a self-registered node after a restart. */
export interface NodeSnapshot {
  providerId: string;
  providerKey: string;
  lifecycle: NodeLifecycle;
  displayName?: string;
  publiclyListed: boolean;
  payoutAddress?: string;
  registeredAt: string;
  lastHealthcheckAt?: string;
  registrationInput: RegisterProviderInput;
}

/**
 * Full gateway state snapshot (persistence). Contains provider credentials
 * inside nodes[].registrationInput — protect the state file like a secret
 * (the built-in store writes it with mode 0600).
 */
export interface CoreSnapshot {
  format: 1;
  savedAt: string;
  quotes: [string, QuoteRecord][];
  orders: Order[];
  payments: PaymentIntent[];
  executions: [string, ExecutionRecord][];
  refills: [string, string][];
  idempotency: [string, IdempotencyRecord][];
  metrics: MetricsState;
  nodes: NodeSnapshot[];
}

/** Rebuilds a provider adapter from its registration input (no healthcheck). */
export type ProviderBuilder = (
  input: RegisterProviderInput,
  providerId: string,
) => OpenSmmProvider | Promise<OpenSmmProvider>;

export interface ExecutionRecord {
  externalExecutionId: string;
  /** Epoch ms when the provider accepted the submission. */
  submittedAt: number;
  /** First poll that observed delivery (status left PENDING). */
  firstProgressAt?: number;
  /** Terminal observation timestamp; also guards double-counting metrics. */
  completedAt?: number;
  /** High-water mark of delivered units seen across polls. */
  maxDelivered: number;
  /** Delivered at terminal observation — the baseline for the retention check. */
  deliveredAtCompletion?: number;
  /** When the delayed retention re-check is due (epoch ms). */
  retentionDueAt?: number;
  retentionDone?: boolean;
  latestSnapshot?: ExecutionSnapshot;
}

export interface CoreOptions {
  catalog: Catalog;
  /** One or more execution providers; orders route by catalog entry providerId. */
  providers: OpenSmmProvider[];
  /** Payment rails offered on new orders. Defaults to the dev-only mock rail. */
  paymentMethods?: PaymentMethod[];
  /** Rail implementations keyed by method; absent methods fall back to mock behavior. */
  rails?: PaymentRail[];
  /**
   * Public listing opts keyed by providerId (spec/v0 §9). Pseudonymous by
   * default; displayName is published only when publiclyListed is true.
   * payoutAddress enables direct settlement (spec/v0 §8): it becomes the
   * payTo of this provider's payment requirements.
   */
  providerInfo?: Record<string, { displayName?: string; publiclyListed?: boolean; payoutAddress?: string }>;
  /** Enables the registerProvider command (spec/v0 §10). */
  providerFactory?: ProviderFactory;
  /** SSRF guard options for provider registration (allowPrivate is dev-only). */
  ssrf?: SsrfGuardOptions;
  /** Gateway-measured provider metrics (spec/v0 §9). A shared default is created when omitted. */
  metrics?: MetricsRecorder;
  /**
   * Delay between a terminal observation and the retention re-check
   * (spec/v0 §9.1 retentionD7). Default 7 days.
   */
  retentionCheckMs?: number;
  /**
   * Verification policy for self-registered nodes (spec/v0 §10.1).
   * UNVERIFIED nodes are routable but volume-capped per order; promotion and
   * demotion are computed from gateway-measured metrics, never self-reports.
   */
  verification?: {
    /** Max nominal order amount for UNVERIFIED nodes. Default 50. */
    maxUnverifiedOrderValue?: number;
    /** Min measured sample for promotion UNVERIFIED → ACTIVE. Default 5. */
    promoteSampleSize?: number;
    /** Min deliveredRatio for promotion. Default 0.8. */
    promoteDeliveredRatio?: number;
    /** Min sample before quality demotion applies. Default 10. */
    demoteSampleSize?: number;
    /** errorRate above this demotes ACTIVE → SUSPENDED. Default 0.5. */
    demoteErrorRate?: number;
  };
  quoteTtlMs?: number;
}

export interface SettleOptions {
  method?: PaymentMethod;
  proof?: unknown;
}

export class OpenSmmCore {
  readonly catalog: Catalog;
  readonly registry = new ProviderRegistry();
  private readonly paymentMethods: PaymentMethod[];
  private readonly rails = new Map<PaymentMethod, PaymentRail>();
  private readonly providerFactory?: ProviderFactory;
  private readonly ssrf: SsrfGuardOptions;
  private readonly quoteTtlMs: number;
  readonly metrics: MetricsRecorder;
  private readonly retentionCheckMs: number;
  private readonly verification: Required<NonNullable<CoreOptions["verification"]>>;

  private readonly quotes = new Map<string, QuoteRecord>();
  private readonly orders = new Map<string, Order>();
  private readonly payments = new Map<string, PaymentIntent>();
  private readonly executions = new Map<string, ExecutionRecord>();
  private readonly refills = new Map<string, string>();
  private readonly idempotency = new Map<string, IdempotencyRecord>();

  constructor(options: CoreOptions) {
    this.catalog = options.catalog;
    if (options.providers.length === 0) {
      throw new Error("OpenSmmCore requires at least one provider");
    }
    const info = options.providerInfo ?? {};
    for (const provider of options.providers) {
      const opts = info[provider.providerId] ?? {};
      this.registry.register({
        providerId: provider.providerId,
        provider,
        lifecycle: "ACTIVE",
        ...(opts.displayName !== undefined ? { displayName: opts.displayName } : {}),
        publiclyListed: opts.publiclyListed ?? false,
        ...(opts.payoutAddress !== undefined ? { payoutAddress: opts.payoutAddress } : {}),
        registeredAt: nowIso(),
      });
    }
    this.paymentMethods = options.paymentMethods ?? ["mock"];
    for (const rail of options.rails ?? []) {
      this.rails.set(rail.method, rail);
    }
    if (options.providerFactory) this.providerFactory = options.providerFactory;
    this.ssrf = options.ssrf ?? {};
    this.metrics = options.metrics ?? new MetricsRecorder();
    this.retentionCheckMs = options.retentionCheckMs ?? 7 * 24 * 60 * 60 * 1000;
    const v = options.verification ?? {};
    this.verification = {
      maxUnverifiedOrderValue: v.maxUnverifiedOrderValue ?? 50,
      promoteSampleSize: v.promoteSampleSize ?? 5,
      promoteDeliveredRatio: v.promoteDeliveredRatio ?? 0.8,
      demoteSampleSize: v.demoteSampleSize ?? 10,
      demoteErrorRate: v.demoteErrorRate ?? 0.5,
    };
    this.quoteTtlMs = options.quoteTtlMs ?? 15 * 60 * 1000;
  }

  private providerFor(providerId: string): OpenSmmProvider {
    const node = this.registry.get(providerId);
    if (!node) throw new OpenSmmError("INTERNAL", `no provider registered for ${providerId}`);
    return node.provider;
  }

  getCapabilities(): Capabilities {
    return {
      protocolVersion: PROTOCOL_VERSION,
      commands: ALL_COMMANDS,
      paymentMethods: [...this.paymentMethods],
      features: { cancel: true, refill: true },
      catalogVersion: this.catalog.version,
    };
  }

  /**
   * Pseudonymous public view of connected providers (spec/v0 §9).
   * displayName is published only when the provider opted in.
   */
  async listProviders(): Promise<{ providers: ProviderInfo[] }> {
    const providers: ProviderInfo[] = [];
    for (const node of this.registry.list()) {
      const caps = await node.provider.getCapabilities();
      providers.push({
        providerKey: node.providerKey,
        ...(node.publiclyListed && node.displayName ? { displayName: node.displayName } : {}),
        lifecycle: node.lifecycle,
        capabilities: caps,
        offersCount: this.catalog
          .list()
          .filter((e) => e.providerId === node.providerId && e.service.status === "ACTIVE").length,
        // Gateway-measured only (spec/v0 §9); sparse until the sample justifies it.
        metrics: this.metrics.snapshot(node.providerId),
      });
    }
    return { providers };
  }

  /**
   * Provider self-registration (spec/v0 §10).
   * Flow: SSRF guard -> adapter factory + healthcheck -> catalog sync.
   * Idempotent per endpoint: re-registering the same endpoint returns the
   * existing node without duplicating it.
   */
  async registerProvider(input: RegisterProviderInput): Promise<RegisterProviderResult> {
    if (!this.providerFactory) {
      throw new OpenSmmError("POLICY_DENIED", "provider registration is not enabled on this gateway");
    }
    if (!input.endpoint || !input.apiKey) {
      throw new OpenSmmError("VALIDATION_FAILED", "endpoint and apiKey are required");
    }

    try {
      await assertPublicProviderUrl(input.endpoint, this.ssrf);
    } catch (err) {
      if (err instanceof SsrfBlockedError) {
        throw new OpenSmmError("POLICY_DENIED", `endpoint rejected: ${err.message}`);
      }
      throw err;
    }

    const existing = this.registry
      .list()
      .find((n) => n.endpoint === input.endpoint);
    if (existing) {
      return {
        providerKey: existing.providerKey,
        lifecycle: existing.lifecycle,
        offersCount: this.countOffers(existing.providerId),
        catalogVersion: this.catalog.version,
      };
    }

    const providerId = newId("osmm_node");
    let built: { provider: OpenSmmProvider; offers: ProviderOffer[] };
    try {
      built = await this.providerFactory(input, providerId);
    } catch (err) {
      // The healthcheck is part of the factory: a provider that cannot list
      // its offers is rejected before entering the registry.
      const message = err instanceof Error ? err.message : String(err);
      throw new OpenSmmError("PROVIDER_REJECTED", `provider healthcheck failed: ${message}`);
    }

    const node = this.registry.register({
      providerId,
      provider: built.provider,
      // Self-registered nodes start UNVERIFIED (spec/v0 §10.1): routable but
      // volume-capped until gateway-measured metrics earn ACTIVE.
      lifecycle: "UNVERIFIED",
      endpoint: input.endpoint,
      // Kept for state restore; never exposed through the protocol.
      registrationInput: input,
      ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
      publiclyListed: input.publiclyListed ?? false,
      ...(input.payoutAddress !== undefined ? { payoutAddress: input.payoutAddress } : {}),
      registeredAt: nowIso(),
      lastHealthcheckAt: nowIso(),
    });

    const entries = built.offers.map((offer) => providerOfferToCatalogEntry(offer, providerId));
    if (!this.catalog.syncProvider) {
      throw new OpenSmmError("INTERNAL", "catalog does not support provider sync");
    }
    this.catalog.syncProvider(providerId, entries);

    return {
      providerKey: node.providerKey,
      lifecycle: node.lifecycle,
      offersCount: entries.length,
      catalogVersion: this.catalog.version,
    };
  }

  private countOffers(providerId: string): number {
    return this.catalog
      .list()
      .filter((e) => e.providerId === providerId && e.service.status === "ACTIVE").length;
  }

  searchServices(query: SearchServicesQuery): { services: Service[]; catalogVersion: string } {
    const text = query.query?.trim().toLowerCase();
    const services = this.catalog
      .list()
      // SUSPENDED nodes are excluded from routing and search (spec/v0 §10.1).
      .filter((e) => this.registry.get(e.providerId)?.lifecycle !== "SUSPENDED")
      .filter((e) => e.service.status === "ACTIVE")
      .filter((e) => (query.platform ? e.service.platform === query.platform : true))
      .filter((e) => (query.objective ? e.service.objective === query.objective : true))
      .filter((e) =>
        text
          ? [e.service.name, e.service.description ?? "", e.service.category ?? "", e.service.platform, e.service.objective]
              .join(" ")
              .toLowerCase()
              .includes(text)
          : true,
      )
      .map((e) => this.enrich(e));
    const sort: ServiceSort = query.sort ?? "relevance";
    if (sort === "price") {
      services.sort((a, b) => compareUnitPrice(a, b));
    } else if (sort === "quality") {
      services.sort((a, b) => compareQuality(a.quality, b.quality));
    }
    return { services, catalogVersion: this.catalog.version };
  }

  /**
   * Compare offers for a platform+objective across providers: per provider, its
   * cheapest service that covers the requested quantity, cheapest first, with
   * measured quality and the total price for the requested quantity. SUSPENDED
   * nodes are excluded (§10.1).
   */
  compareOffers(input: {
    platform: Service["platform"];
    objective: Service["objective"];
    quantity?: number;
  }): OfferComparison {
    if (input.quantity !== undefined && (!Number.isInteger(input.quantity) || input.quantity < 1)) {
      throw new OpenSmmError("VALIDATION_FAILED", `invalid quantity: ${input.quantity}`);
    }
    const byProvider = new Map<string, CatalogEntry[]>();
    for (const entry of this.catalog.list()) {
      if (this.registry.get(entry.providerId)?.lifecycle === "SUSPENDED") continue;
      if (entry.service.status !== "ACTIVE") continue;
      if (entry.service.platform !== input.platform) continue;
      if (entry.service.objective !== input.objective) continue;
      const list = byProvider.get(entry.providerId);
      if (list) list.push(entry);
      else byProvider.set(entry.providerId, [entry]);
    }

    const offers: OfferComparisonEntry[] = [];
    for (const [providerId, entries] of byProvider) {
      // One offer per provider: its cheapest service for this platform+objective
      // that covers the requested quantity (without a quantity: the cheapest overall).
      const eligible =
        input.quantity !== undefined
          ? entries.filter(
              (e) =>
                input.quantity! >= e.service.minQuantity &&
                input.quantity! <= e.service.maxQuantity,
            )
          : entries;
      if (eligible.length === 0) continue; // this provider cannot deliver the requested quantity
      const cheapest = eligible.reduce((a, b) =>
        compareUnitPrice(a.service, b.service) <= 0 ? a : b,
      );
      const service = cheapest.service;
      const quantityPriced = input.quantity ?? service.minQuantity;
      const node = this.registry.get(providerId);
      offers.push({
        providerRef: node?.providerKey ?? providerId,
        serviceId: service.serviceId,
        serviceName: service.name,
        rate: service.rate,
        rateBasis: service.rateBasis,
        minQuantity: service.minQuantity,
        maxQuantity: service.maxQuantity,
        quantityPriced,
        total: quoteAmount(service.rate, service.rateBasis, quantityPriced),
        quality: this.qualityFor(service, providerId),
      });
    }
    offers.sort((a, b) =>
      compareUnitPrice(
        { rate: a.rate, rateBasis: a.rateBasis },
        { rate: b.rate, rateBasis: b.rateBasis },
      ),
    );
    return {
      platform: input.platform,
      objective: input.objective,
      ...(input.quantity !== undefined ? { quantity: input.quantity } : {}),
      offers,
      catalogVersion: this.catalog.version,
    };
  }

  /** Gateway enrichment for search results: providerRef + measured quality. */
  private enrich(entry: CatalogEntry): Service {
    const node = this.registry.get(entry.providerId);
    return {
      ...entry.service,
      providerRef: node?.providerKey ?? entry.providerId,
      quality: this.qualityFor(entry.service, entry.providerId),
    };
  }

  private qualityFor(service: Service, providerId: string): OfferQuality {
    const m = this.metrics.snapshot(providerId);
    return {
      ...(service.qualityTier !== undefined ? { tier: service.qualityTier } : {}),
      orders: m.sampleSize,
      ...(m.deliveredRatio !== undefined ? { deliveredRatio: m.deliveredRatio } : {}),
      ...(m.measuredStartP50Sec !== undefined
        ? { startLatencyMs: Math.round(m.measuredStartP50Sec * 1000) }
        : {}),
    };
  }

  getService(serviceId: string): Service {
    const entry = this.catalog.get(serviceId);
    if (!entry || entry.service.status !== "ACTIVE") {
      throw new OpenSmmError("NOT_FOUND", `unknown service: ${serviceId}`);
    }
    return entry.service;
  }

  getQuote(input: CreateQuoteInput): Quote {
    const entry = this.requireEntry(input.serviceId);
    const service = entry.service;
    if (service.status !== "ACTIVE") {
      throw new OpenSmmError("SERVICE_UNAVAILABLE", `service is disabled: ${service.serviceId}`);
    }
    // A SUSPENDED node is out of routing (spec/v0 §10.1): no new quotes on it.
    if (this.registry.get(entry.providerId)?.lifecycle === "SUSPENDED") {
      throw new OpenSmmError("SERVICE_UNAVAILABLE", `service is temporarily unavailable: ${service.serviceId}`);
    }
    this.validateQuantity(service, input.quantity);
    const parameters = input.parameters ?? {};
    this.validateParameters(service, parameters);

    const created = new Date();
    const warnings: string[] = [];
    if (!input.link) {
      warnings.push("quote issued without link; createOrder must supply the final link");
    }

    const amount = quoteAmount(service.rate, service.rateBasis, input.quantity);
    // Anti exit-scam throttle (spec/v0 §10.1): UNVERIFIED nodes are
    // volume-capped per order until measured quality earns ACTIVE.
    const node = this.registry.get(entry.providerId);
    if (node?.lifecycle === "UNVERIFIED") {
      const nominal = Number(amount.value);
      if (nominal > this.verification.maxUnverifiedOrderValue) {
        throw new OpenSmmError(
          "POLICY_DENIED",
          `node is UNVERIFIED: order amount ${amount.value} ${amount.currency} exceeds the per-order cap of ${this.verification.maxUnverifiedOrderValue}`,
          { serviceId: service.serviceId, cap: this.verification.maxUnverifiedOrderValue },
        );
      }
      warnings.push("provider node is UNVERIFIED; per-order volume cap applies");
    }

    const quote: Quote = {
      quoteId: newId("osmm_quote"),
      serviceId: service.serviceId,
      quantity: input.quantity,
      ...(input.link ? { link: input.link } : {}),
      amount,
      catalogVersion: this.catalog.version,
      createdAt: created.toISOString(),
      expiresAt: new Date(created.getTime() + this.quoteTtlMs).toISOString(),
      warnings,
      confirmationRequired: true,
    };
    this.quotes.set(quote.quoteId, { quote, parameters });
    return quote;
  }

  async createOrder(input: CreateOrderInput): Promise<{ order: Order; replayed: boolean }> {
    if (!input.clientReference) {
      throw new OpenSmmError("VALIDATION_FAILED", "clientReference is required");
    }
    const requestHash = this.hashOrderRequest(input);
    const seen = this.idempotency.get(input.clientReference);
    if (seen) {
      if (seen.requestHash !== requestHash) {
        throw new OpenSmmError(
          "IDEMPOTENCY_CONFLICT",
          `clientReference "${input.clientReference}" was already used with different parameters`,
        );
      }
      const existing = this.orders.get(seen.orderId);
      if (!existing) throw new OpenSmmError("INTERNAL", "idempotency record points to a missing order");
      return { order: existing, replayed: true };
    }

    const record = this.quotes.get(input.quoteId);
    if (!record) {
      throw new OpenSmmError("NOT_FOUND", `unknown quote: ${input.quoteId}`);
    }
    if (record.consumedByOrderId) {
      // A quote is consumed exactly once; reuse returns the order created from it.
      const existing = this.orders.get(record.consumedByOrderId);
      if (!existing) throw new OpenSmmError("INTERNAL", "quote points to a missing order");
      return { order: existing, replayed: true };
    }
    const { quote } = record;
    if (Date.parse(quote.expiresAt) <= Date.now()) {
      throw new OpenSmmError("QUOTE_EXPIRED", `quote expired at ${quote.expiresAt}`, {
        quoteId: quote.quoteId,
        expiresAt: quote.expiresAt,
      });
    }

    const quantity = input.quantity ?? quote.quantity;
    if (quantity !== quote.quantity) {
      throw new OpenSmmError("QUOTE_MISMATCH", "quantity differs from the quote", {
        quoted: quote.quantity,
        requested: quantity,
      });
    }
    if (quote.link && quote.link !== input.link) {
      throw new OpenSmmError("QUOTE_MISMATCH", "link differs from the quoted link");
    }
    const entry = this.requireEntry(quote.serviceId);
    const parameters = input.parameters ?? record.parameters;
    this.validateParameters(entry.service, parameters);

    const now = nowIso();
    // Direct settlement (spec/v0 §8): the provider's own payout address is the
    // payTo of its payment requirements; the gateway never custodies funds.
    const payTo = this.registry.get(entry.providerId)?.payoutAddress;
    const requirements = this.buildPaymentRequirements(quote.amount, payTo);
    const paymentIntentId = newId("osmm_pi");
    const order: Order = {
      orderId: newId("osmm_order"),
      quoteId: quote.quoteId,
      clientReference: input.clientReference,
      serviceId: quote.serviceId,
      link: input.link,
      quantity,
      parameters,
      amount: quote.amount,
      paymentStatus: "REQUIRES_PAYMENT",
      executionStatus: "NOT_STARTED",
      paymentIntentId,
      paymentRequirements: requirements,
      createdAt: now,
      updatedAt: now,
    };
    const intent: PaymentIntent = {
      paymentIntentId,
      orderId: order.orderId,
      amount: quote.amount,
      status: "REQUIRES_PAYMENT",
      requirements,
      createdAt: now,
      updatedAt: now,
    };
    this.orders.set(order.orderId, order);
    this.payments.set(intent.paymentIntentId, intent);
    record.consumedByOrderId = order.orderId;
    this.idempotency.set(input.clientReference, { requestHash, orderId: order.orderId });
    return { order, replayed: false };
  }

  async getOrder(orderId: string): Promise<Order> {
    const order = this.orders.get(orderId);
    if (!order) {
      throw new OpenSmmError("NOT_FOUND", `unknown order: ${orderId}`);
    }
    await this.refreshExecution(order);
    return order;
  }

  getPayment(paymentIntentId: string): PaymentIntent {
    const intent = this.payments.get(paymentIntentId);
    if (!intent) {
      throw new OpenSmmError("NOT_FOUND", `unknown payment intent: ${paymentIntentId}`);
    }
    return intent;
  }

  /**
   * Settle a payment intent through the matching rail. Without rails configured
   * the dev-only mock rail settles instantly. A "pending" outcome moves the
   * intent to SETTLEMENT_PENDING — poll, never re-pay.
   */
  async settlePayment(paymentIntentId: string, opts: SettleOptions = {}): Promise<PaymentIntent> {
    const intent = this.getPayment(paymentIntentId);
    if (intent.status === "SETTLED") {
      return intent;
    }
    if (!["REQUIRES_PAYMENT", "VERIFYING", "SETTLEMENT_PENDING"].includes(intent.status)) {
      throw new OpenSmmError(
        "SETTLEMENT_PENDING",
        `payment intent is ${intent.status}; it cannot be settled now`,
        { paymentIntentId, status: intent.status },
      );
    }

    const method = opts.method ?? "mock";
    const rail = this.rails.get(method);
    if (method === "mock" && !rail && !this.paymentMethods.includes("mock")) {
      // The dev-only mock rail must never be settleable in production config.
      throw new OpenSmmError("VALIDATION_FAILED", "mock payment rail is not enabled", {
        available: this.paymentMethods,
      });
    }
    if (!rail && method !== "mock") {
      throw new OpenSmmError("VALIDATION_FAILED", `payment method is not available: ${method}`, {
        available: this.paymentMethods,
      });
    }

    const order = this.requireOrder(intent.orderId);
    let outcome: "settled" | "pending" = "settled";
    let txHash: string | undefined;

    if (rail) {
      let result;
      try {
        result = await rail.settle(intent, opts.proof);
      } catch (err) {
        if (err instanceof PaymentRejectedError) {
          throw new OpenSmmError("PAYMENT_REQUIRED", err.message, { paymentIntentId, method });
        }
        throw err;
      }
      outcome = result.outcome;
      txHash = result.txHash;
    }

    if (outcome === "pending") {
      // Accepted by the settlement layer, finality later. NOT an error.
      this.setPaymentStatus(order, "SETTLEMENT_PENDING");
      return intent;
    }

    intent.status = "SETTLED";
    intent.settledWith = method;
    if (txHash) intent.txHash = txHash;
    intent.updatedAt = nowIso();
    this.setPaymentStatus(order, "SETTLED");
    await this.submitToProvider(order);
    return intent;
  }

  async cancelOrder(orderId: string): Promise<Order> {
    const order = this.requireOrder(orderId);
    await this.refreshExecution(order);

    if (order.executionStatus === "NOT_STARTED") {
      if (order.paymentStatus !== "REQUIRES_PAYMENT") {
        throw new OpenSmmError("SERVICE_UNAVAILABLE", `cannot cancel order in state ${order.executionStatus}/${order.paymentStatus}`);
      }
      this.setExecutionStatus(order, "CANCELED");
      this.setPaymentStatus(order, "FAILED");
      return order;
    }

    if (TERMINAL_EXECUTION.has(order.executionStatus) || order.executionStatus === "SUBMISSION_UNKNOWN") {
      throw new OpenSmmError(
        "SERVICE_UNAVAILABLE",
        `cannot cancel order in execution state ${order.executionStatus}`,
      );
    }

    const entry = this.requireEntry(order.serviceId);
    const provider = this.providerFor(entry.providerId);
    if (!entry.service.capabilities.cancel || !provider.cancelExecution) {
      throw new OpenSmmError("SERVICE_UNAVAILABLE", `service ${order.serviceId} does not support cancel`);
    }
    const exec = this.executions.get(order.orderId);
    if (!exec) throw new OpenSmmError("INTERNAL", "execution record missing");
    const result = await provider.cancelExecution(exec.externalExecutionId);
    if (!result.canceled) {
      throw new OpenSmmError("PROVIDER_REJECTED", result.reason ?? "provider refused cancellation");
    }
    this.setExecutionStatus(order, "CANCELED");
    this.setPaymentStatus(order, "REFUNDING");
    return order;
  }

  async requestRefill(orderId: string): Promise<RefillResult> {
    const order = this.requireOrder(orderId);
    if (order.executionStatus !== "COMPLETED" && order.executionStatus !== "PARTIAL") {
      throw new OpenSmmError(
        "SERVICE_UNAVAILABLE",
        `refill requires a COMPLETED or PARTIAL order, got ${order.executionStatus}`,
      );
    }
    const entry = this.requireEntry(order.serviceId);
    const provider = this.providerFor(entry.providerId);
    if (!entry.service.capabilities.refill || !provider.requestRefill) {
      throw new OpenSmmError("SERVICE_UNAVAILABLE", `service ${order.serviceId} does not support refill`);
    }
    const exec = this.executions.get(order.orderId);
    if (!exec) throw new OpenSmmError("INTERNAL", "execution record missing");
    const refill = await provider.requestRefill(exec.externalExecutionId);
    this.refills.set(order.orderId, refill.externalRefillId);
    return { refillId: refill.externalRefillId, orderId: order.orderId, status: "REQUESTED" };
  }

  // --- internals -----------------------------------------------------------

  private requireEntry(serviceId: string): CatalogEntry {
    const entry = this.catalog.get(serviceId);
    if (!entry) {
      throw new OpenSmmError("NOT_FOUND", `unknown service: ${serviceId}`);
    }
    return entry;
  }

  private requireOrder(orderId: string): Order {
    const order = this.orders.get(orderId);
    if (!order) {
      throw new OpenSmmError("NOT_FOUND", `unknown order: ${orderId}`);
    }
    return order;
  }

  private validateQuantity(service: Service, quantity: number): void {
    if (!Number.isInteger(quantity) || quantity < service.minQuantity || quantity > service.maxQuantity) {
      throw new OpenSmmError(
        "VALIDATION_FAILED",
        `quantity must be an integer between ${service.minQuantity} and ${service.maxQuantity}`,
        { serviceId: service.serviceId, quantity },
      );
    }
  }

  private validateParameters(service: Service, parameters: Record<string, unknown>): void {
    for (const param of service.parameters) {
      const value = parameters[param.name];
      if (value === undefined) {
        if (param.required) {
          throw new OpenSmmError("VALIDATION_FAILED", `missing required parameter: ${param.name}`, {
            serviceId: service.serviceId,
          });
        }
        continue;
      }
      const ok =
        (param.type === "string" && typeof value === "string") ||
        (param.type === "integer" && Number.isInteger(value)) ||
        (param.type === "boolean" && typeof value === "boolean") ||
        (param.type === "string_list" &&
          Array.isArray(value) &&
          value.every((v) => typeof v === "string"));
      if (!ok) {
        throw new OpenSmmError(
          "VALIDATION_FAILED",
          `parameter ${param.name} must be ${param.type}`,
          { serviceId: service.serviceId },
        );
      }
    }
  }

  private buildPaymentRequirements(amount: Money, payTo?: string): PaymentRequirement[] {
    return this.paymentMethods.map((method) => {
      const rail = this.rails.get(method);
      return rail ? rail.buildRequirements(amount, payTo) : { method, amount: { ...amount } };
    });
  }

  private hashOrderRequest(input: CreateOrderInput): string {
    return createHash("sha256")
      .update(
        JSON.stringify({
          quoteId: input.quoteId,
          link: input.link,
          quantity: input.quantity ?? null,
          parameters: input.parameters ?? null,
        }),
      )
      .digest("hex");
  }

  private setPaymentStatus(order: Order, status: PaymentStatus): void {
    order.paymentStatus = status;
    order.updatedAt = nowIso();
    if (order.paymentIntentId) {
      const intent = this.payments.get(order.paymentIntentId);
      if (intent && intent.status !== "SETTLED") {
        if (status !== "NOT_REQUIRED" && status !== "SETTLED") {
          intent.status = status;
          intent.updatedAt = order.updatedAt;
        }
      }
    }
    if (status !== "REQUIRES_PAYMENT") {
      delete order.paymentRequirements;
    }
  }

  private setExecutionStatus(order: Order, status: Order["executionStatus"]): void {
    order.executionStatus = status;
    order.updatedAt = nowIso();
  }

  /** Submission outcome mapping; no blind retries anywhere. */
  private async submitToProvider(order: Order): Promise<void> {
    const entry = this.requireEntry(order.serviceId);
    const provider = this.providerFor(entry.providerId);
    this.setExecutionStatus(order, "SUBMITTING");
    try {
      const ref = await provider.createExecution({
        externalServiceId: entry.externalServiceId,
        link: order.link,
        quantity: order.quantity,
        parameters: order.parameters,
      });
      this.executions.set(order.orderId, {
        externalExecutionId: ref.externalExecutionId,
        submittedAt: Date.now(),
        maxDelivered: 0,
      });
      this.metrics.recordSubmission(entry.providerId);
      this.setExecutionStatus(order, "PENDING");
    } catch (err) {
      if (err instanceof ProviderRejectedError) {
        // Definitive refusal: execution ERROR, payment heads to refund.
        this.metrics.recordRejection(entry.providerId, order.quantity);
        this.evaluateNode(entry.providerId);
        this.setExecutionStatus(order, "ERROR");
        this.setPaymentStatus(order, "REFUNDING");
        return;
      }
      if (err instanceof SubmissionAmbiguousError) {
        // Unknown outcome: reconcile manually, never resubmit blindly.
        this.setExecutionStatus(order, "SUBMISSION_UNKNOWN");
        return;
      }
      // Network/timeout/etc: outcome unknowable — treat as ambiguous.
      this.setExecutionStatus(order, "SUBMISSION_UNKNOWN");
      return;
    }
  }

  /**
   * Lifecycle transitions computed from gateway-measured metrics (spec/v0
   * §10.1): promotion UNVERIFIED → ACTIVE on proven quality, demotion
   * ACTIVE → SUSPENDED on measured failure. Runs after every recorded outcome.
   */
  private evaluateNode(providerId: string): void {
    const node = this.registry.get(providerId);
    if (!node) return;
    const m = this.metrics.snapshot(providerId);
    if (node.lifecycle === "UNVERIFIED") {
      if (
        m.sampleSize >= this.verification.promoteSampleSize &&
        (m.deliveredRatio ?? 0) >= this.verification.promoteDeliveredRatio &&
        (m.errorRate ?? 1) <= 1 - this.verification.promoteDeliveredRatio
      ) {
        this.registry.setLifecycle(providerId, "ACTIVE");
      }
      return;
    }
    if (node.lifecycle === "ACTIVE") {
      if (m.sampleSize >= this.verification.demoteSampleSize && (m.errorRate ?? 0) > this.verification.demoteErrorRate) {
        this.registry.setLifecycle(providerId, "SUSPENDED");
      }
    }
  }

  /**
   * Run due retention re-checks: re-poll completed executions and record how
   * much of the delivered volume survived (retentionD7, spec/v0 §9.1).
   * Returns the number of checks performed. Safe to call on an interval.
   */
  async runRetentionChecks(): Promise<number> {
    const now = Date.now();
    let checked = 0;
    for (const [orderId, exec] of this.executions) {
      if (
        exec.retentionDone ||
        exec.retentionDueAt === undefined ||
        exec.retentionDueAt > now ||
        exec.deliveredAtCompletion === undefined
      ) {
        continue;
      }
      exec.retentionDone = true; // never retry: a failed re-check is skipped, not fatal
      try {
        const order = this.orders.get(orderId);
        if (!order) continue;
        const entry = this.requireEntry(order.serviceId);
        const snapshot = await this.providerFor(entry.providerId).getExecution(exec.externalExecutionId);
        if (snapshot.delivered !== undefined && exec.deliveredAtCompletion > 0) {
          this.metrics.recordRetention(
            entry.providerId,
            snapshot.delivered / exec.deliveredAtCompletion,
          );
          checked += 1;
        }
      } catch {
        // Provider unreachable at re-check time: no data, no penalty.
      }
    }
    return checked;
  }

  /** Poll every in-flight execution; returns the number of orders refreshed. */
  async refreshActiveOrders(): Promise<number> {
    let refreshed = 0;
    for (const order of this.orders.values()) {
      if (["PENDING", "IN_PROGRESS", "PARTIAL"].includes(order.executionStatus)) {
        await this.refreshExecution(order);
        refreshed += 1;
      }
    }
    return refreshed;
  }

  private async refreshExecution(order: Order): Promise<void> {
    const exec = this.executions.get(order.orderId);
    if (!exec || TERMINAL_EXECUTION.has(order.executionStatus)) {
      return;
    }
    if (!["PENDING", "IN_PROGRESS", "PARTIAL"].includes(order.executionStatus)) {
      return;
    }
    try {
      const entry = this.requireEntry(order.serviceId);
      const snapshot = await this.providerFor(entry.providerId).getExecution(exec.externalExecutionId);
      exec.latestSnapshot = snapshot;
      const now = Date.now();
      // Metrics: first progress, delivery high-water mark, terminal outcome.
      if (
        exec.firstProgressAt === undefined &&
        (snapshot.status === "IN_PROGRESS" || snapshot.status === "PARTIAL" || snapshot.status === "COMPLETED")
      ) {
        exec.firstProgressAt = now;
        this.metrics.recordStart(entry.providerId, (now - exec.submittedAt) / 1000);
      }
      if (snapshot.delivered !== undefined) {
        exec.maxDelivered = Math.max(exec.maxDelivered, snapshot.delivered);
      }
      if (snapshot.status !== order.executionStatus) {
        this.setExecutionStatus(order, snapshot.status);
      }
      if (exec.completedAt === undefined && TERMINAL_EXECUTION.has(snapshot.status)) {
        exec.completedAt = now;
        const delivered = snapshot.delivered ?? exec.maxDelivered;
        this.metrics.recordTerminal(entry.providerId, snapshot.status as "COMPLETED" | "CANCELED" | "ERROR", {
          orderedUnits: order.quantity,
          deliveredUnits: delivered,
          completionLatencySec: (now - exec.submittedAt) / 1000,
        });
        // Schedule the delayed retention re-check for delivered orders
        // (spec/v0 §9.1 retentionD7): drops after completion downgrade the node.
        if (snapshot.status === "COMPLETED" && delivered > 0) {
          exec.deliveredAtCompletion = delivered;
          exec.retentionDueAt = now + this.retentionCheckMs;
        }
        this.evaluateNode(entry.providerId);
      }
    } catch {
      // Polling failure never moves the order backwards; keep last known status.
    }
  }

  // --- state persistence -----------------------------------------------------

  /**
   * Snapshot of the full gateway state (orders, payments, executions,
   * idempotency, metrics, self-registered nodes). Bootstrap providers are NOT
   * included — they are recreated from env config on boot.
   */
  exportState(): CoreSnapshot {
    return {
      format: 1,
      savedAt: nowIso(),
      quotes: [...this.quotes.entries()],
      orders: [...this.orders.values()],
      payments: [...this.payments.values()],
      executions: [...this.executions.entries()],
      refills: [...this.refills.entries()],
      idempotency: [...this.idempotency.entries()],
      metrics: this.metrics.exportState(),
      nodes: this.registry
        .list()
        .filter((n) => n.registrationInput !== undefined)
        .map((n) => {
          const node: NodeSnapshot = {
            providerId: n.providerId,
            providerKey: n.providerKey,
            lifecycle: n.lifecycle,
            publiclyListed: n.publiclyListed,
            registeredAt: n.registeredAt,
            registrationInput: n.registrationInput!,
            ...(n.displayName !== undefined ? { displayName: n.displayName } : {}),
            ...(n.payoutAddress !== undefined ? { payoutAddress: n.payoutAddress } : {}),
            ...(n.lastHealthcheckAt !== undefined ? { lastHealthcheckAt: n.lastHealthcheckAt } : {}),
          };
          return node;
        }),
    };
  }

  /**
   * Restore a snapshot. Adapters are rebuilt through `buildProvider` (no
   * healthcheck): a node whose offers cannot be listed right now comes back
   * as SUSPENDED and the supervisor reactivates it on the next good sync.
   */
  async importState(snapshot: CoreSnapshot, buildProvider: ProviderBuilder): Promise<{ restoredNodes: number }> {
    if (snapshot.format !== 1) {
      throw new OpenSmmError("INTERNAL", `unsupported state format: ${snapshot.format}`);
    }
    for (const [k, v] of snapshot.quotes) this.quotes.set(k, v);
    for (const order of snapshot.orders) this.orders.set(order.orderId, order);
    for (const intent of snapshot.payments) this.payments.set(intent.paymentIntentId, intent);
    for (const [k, v] of snapshot.executions) this.executions.set(k, v);
    for (const [k, v] of snapshot.refills) this.refills.set(k, v);
    for (const [k, v] of snapshot.idempotency) this.idempotency.set(k, v);
    this.metrics.importState(snapshot.metrics);

    let restoredNodes = 0;
    for (const node of snapshot.nodes) {
      if (this.registry.get(node.providerId)) continue; // already live (env config)
      let provider: OpenSmmProvider;
      try {
        provider = await buildProvider(node.registrationInput, node.providerId);
      } catch {
        continue; // unrebuildable adapter config — skip, do not lose the rest
      }
      this.registry.register({
        providerId: node.providerId,
        provider,
        providerKey: node.providerKey,
        lifecycle: node.lifecycle,
        endpoint: node.registrationInput.endpoint,
        registrationInput: node.registrationInput,
        ...(node.displayName !== undefined ? { displayName: node.displayName } : {}),
        publiclyListed: node.publiclyListed,
        ...(node.payoutAddress !== undefined ? { payoutAddress: node.payoutAddress } : {}),
        registeredAt: node.registeredAt,
        ...(node.lastHealthcheckAt !== undefined ? { lastHealthcheckAt: node.lastHealthcheckAt } : {}),
      });
      try {
        const offers = await provider.listOffers();
        if (!this.catalog.syncProvider) {
          throw new OpenSmmError("INTERNAL", "catalog does not support provider sync");
        }
        this.catalog.syncProvider(
          node.providerId,
          offers.map((offer) => providerOfferToCatalogEntry(offer, node.providerId)),
        );
      } catch {
        // Provider unreachable at boot: keep it SUSPENDED, supervisor recovers it.
        this.registry.setLifecycle(node.providerId, "SUSPENDED");
      }
      restoredNodes += 1;
    }
    return { restoredNodes };
  }
}
