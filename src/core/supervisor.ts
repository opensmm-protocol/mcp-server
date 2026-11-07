/**
 * Node supervision (spec/v0 §10.1, §10.4): periodic catalog sync with a
 * circuit breaker, plus background polling of in-flight orders.
 *
 * The breaker is deliberately simple and fully observable:
 * - every sync tick calls `listOffers` on each node and re-syncs its catalog
 *   entries (prices and availability drift; the catalog must follow);
 * - `failureThreshold` consecutive sync failures move the node to SUSPENDED —
 *   it disappears from search and stops receiving quotes, but its in-flight
 *   orders keep polling to completion;
 * - the first successful sync resets the counter and reactivates the node.
 *
 * `tickSync`/`tickPoll` are the manual driving interface (tests, cron-style
 * embedding); `start()` wires them to interval timers.
 */

import type { Catalog } from "./catalog.ts";
import { providerOfferToCatalogEntry } from "./catalog-map.ts";
import { nowIso } from "./ids.ts";
import type { ProviderRegistry } from "./provider-registry.ts";

export interface SyncReport {
  providerId: string;
  ok: boolean;
  offersCount?: number;
  error?: string;
  lifecycle: string;
  /** True when the sync was intentionally skipped (curated catalog mode). */
  skipped?: boolean;
}

export interface SupervisorOptions {
  registry: ProviderRegistry;
  catalog: Catalog;
  /** Background order polling; typically `core.refreshActiveOrders()`. */
  pollActiveOrders?: () => Promise<number>;
  /** Retention re-checks; typically `core.runRetentionChecks()`. */
  runRetentionChecks?: () => Promise<number>;
  /** Catalog sync interval when started. Default 5 minutes. */
  syncIntervalMs?: number;
  /** Order poll interval when started. Default 30 seconds. */
  pollIntervalMs?: number;
  /** Retention re-check interval when started. Default 1 hour. */
  retentionIntervalMs?: number;
  /** Consecutive sync failures that suspend a node. Default 3. */
  failureThreshold?: number;
  /**
   * Catalog sync on/off. A curated public catalog is a hand-reviewed
   * snapshot: syncing provider offers over it would drop the curation.
   * Default true; healthchecks then stop driving the lifecycle too.
   */
  syncCatalog?: boolean;
}

export class NodeSupervisor {
  private readonly registry: ProviderRegistry;
  private readonly catalog: Catalog;
  private readonly pollActive?: () => Promise<number>;
  private readonly retentionChecks?: () => Promise<number>;
  private readonly syncIntervalMs: number;
  private readonly pollIntervalMs: number;
  private readonly retentionIntervalMs: number;
  private readonly failureThreshold: number;
  private readonly syncCatalog: boolean;
  private readonly failures = new Map<string, number>();
  private timers: ReturnType<typeof setInterval>[] = [];

  constructor(options: SupervisorOptions) {
    this.registry = options.registry;
    this.catalog = options.catalog;
    if (options.pollActiveOrders) this.pollActive = options.pollActiveOrders;
    if (options.runRetentionChecks) this.retentionChecks = options.runRetentionChecks;
    this.syncIntervalMs = options.syncIntervalMs ?? 5 * 60 * 1000;
    this.pollIntervalMs = options.pollIntervalMs ?? 30 * 1000;
    this.retentionIntervalMs = options.retentionIntervalMs ?? 60 * 60 * 1000;
    this.failureThreshold = options.failureThreshold ?? 3;
    this.syncCatalog = options.syncCatalog ?? true;
  }

  /** Sync one node: refresh its catalog entries and drive the breaker. */
  async tickSync(providerId: string): Promise<SyncReport> {
    const node = this.registry.get(providerId);
    if (!node) {
      return { providerId, ok: false, error: "unknown provider", lifecycle: "SUSPENDED" };
    }
    if (!this.syncCatalog) {
      // Curated catalog: provider sync would overwrite the reviewed set.
      // Disabled by design, not a failure — keep it out of the error path.
      return { providerId, ok: true, skipped: true, lifecycle: node.lifecycle };
    }
    if (!this.catalog.syncProvider) {
      return { providerId, ok: false, error: "catalog does not support sync", lifecycle: node.lifecycle };
    }
    try {
      const offers = await node.provider.listOffers();
      const entries = offers.map((offer) => providerOfferToCatalogEntry(offer, providerId));
      this.catalog.syncProvider(providerId, entries);
      this.failures.set(providerId, 0);
      node.lastHealthcheckAt = nowIso();
      // Successful sync reactivates a breaker-suspended node.
      if (node.lifecycle === "SUSPENDED") {
        this.registry.setLifecycle(providerId, "ACTIVE");
      }
      return { providerId, ok: true, offersCount: entries.length, lifecycle: node.lifecycle };
    } catch (err) {
      const count = (this.failures.get(providerId) ?? 0) + 1;
      this.failures.set(providerId, count);
      if (count >= this.failureThreshold && node.lifecycle === "ACTIVE") {
        // SUSPENDED: out of routing and search; in-flight orders keep polling.
        this.registry.setLifecycle(providerId, "SUSPENDED");
      }
      const message = err instanceof Error ? err.message : String(err);
      return { providerId, ok: false, error: message, lifecycle: node.lifecycle };
    }
  }

  /** Sync every registered node; one node's failure never stops the others. */
  async tickSyncAll(): Promise<SyncReport[]> {
    const reports: SyncReport[] = [];
    for (const node of this.registry.list()) {
      reports.push(await this.tickSync(node.providerId));
    }
    return reports;
  }

  /** Poll in-flight orders through the core; returns refreshed count. */
  async tickPoll(): Promise<number> {
    return this.pollActive ? this.pollActive() : 0;
  }

  /** Run due retention re-checks (spec/v0 §9.1); returns checks performed. */
  async tickRetention(): Promise<number> {
    return this.retentionChecks ? this.retentionChecks() : 0;
  }

  /** Current consecutive sync failure count (inspection / tests). */
  consecutiveFailures(providerId: string): number {
    return this.failures.get(providerId) ?? 0;
  }

  /** Start interval-driven supervision. Idempotent; timers are unref'd. */
  start(): void {
    if (this.timers.length > 0) return;
    if (this.syncCatalog) {
      const sync = setInterval(() => void this.tickSyncAll(), this.syncIntervalMs);
      sync.unref();
      this.timers.push(sync);
    }
    if (this.pollActive) {
      const poll = setInterval(() => void this.tickPoll(), this.pollIntervalMs);
      poll.unref();
      this.timers.push(poll);
    }
    if (this.retentionChecks) {
      const retention = setInterval(() => void this.tickRetention(), this.retentionIntervalMs);
      retention.unref();
      this.timers.push(retention);
    }
  }

  stop(): void {
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
  }
}
