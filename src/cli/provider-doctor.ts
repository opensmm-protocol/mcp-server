/**
 * OpenSMM Provider Doctor (panel pre-onboarding Level-0 check).
 *
 * CLI usage:
 *   node src/cli/provider-doctor.ts --url https://panel.example/api/v2 --key KEY [--profile standard]
 *
 * Performs read-only pre-onboarding diagnostics against an SMM API v2 endpoint:
 *   (1) HTTPS reachability + JSON vs HTML/Cloudflare detection
 *   (2) action=balance works, report balance/currency
 *   (3) action=services returns non-empty array, report catalog size
 *   (4) detect envelope (plain array vs wrapped) and field aliases (service vs services, category vs Category, description vs desc)
 *   (5) print a suggested profile name from src/adapters/providers/smm-v2/profile.ts plus a ready JSON connection snippet
 *
 * Hard rule: NEVER prints or leaks the API key in output, errors, or snippets.
 */

import { realpathSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { PROFILES, type SmmV2Profile } from "../adapters/providers/smm-v2/profile.ts";

export interface DoctorOptions {
  url: string;
  key: string;
  profile?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface DoctorCheckReachability {
  ok: boolean;
  https: boolean;
  isJson: boolean;
  isHtmlOrCloudflare: boolean;
  status?: number;
  details: string;
}

export interface DoctorCheckBalance {
  ok: boolean;
  balance?: string;
  currency?: string;
  error?: string;
}

export interface DoctorCheckServices {
  ok: boolean;
  catalogSize: number;
  error?: string;
}

export interface DoctorCheckEnvelopeAndAliases {
  ok: boolean;
  envelope: "plain" | "wrapped" | "unknown";
  wrapperKey?: string;
  aliases: {
    idField?: "service" | "services" | string;
    categoryField?: "category" | "Category" | string;
    descriptionField?: "description" | "desc" | string;
  };
  extraFields: string[];
}

export interface DoctorConnectionSnippet {
  type: "smm-v2";
  baseUrl: string;
  profile: string;
}

export interface DoctorCheckSuggestion {
  suggestedProfile: string;
  configuredProfile: string;
  snippet: DoctorConnectionSnippet;
}

export interface DoctorResult {
  ok: boolean;
  baseUrl: string;
  checks: {
    reachability: DoctorCheckReachability;
    balance: DoctorCheckBalance;
    services: DoctorCheckServices;
    envelopeAndAliases: DoctorCheckEnvelopeAndAliases;
    suggestion: DoctorCheckSuggestion;
  };
  errors: string[];
}

/** Redact the secret key from any text output or error message. */
export function redactKey(text: string, key?: string): string {
  if (!key || key.length === 0) return text;
  return text.replaceAll(key, "[REDACTED]");
}

/** Check if a response or text indicates an HTML or Cloudflare challenge page. */
function detectHtmlOrCloudflare(
  text: string,
  res?: Response,
): { isHtml: boolean; isCloudflare: boolean } {
  const contentType = (res?.headers?.get?.("content-type") ?? "").toLowerCase();
  const serverHeader = (res?.headers?.get?.("server") ?? "").toLowerCase();
  const hasCfRay = Boolean(res?.headers?.has?.("cf-ray"));

  const isHtml =
    contentType.includes("text/html") ||
    /<html/i.test(text) ||
    /<!DOCTYPE html/i.test(text) ||
    /<body/i.test(text) ||
    /<head>/i.test(text);

  const isCloudflare =
    hasCfRay ||
    serverHeader.includes("cloudflare") ||
    /cloudflare/i.test(text) ||
    /cf-chl/i.test(text) ||
    /cf-browser-verification/i.test(text) ||
    /Just a moment\.\.\./i.test(text) ||
    /Attention Required! \| Cloudflare/i.test(text);

  return { isHtml, isCloudflare };
}

/**
 * Execute Level-0 read-only diagnostics against the provider endpoint.
 */
export async function diagnoseProvider(options: DoctorOptions): Promise<DoctorResult> {
  const rawUrl = (options.url ?? "").trim();
  const baseUrl = rawUrl.replace(/\/+$/, "");
  const key = (options.key ?? "").trim();
  const configuredProfile = options.profile?.trim() || "standard";
  const profileDef: SmmV2Profile | undefined = PROFILES[configuredProfile];
  const authField = profileDef?.authField ?? "key";
  const fetchFn = options.fetchImpl ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 15_000;

  const isHttps = baseUrl.startsWith("https://");

  const reachability: DoctorCheckReachability = {
    ok: false,
    https: isHttps,
    isJson: false,
    isHtmlOrCloudflare: false,
    details: "",
  };

  const balanceCheck: DoctorCheckBalance = {
    ok: false,
  };

  const servicesCheck: DoctorCheckServices = {
    ok: false,
    catalogSize: 0,
  };

  const envelopeAndAliases: DoctorCheckEnvelopeAndAliases = {
    ok: false,
    envelope: "unknown",
    aliases: {},
    extraFields: [],
  };

  const errors: string[] = [];

  if (!isHttps) {
    errors.push(`Target URL does not use HTTPS: ${baseUrl}`);
  }

  // --- Step 1: Reachability + balance check -----------------------------------
  let balanceRes: Response | undefined;
  let balanceText = "";

  try {
    const balanceBody = new URLSearchParams({
      [authField]: key,
      action: "balance",
    });

    balanceRes = await fetchFn(baseUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: balanceBody.toString(),
      signal: AbortSignal.timeout(timeoutMs),
    });

    balanceText = await balanceRes.text();
    reachability.status = balanceRes.status;
  } catch (err: unknown) {
    const errMsg = redactKey(err instanceof Error ? err.message : String(err), key);
    reachability.ok = false;
    reachability.details = `Connection failed: ${errMsg}`;
    errors.push(reachability.details);

    return {
      ok: false,
      baseUrl,
      checks: {
        reachability,
        balance: balanceCheck,
        services: servicesCheck,
        envelopeAndAliases,
        suggestion: {
          suggestedProfile: configuredProfile,
          configuredProfile,
          snippet: { type: "smm-v2", baseUrl, profile: configuredProfile },
        },
      },
      errors,
    };
  }

  // Check for HTML / Cloudflare on balance response
  const cfDetection = detectHtmlOrCloudflare(balanceText, balanceRes);
  if (cfDetection.isHtml || cfDetection.isCloudflare) {
    reachability.isHtmlOrCloudflare = true;
    reachability.isJson = false;
    reachability.ok = false;
    reachability.details = cfDetection.isCloudflare
      ? `Cloudflare challenge or protection detected (HTTP ${balanceRes.status})`
      : `HTML response returned instead of JSON (HTTP ${balanceRes.status})`;
    errors.push(reachability.details);

    return {
      ok: false,
      baseUrl,
      checks: {
        reachability,
        balance: balanceCheck,
        services: servicesCheck,
        envelopeAndAliases,
        suggestion: {
          suggestedProfile: configuredProfile,
          configuredProfile,
          snippet: { type: "smm-v2", baseUrl, profile: configuredProfile },
        },
      },
      errors,
    };
  }

  // Parse JSON
  let balanceData: unknown;
  try {
    balanceData = JSON.parse(balanceText);
    reachability.isJson = true;
    reachability.ok = isHttps;
    reachability.details = `Reachable, returned valid JSON (HTTP ${balanceRes.status})`;
  } catch {
    reachability.ok = false;
    reachability.isJson = false;
    const preview = redactKey(balanceText.slice(0, 120).trim(), key);
    reachability.details = `Non-JSON response (HTTP ${balanceRes.status}): ${preview}`;
    errors.push(reachability.details);

    return {
      ok: false,
      baseUrl,
      checks: {
        reachability,
        balance: balanceCheck,
        services: servicesCheck,
        envelopeAndAliases,
        suggestion: {
          suggestedProfile: configuredProfile,
          configuredProfile,
          snippet: { type: "smm-v2", baseUrl, profile: configuredProfile },
        },
      },
      errors,
    };
  }

  // Inspect balance data
  if (balanceData && typeof balanceData === "object" && !Array.isArray(balanceData)) {
    const obj = balanceData as Record<string, unknown>;
    if ("error" in obj && obj.error) {
      balanceCheck.ok = false;
      balanceCheck.error = redactKey(String(obj.error), key);
      errors.push(`action=balance returned error: ${balanceCheck.error}`);
    } else if ("balance" in obj && obj.balance !== undefined && obj.balance !== null) {
      balanceCheck.ok = true;
      balanceCheck.balance = String(obj.balance);
      balanceCheck.currency = obj.currency !== undefined ? String(obj.currency) : "USD";
    } else {
      balanceCheck.ok = false;
      balanceCheck.error = "Missing 'balance' field in response";
      errors.push(balanceCheck.error);
    }
  } else {
    balanceCheck.ok = false;
    balanceCheck.error = "Balance response is not an object";
    errors.push(balanceCheck.error);
  }

  // --- Step 2: Services catalog check (action=services) -----------------------
  let servicesRes: Response | undefined;
  let servicesText = "";

  try {
    const servicesBody = new URLSearchParams({
      [authField]: key,
      action: "services",
    });

    servicesRes = await fetchFn(baseUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: servicesBody.toString(),
      signal: AbortSignal.timeout(timeoutMs),
    });

    servicesText = await servicesRes.text();
  } catch (err: unknown) {
    const errMsg = redactKey(err instanceof Error ? err.message : String(err), key);
    servicesCheck.ok = false;
    servicesCheck.error = `Services request failed: ${errMsg}`;
    errors.push(servicesCheck.error);
  }

  if (servicesRes) {
    const sCf = detectHtmlOrCloudflare(servicesText, servicesRes);
    if (sCf.isHtml || sCf.isCloudflare) {
      servicesCheck.ok = false;
      servicesCheck.error = sCf.isCloudflare
        ? `Cloudflare challenge detected on action=services (HTTP ${servicesRes.status})`
        : `HTML response returned on action=services (HTTP ${servicesRes.status})`;
      errors.push(servicesCheck.error);
    } else {
      let servicesData: unknown;
      try {
        servicesData = JSON.parse(servicesText);
      } catch {
        servicesCheck.ok = false;
        servicesCheck.error = `Non-JSON response on action=services (HTTP ${servicesRes.status})`;
        errors.push(servicesCheck.error);
      }

      if (servicesData !== undefined) {
        let items: unknown[] = [];
        let wrapperKey: string | undefined;

        if (Array.isArray(servicesData)) {
          envelopeAndAliases.envelope = "plain";
          items = servicesData;
        } else if (servicesData && typeof servicesData === "object") {
          const obj = servicesData as Record<string, unknown>;
          if ("error" in obj && obj.error) {
            servicesCheck.ok = false;
            servicesCheck.error = redactKey(String(obj.error), key);
            errors.push(`action=services returned error: ${servicesCheck.error}`);
          } else {
            const candidateKeys = ["services", "data", "result", "items", "response", "offers"];
            for (const ck of candidateKeys) {
              if (Array.isArray(obj[ck])) {
                wrapperKey = ck;
                envelopeAndAliases.envelope = "wrapped";
                envelopeAndAliases.wrapperKey = ck;
                items = obj[ck] as unknown[];
                break;
              }
            }
            if (!wrapperKey) {
              for (const [k, v] of Object.entries(obj)) {
                if (Array.isArray(v)) {
                  wrapperKey = k;
                  envelopeAndAliases.envelope = "wrapped";
                  envelopeAndAliases.wrapperKey = k;
                  items = v;
                  break;
                }
              }
            }
          }
        }

        servicesCheck.catalogSize = items.length;
        if (!servicesCheck.error) {
          if (items.length > 0) {
            servicesCheck.ok = true;
            envelopeAndAliases.ok = true;
          } else {
            servicesCheck.ok = false;
            servicesCheck.error = "Services catalog is empty (0 services)";
            errors.push(servicesCheck.error);
          }
        }

        // --- Step 3: Field aliases detection ---------------------------------
        let detectedId: string | undefined;
        let detectedCat: string | undefined;
        let detectedDesc: string | undefined;
        const extraFieldsSet = new Set<string>();

        const sampleCount = Math.min(items.length, 100);
        for (let i = 0; i < sampleCount; i++) {
          const raw = items[i];
          if (!raw || typeof raw !== "object") continue;
          const rec = raw as Record<string, unknown>;

          if (!detectedId) {
            if ("services" in rec && !("service" in rec)) {
              detectedId = "services";
            } else if ("service" in rec) {
              detectedId = "service";
            }
          }

          if (!detectedCat) {
            if ("Category" in rec && !("category" in rec)) {
              detectedCat = "Category";
            } else if ("category" in rec) {
              detectedCat = "category";
            }
          }

          if (!detectedDesc) {
            if ("desc" in rec && !("description" in rec)) {
              detectedDesc = "desc";
            } else if ("description" in rec) {
              detectedDesc = "description";
            }
          }

          for (const field of ["icon", "speed", "timelastorders"]) {
            if (field in rec) {
              extraFieldsSet.add(field);
            }
          }
        }

        envelopeAndAliases.aliases = {
          idField: detectedId,
          categoryField: detectedCat,
          descriptionField: detectedDesc,
        };
        envelopeAndAliases.extraFields = Array.from(extraFieldsSet);
      }
    }
  }

  // --- Step 4: Suggest profile name & build connection snippet --------------
  let suggestedProfile = "standard";

  if (envelopeAndAliases.aliases.idField === "services") {
    suggestedProfile = "success-message";
  } else if (envelopeAndAliases.extraFields.length > 0) {
    suggestedProfile = "extended";
  } else if (
    balanceCheck.currency &&
    (balanceCheck.currency === "PROVIDER_CREDITS" ||
      balanceCheck.currency.toLowerCase().includes("credit") ||
      balanceCheck.currency.toLowerCase().includes("token"))
  ) {
    suggestedProfile = "provider-credits";
  } else {
    suggestedProfile = "standard";
  }

  const snippet: DoctorConnectionSnippet = {
    type: "smm-v2",
    baseUrl,
    profile: suggestedProfile,
  };

  const overallOk =
    reachability.ok &&
    balanceCheck.ok &&
    servicesCheck.ok &&
    (envelopeAndAliases.envelope === "plain" || envelopeAndAliases.envelope === "wrapped");

  return {
    ok: overallOk,
    baseUrl,
    checks: {
      reachability,
      balance: balanceCheck,
      services: servicesCheck,
      envelopeAndAliases,
      suggestion: {
        suggestedProfile,
        configuredProfile,
        snippet,
      },
    },
    errors,
  };
}

