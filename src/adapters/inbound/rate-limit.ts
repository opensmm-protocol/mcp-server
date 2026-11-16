/**
 * Per-IP request limit for the inbound adapters (REST /v0 and MCP /mcp).
 * One sliding one-minute window per client IP: the N+1-th request inside the
 * window is answered `429` with `Retry-After` before it reaches core state, so
 * an open node stays usable under brute force.
 *
 * Liveness (`GET /health`) and CORS preflights are never counted: a monitoring
 * probe must stay green while an agent is being throttled.
 *
 * Env:
 *   OPENSMM_RATE_LIMIT_PER_MIN — requests per minute per IP (default 120, 0 disables)
 *   OPENSMM_TRUST_PROXY=1      — take the client IP from `x-forwarded-for`
 *                                (only behind your own reverse proxy)
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { OpenSmmError } from "../../core/errors.ts";

export const RATE_LIMIT_ENV = "OPENSMM_RATE_LIMIT_PER_MIN";
export const TRUST_PROXY_ENV = "OPENSMM_TRUST_PROXY";
export const DEFAULT_RATE_LIMIT_PER_MIN = 120;
export const RATE_LIMIT_WINDOW_MS = 60_000;

export type RateLimitDecision =
  | { allowed: true }
  | { allowed: false; retryAfterSeconds: number };

export interface RateLimitOptions {
  /** Requests allowed per window; 0 disables the limit. */
  limitPerMin: number;
  /** Window length, milliseconds (default one minute). */
  windowMs?: number;
  /** Clock override for tests. */
  now?: () => number;
  /** Trust `x-forwarded-for` when the node sits behind its own proxy. */
  trustProxy?: boolean;
}

/**
 * Sliding-window limiter: per key it keeps the arrival times of the current
 * window, so a burst cannot push the window forward the way a fixed counter
 * resetting on the minute would.
 */
export class PerIpRateLimiter {
  private readonly limitPerMin: number;
  private readonly windowMs: number;
  private readonly now: () => number;
  private readonly trustProxy: boolean;
  private readonly hits = new Map<string, number[]>();

  constructor(options: RateLimitOptions) {
    if (!Number.isInteger(options.limitPerMin) || options.limitPerMin < 0) {
      throw new Error(`${RATE_LIMIT_ENV} must be a non-negative integer`);
    }
    this.limitPerMin = options.limitPerMin;
    this.windowMs = options.windowMs ?? RATE_LIMIT_WINDOW_MS;
    this.now = options.now ?? Date.now;
    this.trustProxy = options.trustProxy ?? false;
  }

  get enabled(): boolean {
    return this.limitPerMin > 0;
  }

  /** Decision for one client key (an IP or any other identity). */
  check(key: string): RateLimitDecision {
    if (!this.enabled) return { allowed: true };
    const now = this.now();
    const windowStart = now - this.windowMs;
    const hits = (this.hits.get(key) ?? []).filter((at) => at > windowStart);
    if (hits.length >= this.limitPerMin) {
      this.hits.set(key, hits);
      // The window slides: the next slot opens when the oldest hit expires.
      const retryAfterMs = hits[0] + this.windowMs - now;
      return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)) };
    }
    hits.push(now);
    this.hits.set(key, hits);
    this.prune(windowStart);
    return { allowed: true };
  }

  /**
   * Answer `429` with the canonical error body when the window is exhausted.
   * Returns false when the caller must stop handling the request.
   */
  enforce(req: IncomingMessage, res: ServerResponse): boolean {
    const decision = this.check(this.clientIp(req));
    if (decision.allowed) return true;
    const payload = JSON.stringify(
      new OpenSmmError("RATE_LIMITED", "too many requests from this IP", {
        retryAfterSeconds: decision.retryAfterSeconds,
      }).toBody(),
      null,
      2,
    );
    res.writeHead(429, {
      "content-type": "application/json; charset=utf-8",
      "content-length": Buffer.byteLength(payload),
      "retry-after": String(decision.retryAfterSeconds),
      "access-control-allow-origin": "*",
    });
    res.end(payload);
    return false;
  }

  private clientIp(req: IncomingMessage): string {
    if (this.trustProxy) {
      const forwarded = req.headers["x-forwarded-for"];
      const first = Array.isArray(forwarded) ? forwarded[0] : forwarded;
      const hop = first?.split(",")[0]?.trim();
      if (hop) return hop;
    }
    return req.socket.remoteAddress ?? "unknown";
  }

  /** Drop keys whose window closed: an IP spray must not grow the map forever. */
  private prune(windowStart: number): void {
    if (this.hits.size <= 1024) return;
    for (const [key, hits] of this.hits) {
      if (hits[hits.length - 1] <= windowStart) this.hits.delete(key);
    }
  }
}

/** `OPENSMM_RATE_LIMIT_PER_MIN`: default 120, 0 disables, anything else is a startup error. */
export function rateLimitPerMinFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[RATE_LIMIT_ENV]?.trim();
  if (!raw) return DEFAULT_RATE_LIMIT_PER_MIN;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${RATE_LIMIT_ENV} must be a non-negative integer, got "${raw}"`);
  }
  return value;
}

export function createRateLimiterFromEnv(env: NodeJS.ProcessEnv = process.env): PerIpRateLimiter {
  return new PerIpRateLimiter({
    limitPerMin: rateLimitPerMinFromEnv(env),
    trustProxy: env[TRUST_PROXY_ENV] === "1",
  });
}
