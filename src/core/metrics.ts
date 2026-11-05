/**
 * Gateway-measured provider metrics (spec/v0 §9).
 * Every number here is observed by the gateway from its own orders — never
 * provider self-reports. A metric is omitted from the snapshot until the
 * sample justifies it; sampleSize is always present so agents can judge
 * confidence. Quality tiers are derived by anyone via the open formula in
 * spec/v0 §9.1; the gateway publishes raw measurements only.
 */

import type { ExecutionStatus, ProviderMetrics } from "./types.ts";

type TerminalOutcome = Extract<ExecutionStatus, "COMPLETED" | "PARTIAL" | "CANCELED" | "ERROR">;

interface TerminalInput {
  orderedUnits: number;
  deliveredUnits: number;
  /** Seconds from provider submission to this terminal observation. */
  completionLatencySec?: number;
}

interface ProviderCounters {
  submissions: number;
  rejections: number;
  outcomes: Record<TerminalOutcome, number>;
  orderedUnits: number;
  deliveredUnits: number;
  startLatenciesSec: number[];
  completionLatenciesSec: number[];
}

/** Latency samples are bounded; old samples drop out of the window. */
const LATENCY_WINDOW = 256;

function emptyCounters(): ProviderCounters {
  return {
    submissions: 0,
    rejections: 0,
    outcomes: { COMPLETED: 0, PARTIAL: 0, CANCELED: 0, ERROR: 0 },
    orderedUnits: 0,
    deliveredUnits: 0,
    startLatenciesSec: [],
    completionLatenciesSec: [],
  };
}

function p50(samples: number[]): number | undefined {
  if (samples.length === 0) return undefined;
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)]!;
}

export class MetricsRecorder {
  private readonly counters = new Map<string, ProviderCounters>();

  /** Provider accepted the submission (order went PENDING). */
  recordSubmission(providerId: string): void {
    this.for(providerId).submissions += 1;
  }

  /** Provider definitively refused the submission. Counts as an error outcome. */
  recordRejection(providerId: string, orderedUnits: number): void {
    const c = this.for(providerId);
    c.rejections += 1;
    c.outcomes.ERROR += 1;
    c.orderedUnits += orderedUnits;
  }

  /** First observation of actual delivery (status left PENDING). */
  recordStart(providerId: string, startLatencySec: number): void {
    pushBounded(this.for(providerId).startLatenciesSec, startLatencySec);
  }

  /** Terminal observation of an execution. Recorded exactly once per order. */
  recordTerminal(providerId: string, outcome: TerminalOutcome, input: TerminalInput): void {
    const c = this.for(providerId);
    c.outcomes[outcome] += 1;
    c.orderedUnits += input.orderedUnits;
    c.deliveredUnits += Math.min(input.deliveredUnits, input.orderedUnits);
    if (input.completionLatencySec !== undefined) {
      pushBounded(c.completionLatenciesSec, input.completionLatencySec);
    }
  }

  /**
   * Public snapshot for listProviders (spec/v0 §9). Sparse by design:
   * ratio/latency fields appear only when the sample supports them.
   */
  snapshot(providerId: string): ProviderMetrics {
    const c = this.counters.get(providerId);
    if (!c) return { sampleSize: 0 };
    const sampleSize =
      c.outcomes.COMPLETED + c.outcomes.PARTIAL + c.outcomes.CANCELED + c.outcomes.ERROR;
    const metrics: ProviderMetrics = { sampleSize };
    if (sampleSize > 0) {
      metrics.errorRate = c.outcomes.ERROR / sampleSize;
      if (c.orderedUnits > 0) {
        metrics.deliveredRatio = c.deliveredUnits / c.orderedUnits;
      }
    }
    const startP50 = p50(c.startLatenciesSec);
    if (startP50 !== undefined) metrics.measuredStartP50Sec = startP50;
    const completionP50 = p50(c.completionLatenciesSec);
    if (completionP50 !== undefined) metrics.measuredCompletionP50Sec = completionP50;
    return metrics;
  }

  private for(providerId: string): ProviderCounters {
    let c = this.counters.get(providerId);
    if (!c) {
      c = emptyCounters();
      this.counters.set(providerId, c);
    }
    return c;
  }
}

function pushBounded(samples: number[], value: number): void {
  samples.push(value);
  if (samples.length > LATENCY_WINDOW) {
    samples.splice(0, samples.length - LATENCY_WINDOW);
  }
}
