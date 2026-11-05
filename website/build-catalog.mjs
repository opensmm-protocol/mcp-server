#!/usr/bin/env node
/**
 * Static SEO catalog generator for opensmm.dev.
 *
 * Pulls the live service catalog from a running OpenSMM gateway
 * (GET /v0/services) or from a local JSON dump, and emits static
 * HTML pages under website/catalog/:
 *
 *   catalog/index.html                    — hub, platforms with counts
 *   catalog/<platform>/index.html         — all services, grouped by category
 *   catalog/<platform>/<objective>/index.html — per-intent landing pages
 *
 * Usage:
 *   node website/build-catalog.mjs                 # fetch from gateway
 *   GATEWAY_URL=http://host:port node website/build-catalog.mjs
 *   CATALOG_FILE=/tmp/catalog.json node website/build-catalog.mjs
 */

import { mkdir, writeFile, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, "catalog");
const SITE = "https://opensmm.dev";
const GATEWAY_URL = process.env.GATEWAY_URL ?? "http://127.0.0.1:8080";
const CATALOG_FILE = process.env.CATALOG_FILE;

const PLATFORM_LABELS = {
  telegram: "Telegram",
  instagram: "Instagram",
  youtube: "YouTube",
  tiktok: "TikTok",
  x: "X (Twitter)",
  vk: "VK",
  other: "Other networks",
};

const OBJECTIVE_LABELS = {
  members: "members",
  followers: "followers",
  likes: "likes",
  views: "views",
  reactions: "reactions",
  comments: "comments",
};

const OBJECTIVE_COPY = {
  members: "channel and group members",
  followers: "account followers",
  likes: "post and video likes",
  views: "post, story and video views",
  reactions: "message reactions",
  comments: "post comments",
};

/* ---------- helpers ---------- */

