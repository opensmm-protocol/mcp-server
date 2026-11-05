/**
 * Generic mapping of provider offers to gateway CatalogEntries.
 * Platform/objective are inferred from the offer's category and name —
 * legacy catalogs have no structured fields for them.
 */

import type { CatalogEntry } from "./catalog.ts";
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
  [/like|лайк/i, "likes"],
  [/view|watch|impression|просмотр/i, "views"],
  [/reaction|реакци/i, "reactions"],
  [/comment|комментар/i, "comments"],
];

export function inferPlatform(text: string): Platform {
  for (const [re, platform] of PLATFORM_KEYWORDS) {
    if (re.test(text)) return platform;
  }
  return "other";
}

export function inferObjective(text: string, platform?: Platform): Objective {
  // RU catalogs label both Telegram members and site followers as «подписчики».
  if (/подписчик/i.test(text)) return platform === "telegram" ? "members" : "followers";
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
      rate: { value: offer.rate, currency: offer.currency },
      rateBasis: offer.rateBasis,
      minQuantity: offer.minQuantity,
      maxQuantity: offer.maxQuantity,
      parameters: [],
      capabilities: { refill: offer.refill, cancel: offer.cancel, dripfeed: offer.dripfeed },
      status: "ACTIVE",
    },
  };
}
