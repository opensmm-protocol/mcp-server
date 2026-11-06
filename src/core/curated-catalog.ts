/**
 * Curated public catalog (README «Public MVP»): a hand-reviewed snapshot of
 * sellable services, served without any provider API call at boot.
 *
 * Every record carries `provenance` — the provider and the provider-side id it
 * was copied from, plus the source URL and the sync timestamp — so a published
 * price can always be traced back. Validation is fail-closed: a broken file
 * stops the gateway with an actionable error instead of serving a partial or
 * invented catalog.
 *
 * Wire format stays `Service` (spec/v0 §4): the curated record adds only
 * provenance and curation metadata around it.
 */

import { readFileSync } from "node:fs";
import { z } from "zod";
import { InMemoryCatalog, type CatalogEntry } from "./catalog.ts";
import type { Platform, Objective, RateBasis, Service } from "./types.ts";

export const CURATED_FORMAT = 1;

/** Rates are decimal strings per rate basis; outside this range it is a data error. */
export const CURATED_MIN_RATE_VALUE = 0.000001;
export const CURATED_MAX_RATE_VALUE = 10_000;

/** Curator's quality score; 0–5, optional. */
export const CURATED_MAX_RATING = 5;

const moneySchema = z.strictObject({
  value: z
    .string()
    .regex(/^\d{1,7}(\.\d{1,6})?$/, "must be a decimal string with at most 6 fraction digits"),
  currency: z.string().min(1).max(16),
});

const serviceParameterSchema = z.strictObject({
  name: z.string().min(1).max(64),
  type: z.enum(["string", "string_list", "integer", "boolean"]),
  required: z.boolean(),
  description: z.string().max(500).optional(),
});

const serviceSchema = z.strictObject({
  serviceId: z.string().regex(/^osmm_svc_/, "must start with osmm_svc_"),
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  platform: z.enum(["telegram", "instagram", "youtube", "tiktok", "x", "vk", "other"]),
  objective: z.enum(["followers", "members", "likes", "views", "reactions", "comments", "other"]),
  category: z.string().min(1).max(120).optional(),
  rate: moneySchema,
  rateBasis: z.enum(["PER_1000", "PER_UNIT", "PER_PACKAGE"]),
  minQuantity: z.number().int().min(1),
  maxQuantity: z.number().int().min(1),
  qualityTier: z.enum(["economy", "standard", "premium"]).optional(),
  parameters: z.array(serviceParameterSchema),
  capabilities: z.strictObject({
    refill: z.boolean(),
    cancel: z.boolean(),
    dripfeed: z.boolean(),
  }),
  status: z.enum(["ACTIVE", "DISABLED"]),
});

const provenanceSchema = z.strictObject({
  providerId: z.string().min(1).max(64),
  externalServiceId: z.string().min(1).max(64),
  sourceUrl: z.url(),
  syncedAt: z.iso.datetime(),
});

const entrySchema = z.strictObject({
  service: serviceSchema,
  provenance: provenanceSchema,
  rating: z.number().min(0).max(CURATED_MAX_RATING).optional(),
  /** True for placeholder records that must never reach a production catalog. */
  example: z.boolean().optional(),
});

const fileSchema = z.strictObject({
  format: z.literal(CURATED_FORMAT),
  version: z.string().min(1),
  entries: z.array(entrySchema).min(1),
});

export interface CuratedProvenance {
  providerId: string;
  externalServiceId: string;
  sourceUrl: string;
  syncedAt: string;
}

export interface CuratedServiceRecord {
  service: Service;
  provenance: CuratedProvenance;
  rating?: number;
  example?: boolean;
}

export interface CuratedCatalogFile {
  format: typeof CURATED_FORMAT;
  version: string;
  entries: CuratedServiceRecord[];
}

export interface LoadedCuratedCatalog {
  path: string;
  file: CuratedCatalogFile;
  catalog: InMemoryCatalog;
  exampleCount: number;
}

/** A curated catalog that cannot be trusted; the gateway must refuse to boot. */
export class CuratedCatalogError extends Error {
  readonly source: string;
  readonly issues: string[];

  constructor(source: string, issues: string[]) {
    super(`curated catalog ${source} rejected: ${issues.join("; ")}`);
    this.name = "CuratedCatalogError";
    this.source = source;
    this.issues = issues;
  }
}

function formatZodIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const at = issue.path.length > 0 ? issue.path.join(".") : "(root)";
    return `${at}: ${issue.message}`;
  });
}

/**
 * Validate a parsed catalog document: shape, then the rules that span
 * records (unique ids, unique provider offers, sane ranges).
 */
export function parseCuratedCatalog(
  raw: unknown,
  source = "OPENSMM_CURATED_CATALOG",
): CuratedCatalogFile {
  const parsed = fileSchema.safeParse(raw);
  if (!parsed.success) {
    throw new CuratedCatalogError(source, formatZodIssues(parsed.error));
  }
  const file = parsed.data;
  const issues: string[] = [];
  const serviceIds = new Map<string, number>();
  const providerOffers = new Map<string, number>();

  file.entries.forEach((entry, index) => {
    const at = `entries[${index}]`;

    const knownService = serviceIds.get(entry.service.serviceId);
    if (knownService !== undefined) {
      issues.push(
        `${at}.service.serviceId: duplicate ${entry.service.serviceId} (also entries[${knownService}])`,
      );
    } else {
      serviceIds.set(entry.service.serviceId, index);
    }

    const offerKey = `${entry.provenance.providerId}/${entry.provenance.externalServiceId}`;
    const knownOffer = providerOffers.get(offerKey);
    if (knownOffer !== undefined) {
      issues.push(
        `${at}.provenance: duplicate provider offer ${offerKey} (also entries[${knownOffer}])`,
      );
    } else {
      providerOffers.set(offerKey, index);
    }

    if (!entry.provenance.sourceUrl.startsWith("https://")) {
      issues.push(`${at}.provenance.sourceUrl: must be an https URL`);
    }

    const rate = Number(entry.service.rate.value);
    if (!(rate >= CURATED_MIN_RATE_VALUE && rate <= CURATED_MAX_RATE_VALUE)) {
      issues.push(
        `${at}.service.rate.value: ${entry.service.rate.value} is outside ` +
          `${CURATED_MIN_RATE_VALUE}..${CURATED_MAX_RATE_VALUE}`,
      );
    }

    if (entry.service.maxQuantity < entry.service.minQuantity) {
      issues.push(
        `${at}.service.maxQuantity: ${entry.service.maxQuantity} is below minQuantity ` +
          `${entry.service.minQuantity}`,
      );
    }
  });

  if (issues.length > 0) {
    throw new CuratedCatalogError(source, issues);
  }
  return file;
}

/** Read and validate a curated catalog file; any problem is fatal. */
export function loadCuratedCatalog(path: string): LoadedCuratedCatalog {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new CuratedCatalogError(path, [`cannot read JSON: ${message}`]);
  }
  const file = parseCuratedCatalog(raw, path);
  const entries: CatalogEntry[] = file.entries.map((entry) => ({
    service: entry.service,
    providerId: entry.provenance.providerId,
    externalServiceId: entry.provenance.externalServiceId,
  }));
  return {
    path,
    file,
    catalog: new InMemoryCatalog(entries, file.version),
    exampleCount: file.entries.filter((entry) => entry.example === true).length,
  };
}

/**
 * Every provenance.providerId must be a provider registered at boot, otherwise
 * the catalog would advertise services the gateway cannot route or execute.
 */
export function assertCuratedProviders(
  loaded: LoadedCuratedCatalog | undefined,
  providerIds: string[],
): void {
  if (!loaded) return;
  const known = new Set(providerIds);
  const unknown = [
    ...new Set(
      loaded.file.entries
        .map((entry) => entry.provenance.providerId)
        .filter((providerId) => !known.has(providerId)),
    ),
  ];
  if (unknown.length > 0) {
    throw new CuratedCatalogError(loaded.path, [
      `unknown providerId: ${unknown.join(", ")}; registered providers: ${providerIds.join(", ") || "(none)"}`,
    ]);
  }
}

// Exported for schema tests: the enums must track the protocol model.
export const CURATED_PLATFORMS: readonly Platform[] = serviceSchema.shape.platform.options;
export const CURATED_OBJECTIVES: readonly Objective[] = serviceSchema.shape.objective.options;
export const CURATED_RATE_BASES: readonly RateBasis[] = serviceSchema.shape.rateBasis.options;