/** Format the doctor results into a structured human-readable report. */
export function formatDoctorReport(result: DoctorResult): string {
  const lines: string[] = [];
  lines.push("============================================================");
  lines.push(" OpenSMM Provider Doctor (Level-0 Pre-Onboarding Check)");
  lines.push(` Target: ${result.baseUrl}`);
  lines.push("============================================================");
  lines.push("");

  // Check 1: HTTPS reachability + JSON vs HTML/Cloudflare
  lines.push("[1/5] HTTPS Reachability & JSON vs HTML/Cloudflare Detection");
  if (result.checks.reachability.https) {
    lines.push("  ✓ HTTPS protocol confirmed");
  } else {
    lines.push(`  ✗ Target URL does not use HTTPS (${result.baseUrl})`);
  }
  if (result.checks.reachability.isHtmlOrCloudflare) {
    lines.push(`  ✗ Cloudflare challenge or HTML response detected`);
    lines.push(`    ${result.checks.reachability.details}`);
  } else if (result.checks.reachability.isJson) {
    lines.push("  ✓ Response format: valid JSON received");
    lines.push("  ✓ Cloudflare/HTML challenge: none detected");
  } else {
    lines.push(`  ✗ Reachability failed: ${result.checks.reachability.details}`);
  }
  lines.push("");

  // Check 2: action=balance
  lines.push("[2/5] Balance Check (action=balance)");
  if (result.checks.balance.ok) {
    lines.push("  ✓ action=balance succeeded");
    lines.push(`  • Balance: ${result.checks.balance.balance ?? "unknown"}`);
    lines.push(`  • Currency: ${result.checks.balance.currency ?? "unknown"}`);
  } else {
    lines.push(`  ✗ action=balance failed: ${result.checks.balance.error ?? "unknown error"}`);
  }
  lines.push("");

  // Check 3: action=services
  lines.push("[3/5] Services Catalog (action=services)");
  if (result.checks.services.ok) {
    lines.push("  ✓ action=services returned non-empty catalog");
    lines.push(`  • Catalog size: ${result.checks.services.catalogSize} services`);
  } else {
    lines.push(
      `  ✗ action=services failed: ${result.checks.services.error ?? "Failed to load services"}`,
    );
  }
  lines.push("");

  // Check 4: Envelope and aliases
  lines.push("[4/5] Envelope & Field Aliases Detection");
  if (result.checks.envelopeAndAliases.envelope === "plain") {
    lines.push("  • Envelope: plain array (direct list)");
  } else if (result.checks.envelopeAndAliases.envelope === "wrapped") {
    lines.push(
      `  • Envelope: wrapped (wrapper key: '${result.checks.envelopeAndAliases.wrapperKey ?? "unknown"}')`,
    );
  } else {
    lines.push("  • Envelope: unknown / unexpected");
  }
  const aliases = result.checks.envelopeAndAliases.aliases;
  lines.push("  • Field aliases:");
  lines.push(`    - ID field: ${aliases.idField ? `'${aliases.idField}'` : "not detected"}`);
  lines.push(
    `    - Category field: ${aliases.categoryField ? `'${aliases.categoryField}'` : "not detected"}`,
  );
  lines.push(
    `    - Description field: ${aliases.descriptionField ? `'${aliases.descriptionField}'` : "not detected"}`,
  );
  if (result.checks.envelopeAndAliases.extraFields.length > 0) {
    lines.push(
      `  • Extra fields detected: ${result.checks.envelopeAndAliases.extraFields.join(", ")}`,
    );
  }
  lines.push("");

  // Check 5: Profile suggestion & snippet
  lines.push("[5/5] Profile Suggestion & Ready JSON Connection Snippet");
  lines.push(`  • Suggested profile: ${result.checks.suggestion.suggestedProfile}`);
  if (
    result.checks.suggestion.configuredProfile &&
    result.checks.suggestion.configuredProfile !== result.checks.suggestion.suggestedProfile
  ) {
    lines.push(`  • Configured profile: ${result.checks.suggestion.configuredProfile}`);
  }
  lines.push("  • Connection snippet:");
  lines.push(JSON.stringify(result.checks.suggestion.snippet, null, 2));
  lines.push("");

  lines.push("============================================================");
  lines.push(` Status: ${result.ok ? "ALL CHECKS PASSED" : "PRE-ONBOARDING CHECK FAILED"}`);
  lines.push("============================================================");

  return lines.join("\n");
}

