/**
 * SSRF guard for operator-supplied provider endpoints (spec/v0 §10).
 * A registration endpoint must never let strangers make the gateway call
 * loopback, link-local or private-network addresses.
 *
 * Best-effort: DNS is resolved once at validation time. Implementations
 * facing hostile networks should additionally pin the resolved address for
 * the actual connection (documented in the spec as DNS-rebinding hardening).
 */

import { lookup as dnsLookup } from "node:dns/promises";

export type LookupFn = (hostname: string) => Promise<{ address: string; family: number }[]>;

export interface SsrfGuardOptions {
  /** Test hook / custom resolver. Defaults to system DNS. */
  lookup?: LookupFn;
  /**
   * Explicit local-development escape hatch (e.g. a provider on
   * http://localhost:3000). Never enable for a public gateway.
   */
  allowPrivate?: boolean;
}

const BLOCKED_HOSTNAMES = /^(localhost|.*\.localhost|.*\.local|.*\.internal|.*\.lan|.*\.home|.*\.corp)$/i;

export async function assertPublicProviderUrl(
  rawUrl: string,
  options: SsrfGuardOptions = {},
): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new SsrfBlockedError(`invalid endpoint URL: ${rawUrl}`);
  }

  const isHttps = url.protocol === "https:";
  const isHttp = url.protocol === "http:";
  if (!isHttps && !(isHttp && options.allowPrivate)) {
    throw new SsrfBlockedError(`endpoint must use https:// (got ${url.protocol}//)`);
  }
  if (url.username || url.password) {
    throw new SsrfBlockedError("endpoint URL must not embed credentials");
  }
  const hostname = url.hostname.toLowerCase();
  if (BLOCKED_HOSTNAMES.test(hostname) && !options.allowPrivate) {
    throw new SsrfBlockedError(`endpoint hostname is not public: ${hostname}`);
  }

  if (options.allowPrivate) return url;

  // IP literals are checked directly — no DNS involved.
  if (isIpLiteral(hostname)) {
    const bare = hostname.replace(/^\[|\]$/g, "");
    if (isPrivateAddress(bare)) {
      throw new SsrfBlockedError(`endpoint uses a non-public IP address: ${hostname}`);
    }
    return url;
  }

  const lookup = options.lookup ?? defaultLookup;
  let addresses: { address: string; family: number }[];
  try {
    addresses = await lookup(hostname);
  } catch {
    throw new SsrfBlockedError(`endpoint hostname does not resolve: ${hostname}`);
  }
  if (addresses.length === 0) {
    throw new SsrfBlockedError(`endpoint hostname does not resolve: ${hostname}`);
  }
  for (const { address } of addresses) {
    if (isPrivateAddress(address)) {
      throw new SsrfBlockedError(`endpoint ${hostname} resolves to a non-public address`);
    }
  }
  return url;
}

export class SsrfBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SsrfBlockedError";
  }
}

async function defaultLookup(hostname: string) {
  return dnsLookup(hostname, { all: true, verbatim: true });
}

export function isPrivateAddress(address: string): boolean {
  if (address.includes(":")) return isPrivateIpv6(address);
  return isPrivateIpv4(address);
}

/** URL.hostname keeps IPv6 in brackets; strip them for the family check. */
function isIpLiteral(hostname: string): boolean {
  const bare = hostname.replace(/^\[|\]$/g, "");
  if (bare.includes(":")) return true;
  return /^(\d{1,3}\.){3}\d{1,3}$/.test(bare);
}

function isPrivateIpv4(ip: string): boolean {
  const parts = ip.split(".").map((p) => Number.parseInt(p, 10));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    // Not a valid IPv4 literal — treat as unsafe.
    return true;
  }
  const [a, b] = parts as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127) return true; // 0/8, 10/8, loopback
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
  if (a === 169 && b === 254) return true; // link-local
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
  if (a === 192 && b === 168) return true; // 192.168/16
  if (a === 192 && b === 0 && parts[2] === 0) return true; // 192.0.0/24
  if (a === 192 && b === 0 && parts[2] === 2) return true; // documentation 192.0.2/24
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmark 198.18/15
  if (a === 198 && b === 51 && parts[2] === 100) return true; // documentation
  if (a === 203 && b === 0 && parts[2] === 113) return true; // documentation
  if (a >= 224) return true; // multicast + reserved
  return false;
}

function isPrivateIpv6(ip: string): boolean {
  const normalized = ip.toLowerCase();
  if (normalized === "::1" || normalized === "::") return true;
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true; // ULA fc00::/7
  if (/^fe[89ab]/.test(normalized)) return true; // link-local fe80::/10
  const mapped = normalized.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateIpv4(mapped[1]!);
  return false;
}
