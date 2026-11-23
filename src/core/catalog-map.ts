/**
 * Generic mapping of provider offers to gateway CatalogEntries.
 * Platform/objective are inferred from the offer's category and name —
 * legacy catalogs have no structured fields for them.
 */

import type { CatalogEntry } from "./catalog.ts";
import { normalizeCurrencyCode } from "./money.ts";
import type { Objective, Platform } from "./types.ts";
import type { ProviderOffer } from "./provider-spi.ts";

const PLATFORM_KEYWORDS: [RegExp, Platform][] = [
  [/tele?gram|tg\b/i, "telegram"],
  [/insta|ig\b/i, "instagram"],
  [/youtube|yt\b/i, "youtube"],
  [/tik\s?tok|tt\b/i, "tiktok"],
  [/twitter|(?<![a-z])x(?![a-z])|\btw\b/i, "x"],
  [/vk(?:ontakte)?\b/i, "vk"],
];

const OBJECTIVE_KEYWORDS: [RegExp, Objective][] = [
  [/member|subscriber/i, "members"],
  [/follower/i, "followers"],
  [/like|\u043b\u0430\u0439\u043a/i, "likes"],
  [/view|watch|impression|\u043f\u0440\u043e\u0441\u043c\u043e\u0442\u0440/i, "views"],
  [/reaction|\u0440\u0435\u0430\u043a\u0446\u0438/i, "reactions"],
  [/comment|\u043a\u043e\u043c\u043c\u0435\u043d\u0442\u0430\u0440/i, "comments"],
];

export function inferPlatform(text: string): Platform {
  for (const [re, platform] of PLATFORM_KEYWORDS) {
    if (re.test(text)) return platform;
  }
  return "other";
}

export function inferObjective(text: string, platform?: Platform): Objective {
  // Russian-language catalogs label both Telegram members and site followers
  // with one word for "subscribers" (written as \u escapes below).
  if (/\u043f\u043e\u0434\u043f\u0438\u0441\u0447\u0438\u043a/i.test(text)) return platform === "telegram" ? "members" : "followers";
  for (const [re, objective] of OBJECTIVE_KEYWORDS) {
    if (re.test(text)) return objective;
  }
  return "other";
}

export function providerOfferToCatalogEntry(offer: ProviderOffer, providerId: string): CatalogEntry {
  const haystack = `${offer.category ?? ""} ${offer.name}`;
  const platform = inferPlatform(haystack);
  return {
    providerId,
    externalServiceId: offer.externalServiceId,
    service: {
      serviceId: `osmm_svc_${providerId}_${offer.externalServiceId}`,
      name: offer.name,
      ...(offer.description ? { description: offer.description } : {}),
      platform,
      objective: inferObjective(haystack, platform),
      ...(offer.category !== undefined ? { category: offer.category } : {}),
      rate: { value: offer.rate, currency: normalizeCurrencyCode(offer.currency) },
      rateBasis: offer.rateBasis,
      minQuantity: offer.minQuantity,
      maxQuantity: offer.maxQuantity,
      parameters: [],
      capabilities: { refill: offer.refill, cancel: offer.cancel, dripfeed: offer.dripfeed },
      status: "ACTIVE",
    },
  };
}