/**
 * CLI execution handler.
 */
export async function runDoctorCli(
  args: string[],
  fetchImpl?: typeof fetch,
  logFn: (msg: string) => void = console.log,
  errFn: (msg: string) => void = console.error,
): Promise<number> {
  let parsed: {
    values: {
      url?: string;
      key?: string;
      profile?: string;
      help?: boolean;
    };
    positionals: string[];
  };

  try {
    const rawParsed = parseArgs({
      args,
      options: {
        url: { type: "string" },
        key: { type: "string" },
        profile: { type: "string", default: "standard" },
        help: { type: "boolean", short: "h" },
      },
      allowPositionals: false,
    });
    parsed = {
      values: {
        url: typeof rawParsed.values.url === "string" ? rawParsed.values.url : undefined,
        key: typeof rawParsed.values.key === "string" ? rawParsed.values.key : undefined,
        profile:
          typeof rawParsed.values.profile === "string"
            ? rawParsed.values.profile
            : "standard",
        help: Boolean(rawParsed.values.help),
      },
      positionals: rawParsed.positionals,
    };
  } catch (err: unknown) {
    errFn(`Error: ${err instanceof Error ? err.message : String(err)}`);
    errFn("Usage: node src/cli/provider-doctor.ts --url <url> --key <key> [--profile standard]");
    return 1;
  }

  const { values } = parsed;

  if (values.help) {
    logFn("Usage: node src/cli/provider-doctor.ts --url <url> --key <key> [--profile standard]");
    logFn("");
    logFn("Options:");
    logFn("  --url      Target provider API v2 endpoint (e.g. https://panel.example/api/v2) [required]");
    logFn("  --key      Provider API key [required]");
    logFn("  --profile  Expected profile name (default: standard)");
    logFn("  -h, --help Show this help message");
    return 0;
  }

  if (!values.url || !values.key) {
    errFn("Error: Missing required argument. Both --url and --key are required.");
    errFn("Usage: node src/cli/provider-doctor.ts --url <url> --key <key> [--profile standard]");
    return 1;
  }

  const safeKey = values.key;
  const safeLog = (msg: string) => logFn(redactKey(msg, safeKey));
  const safeErr = (msg: string) => errFn(redactKey(msg, safeKey));

  try {
    const result = await diagnoseProvider({
      url: values.url,
      key: values.key,
      profile: values.profile,
      fetchImpl,
    });

    const report = formatDoctorReport(result);
    safeLog(report);
    return result.ok ? 0 : 1;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    safeErr(`Doctor failed with unexpected error: ${msg}`);
    return 1;
  }
}

function isDirectExecution(): boolean {
  if (!process.argv[1]) return false;
  try {
    const scriptPath = fileURLToPath(import.meta.url);
    const invokedPath = path.resolve(process.argv[1]);
    if (scriptPath === invokedPath) return true;
    return realpathSync(scriptPath) === realpathSync(invokedPath);
  } catch {
    return false;
  }
}

if (isDirectExecution()) {
  const exitCode = await runDoctorCli(process.argv.slice(2));
  process.exit(exitCode);
}