function esc(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function fmtRate(service) {
  const { value, currency } = service.rate;
  const num = Number(value);
  const pretty = Number.isFinite(num) ? num.toFixed(Math.abs(num) < 1 ? 4 : 2) : value;
  const basis =
    service.rateBasis === "PER_1000" ? " / 1k" :
    service.rateBasis === "PER_PACKAGE" ? " / pkg" : "";
  return `${pretty} ${esc(currency)}${basis}`;
}

function fmtQty(n) {
  return Number(n).toLocaleString("en-US");
}

function badge(ok, label) {
  return ok ? `<span class="badge badge-ok">${label}</span>` : "";
}

function crumbs(items) {
  const parts = items.map((it, i) =>
    i === items.length - 1
      ? `<span>${esc(it.label)}</span>`
      : `<a href="${it.href}">${esc(it.label)}</a>`);
  return `<nav class="crumbs" aria-label="Breadcrumb">${parts.join('<span class="crumb-sep">/</span>')}</nav>`;
}

function jsonLd(obj) {
  return `<script type="application/ld+json">\n${JSON.stringify(obj, null, 1)}\n</script>`;
}

function page({ title, description, canonical, body, ld }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:type" content="website">
<meta property="og:url" content="${canonical}">
<link rel="canonical" href="${canonical}">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='7' fill='%230052FF'/%3E%3Crect x='7' y='17' width='4' height='8' rx='1' fill='%23fff'/%3E%3Crect x='14' y='12' width='4' height='13' rx='1' fill='%23fff'/%3E%3Crect x='21' y='7' width='4' height='18' rx='1' fill='%23fff'/%3E%3C/svg%3E">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;700&family=IBM+Plex+Mono:wght@400;500&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/styles.css">
${ld ? jsonLd(ld) : ""}
</head>
<body>

<header class="nav">
  <div class="wrap nav-row">
    <a class="brand" href="/">OpenSMM <span class="version">v0.1</span></a>
    <nav class="nav-links">
      <a href="/catalog/">Catalog</a>
      <a href="/#how">How it works</a>
      <a href="/#tools">Tools</a>
      <a href="/#supply">Run a node</a>
      <a href="https://github.com/opensmm-protocol/mcp-server">GitHub</a>
    </nav>
  </div>
</header>

<main>
${body}
</main>

<footer class="footer">
  <div class="wrap footer-row">
    <span>OpenSMM Protocol — MIT licensed open software</span>
    <nav class="footer-links">
      <a href="https://github.com/opensmm-protocol/mcp-server">GitHub</a>
      <a href="https://github.com/opensmm-protocol/mcp-server/tree/main/spec/v0">Spec v0</a>
      <a href="/llms.txt">llms.txt</a>
      <a href="/mcp.json">mcp.json</a>
    </nav>
  </div>
</footer>

</body>
</html>
`;
}

function serviceRows(services) {
  return services
    .map(
      (s) => `<tr>
  <td class="svc-name">${esc(s.name)}</td>
  <td class="num">${fmtRate(s)}</td>
  <td class="num">${fmtQty(s.minQuantity)}</td>
  <td class="num">${fmtQty(s.maxQuantity)}</td>
  <td>${badge(s.capabilities.refill, "refill")} ${badge(s.capabilities.cancel, "cancel")} ${badge(s.capabilities.dripfeed, "drip")}</td>
</tr>`,
    )
    .join("\n");
}

function serviceTable(services) {
  return `<div class="table-scroll"><table class="cat-table">
<thead><tr><th>Service</th><th class="num">Rate</th><th class="num">Min</th><th class="num">Max</th><th>Flags</th></tr></thead>
<tbody>
${serviceRows(services)}
</tbody>
</table></div>`;
}

function groupByCategory(services) {
  const groups = new Map();
  for (const s of services) {
    const key = s.category ?? "Uncategorized";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s);
  }
  return [...groups.entries()].sort((a, b) => b[1].length - a[1].length);
}

function itemListLd(services, url, name) {
  return {
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    name,
    url,
    mainEntity: {
      "@type": "ItemList",
      numberOfItems: services.length,
      itemListElement: services.slice(0, 100).map((s, i) => ({
        "@type": "ListItem",
        position: i + 1,
        item: {
          "@type": "Offer",
          name: s.name,
          price: Number(s.rate.value),
          priceCurrency: s.rate.currency,
          url,
        },
      })),
    },
  };
}

/* ---------- data ---------- */

function cleanName(name) {
  // Legacy offers glue the long-form description onto the name; the first
  // line is the human-readable service title.
  return String(name).split(/\r?\n/)[0].replace(/\s+/g, " ").trim();
}

async function loadServices() {
  let services;
  if (CATALOG_FILE) {
    const raw = JSON.parse(await readFile(CATALOG_FILE, "utf8"));
    services = raw.services ?? raw;
  } else {
    const res = await fetch(`${GATEWAY_URL}/v0/services`);
    if (!res.ok) throw new Error(`gateway ${GATEWAY_URL} responded ${res.status}`);
    const body = await res.json();
    services = body.services;
  }
  return services.map((s) => ({ ...s, name: cleanName(s.name) }));
}

/* ---------- pages ---------- */

async function emitHub(byPlatform, total) {
  const cards = [...byPlatform.entries()]
    .sort((a, b) => (a[0] === "other" ? 1 : b[0] === "other" ? -1 : b[1].length - a[1].length))
    .map(([platform, services]) => {
      const objectives = [...new Set(services.map((s) => s.objective))]
        .filter((o) => o !== "other")
        .sort();
      const links = objectives
        .map((o) => `<a href="/catalog/${platform}/${o}/">${OBJECTIVE_LABELS[o]}</a>`)
        .join(" · ");
      return `<li class="hub-item">
  <a class="hub-name" href="/catalog/${platform}/">${PLATFORM_LABELS[platform] ?? platform}</a>
  <span class="hub-count">${fmtQty(services.length)} services</span>
  ${links ? `<span class="hub-links">${links}</span>` : ""}
</li>`;
    })
    .join("\n");

  const body = `<section class="section catalog-hero">
  <div class="wrap">
    ${crumbs([{ label: "Catalog" }])}
    <h1>Service catalog</h1>
    <p class="section-lede">
      Live catalog of <strong>${fmtQty(total)} growth services</strong> exposed through the
      OpenSMM protocol. Every entry is orderable by an AI agent via MCP tools or plain
      HTTP <code>/v0</code>, quoted instantly and settled in USDC on Base.
      Rates, limits and quality flags refresh from the network of supply nodes.
    </p>
    <ul class="hub-list">
${cards}
    </ul>
  </div>
</section>`;

  const html = page({
    title: "Service catalog — 4,000+ growth services for AI agents | OpenSMM",
    description: `Live OpenSMM catalog: ${fmtQty(total)} social media growth services across Telegram, Instagram, YouTube, TikTok, X and VK. Machine-readable rates, instant quotes, USDC settlement on Base.`,
    canonical: `${SITE}/catalog/`,
    body,
    ld: {
      "@context": "https://schema.org",
      "@type": "CollectionPage",
      name: "OpenSMM service catalog",
      url: `${SITE}/catalog/`,
      numberOfItems: total,
    },
  });
  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(join(OUT_DIR, "index.html"), html);
}

async function emitPlatform(platform, services) {
  const label = PLATFORM_LABELS[platform] ?? platform;
  const groups = groupByCategory(services);
  const objectives = [...new Set(services.map((s) => s.objective))].filter((o) => o !== "other").sort();

  const objectiveNav = objectives.length
    ? `<p class="cat-nav">By intent: ${objectives
        .map((o) => `<a href="/catalog/${platform}/${o}/">${OBJECTIVE_LABELS[o]}</a>`)
        .join(" · ")}</p>`
    : "";

  const sections = groups
    .map(
      ([category, items]) => `<h2 class="cat-heading">${esc(category)} <span class="cat-count">${items.length}</span></h2>
${serviceTable(items)}`,
    )
    .join("\n");

  const body = `<section class="section catalog-hero">
  <div class="wrap">
    ${crumbs([{ label: "Catalog", href: "/catalog/" }, { label }])}
    <h1>${esc(label)} growth services</h1>
    <p class="section-lede">
      ${fmtQty(services.length)} live ${esc(label)} services in the OpenSMM catalog —
      ${OBJECTIVE_COPY[objectives[0]] ?? "growth services"} and more, with machine-readable
      rates, refill flags and instant x402 quotes. Orderable by AI agents over MCP or HTTP.
    </p>
    ${objectiveNav}
  </div>
</section>
<section class="section catalog-body">
  <div class="wrap">
${sections}
  </div>
</section>`;

  const html = page({
    title: `${label} services — live rates & agent API | OpenSMM catalog`,
    description: `${fmtQty(services.length)} ${label} growth services in the open OpenSMM catalog: ${objectives.map((o) => OBJECTIVE_LABELS[o]).join(", ") || "full service range"}. Live rates, instant quotes, USDC settlement on Base, MCP and HTTP API for AI agents.`,
    canonical: `${SITE}/catalog/${platform}/`,
    body,
    ld: itemListLd(services, `${SITE}/catalog/${platform}/`, `${label} growth services`),
  });
  await mkdir(join(OUT_DIR, platform), { recursive: true });
  await writeFile(join(OUT_DIR, platform, "index.html"), html);
}

async function emitObjective(platform, objective, services, platformTotal) {
  const label = PLATFORM_LABELS[platform] ?? platform;
  const objLabel = OBJECTIVE_LABELS[objective];
  const cheapest = services.reduce((a, b) => (Number(a.rate.value) <= Number(b.rate.value) ? a : b));
  const groups = groupByCategory(services);

  const sections = groups
    .map(
      ([category, items]) => `<h2 class="cat-heading">${esc(category)} <span class="cat-count">${items.length}</span></h2>
${serviceTable(items)}`,
    )
    .join("\n");

  const body = `<section class="section catalog-hero">
  <div class="wrap">
    ${crumbs([
      { label: "Catalog", href: "/catalog/" },
      { label, href: `/catalog/${platform}/` },
      { label: objLabel },
    ])}
    <h1>Buy ${esc(label)} ${esc(objLabel)} via API</h1>
    <p class="section-lede">
      ${fmtQty(services.length)} live offers for ${esc(label)} ${esc(OBJECTIVE_COPY[objective] ?? objLabel)},
      from <strong>${fmtRate(cheapest)}</strong>. Machine-readable catalog, instant
      <code>quote_smm_order</code> pricing and direct USDC settlement on Base —
      built for AI agents, usable from any HTTP client.
    </p>
    <p class="cat-nav">All ${esc(label)} services: <a href="/catalog/${platform}/">${fmtQty(platformTotal)} entries</a></p>
  </div>
</section>
<section class="section catalog-body">
  <div class="wrap">
${sections}
  </div>
</section>`;

  const html = page({
    title: `Buy ${label} ${objLabel} — from ${fmtRate(cheapest)} via agent API | OpenSMM`,
    description: `${fmtQty(services.length)} live ${label} ${objLabel} offers in the OpenSMM protocol catalog, rates from ${fmtRate(cheapest)}. Instant x402 quotes, USDC on Base, MCP tools and HTTP /v0 for AI agents.`,
    canonical: `${SITE}/catalog/${platform}/${objective}/`,
    body,
    ld: itemListLd(services, `${SITE}/catalog/${platform}/${objective}/`, `${label} ${objLabel}`),
  });
  const dir = join(OUT_DIR, platform, objective);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "index.html"), html);
}

/* ---------- sitemap ---------- */

async function emitSitemap(urls) {
  const today = new Date().toISOString().slice(0, 10);
  const body = urls
    .map(
      (u) => `  <url>
    <loc>${u.loc}</loc>
    <lastmod>${today}</lastmod>
    <changefreq>${u.freq}</changefreq>
    <priority>${u.priority}</priority>
  </url>`,
    )
    .join("\n");
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${body}
</urlset>
`;
  await writeFile(join(HERE, "sitemap.xml"), xml);
}

/* ---------- main ---------- */

const services = await loadServices();
console.log(`loaded ${services.length} services`);

const byPlatform = new Map();
for (const s of services) {
  if (!byPlatform.has(s.platform)) byPlatform.set(s.platform, []);
  byPlatform.get(s.platform).push(s);
}

await emitHub(byPlatform, services.length);

const urls = [
  { loc: `${SITE}/`, freq: "weekly", priority: "1.0" },
  { loc: `${SITE}/catalog/`, freq: "daily", priority: "0.9" },
  { loc: `${SITE}/llms.txt`, freq: "monthly", priority: "0.4" },
];

for (const [platform, list] of byPlatform) {
  await emitPlatform(platform, list);
  urls.push({ loc: `${SITE}/catalog/${platform}/`, freq: "daily", priority: "0.8" });
  const byObjective = new Map();
  for (const s of list) {
    if (s.objective === "other") continue;
    if (!byObjective.has(s.objective)) byObjective.set(s.objective, []);
    byObjective.get(s.objective).push(s);
  }
  for (const [objective, objList] of byObjective) {
    await emitObjective(platform, objective, objList, list.length);
    urls.push({ loc: `${SITE}/catalog/${platform}/${objective}/`, freq: "daily", priority: "0.8" });
  }
}

await emitSitemap(urls);
console.log(`emitted ${urls.length} urls into sitemap.xml`);
