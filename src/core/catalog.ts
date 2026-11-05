/**
 * Gateway catalog: curated sellable Services mapped to provider offers.
 * serviceId is gateway-stable; the provider mapping is an implementation detail.
 */

import type { Service } from "./types.ts";

export interface CatalogEntry {
  service: Service;
  providerId: string;
  externalServiceId: string;
}

export interface Catalog {
  readonly version: string;
  list(): CatalogEntry[];
  get(serviceId: string): CatalogEntry | undefined;
  /** Replace all entries of a provider (registration / re-sync). Optional. */
  syncProvider?(providerId: string, entries: CatalogEntry[]): void;
}

export class InMemoryCatalog implements Catalog {
  private currentVersion: string;
  private readonly entries = new Map<string, CatalogEntry>();

  constructor(entries: CatalogEntry[], version?: string) {
    this.currentVersion = version ?? new Date().toISOString();
    for (const entry of entries) {
      this.entries.set(entry.service.serviceId, entry);
    }
  }

  get version(): string {
    return this.currentVersion;
  }

  list(): CatalogEntry[] {
    return [...this.entries.values()];
  }

  get(serviceId: string): CatalogEntry | undefined {
    return this.entries.get(serviceId);
  }

  /** Replace all entries of a provider (registration / catalog re-sync). */
  syncProvider(providerId: string, entries: CatalogEntry[]): void {
    for (const [serviceId, entry] of this.entries) {
      if (entry.providerId === providerId) this.entries.delete(serviceId);
    }
    for (const entry of entries) {
      this.entries.set(entry.service.serviceId, entry);
    }
    this.currentVersion = new Date().toISOString();
  }

  removeProvider(providerId: string): void {
    this.syncProvider(providerId, []);
  }
}
