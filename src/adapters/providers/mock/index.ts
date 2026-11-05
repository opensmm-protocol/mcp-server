/**
 * MockProvider: in-memory OpenSmmProvider for the vertical slice.
 * Walks executions through a deterministic lifecycle on each poll and can be
 * scripted into the failure scenarios the gateway must survive:
 * definitive rejection, ambiguous submission (timeout), cancel/refill.
 */

import {
  ProviderRejectedError,
  SubmissionAmbiguousError,
  type CanonicalExecutionInput,
  type CancellationResult,
  type ExecutionReference,
  type ExecutionSnapshot,
  type OpenSmmProvider,
  type ProviderCapabilities,
  type ProviderOffer,
  type RefillReference,
} from "../../../core/provider-spi.ts";
import { mockCatalogEntries } from "./seed.ts";

type MockBehavior =
  | { kind: "ok" }
  | { kind: "reject"; reason?: string }
  | { kind: "ambiguous"; reason?: string }
  | { kind: "stall" }; // never leaves PENDING

interface MockExecution {
  externalExecutionId: string;
  input: CanonicalExecutionInput;
  behavior: MockBehavior;
  canceled: boolean;
  polls: number;
}

export interface MockProviderOptions {
  /** Poll counts at which an ok execution moves on: PENDING→IN_PROGRESS→…→COMPLETED. */
  startAfterPolls?: number;
  completeAfterPolls?: number;
}

export class MockProvider implements OpenSmmProvider {
  readonly providerId = "mock";

  private readonly startAfterPolls: number;
  private readonly completeAfterPolls: number;
  private readonly executions = new Map<string, MockExecution>();
  private readonly refills = new Map<string, string>();
  private nextExecutionSeq = 1;
  private nextRefillSeq = 1;

  /** Script for the next createExecution call; consumed after one use. */
  private nextSubmission: MockBehavior = { kind: "ok" };

  constructor(options: MockProviderOptions = {}) {
    this.startAfterPolls = options.startAfterPolls ?? 1;
    this.completeAfterPolls = options.completeAfterPolls ?? 3;
  }

  /** Test/dev hook: make the next submission reject definitively. */
  failNextSubmission(reason = "mock provider rejected the order"): void {
    this.nextSubmission = { kind: "reject", reason };
  }

  /** Test/dev hook: make the next submission outcome unknowable (timeout). */
  hangNextSubmission(reason = "mock provider timeout"): void {
    this.nextSubmission = { kind: "ambiguous", reason };
  }

  /** Test/dev hook: make an execution never leave PENDING. */
  stallExecution(externalExecutionId: string): void {
    const exec = this.requireExecution(externalExecutionId);
    exec.behavior = { kind: "stall" };
  }

  getExecutionCount(): number {
    return this.executions.size;
  }

  async getCapabilities(): Promise<ProviderCapabilities> {
    return { cancel: true, refill: true, batchStatus: true };
  }

  async listOffers(): Promise<ProviderOffer[]> {
    return mockCatalogEntries.map((entry) => ({
      externalServiceId: entry.externalServiceId,
      name: entry.service.name,
      ...(entry.service.category ? { category: entry.service.category } : {}),
      rate: entry.service.rate.value,
      rateBasis: entry.service.rateBasis,
      currency: entry.service.rate.currency,
      minQuantity: entry.service.minQuantity,
      maxQuantity: entry.service.maxQuantity,
      refill: entry.service.capabilities.refill,
      cancel: entry.service.capabilities.cancel,
      dripfeed: entry.service.capabilities.dripfeed,
    }));
  }

  async createExecution(input: CanonicalExecutionInput): Promise<ExecutionReference> {
    const behavior = this.nextSubmission;
    this.nextSubmission = { kind: "ok" };

    if (behavior.kind === "reject") {
      throw new ProviderRejectedError(behavior.reason ?? "rejected");
    }
    if (behavior.kind === "ambiguous") {
      // Simulate an accepted-then-lost submission: the execution EXISTS
      // provider-side (reconciliation could find it) but the caller timed out.
      const id = this.registerExecution(input, { kind: "ok" });
      void id;
      throw new SubmissionAmbiguousError(behavior.reason ?? "timeout");
    }

    const known = mockCatalogEntries.some((e) => e.externalServiceId === input.externalServiceId);
    if (!known) {
      throw new ProviderRejectedError(`unknown service: ${input.externalServiceId}`);
    }
    const externalExecutionId = this.registerExecution(input, { kind: "ok" });
    return { externalExecutionId };
  }

  async getExecution(externalExecutionId: string): Promise<ExecutionSnapshot> {
    const exec = this.requireExecution(externalExecutionId);
    exec.polls += 1;

    if (exec.canceled) {
      return { status: "CANCELED", rawStatus: "Canceled", remains: exec.input.quantity };
    }
    if (exec.behavior.kind === "stall") {
      return { status: "PENDING", rawStatus: "Pending", remains: exec.input.quantity };
    }
    if (exec.polls < this.startAfterPolls) {
      return { status: "PENDING", rawStatus: "Pending", remains: exec.input.quantity };
    }
    if (exec.polls < this.completeAfterPolls) {
      const delivered = Math.floor(exec.input.quantity / 2);
      return {
        status: "IN_PROGRESS",
        rawStatus: "In progress",
        startCount: 0,
        remains: exec.input.quantity - delivered,
        delivered,
      };
    }
    return {
      status: "COMPLETED",
      rawStatus: "Completed",
      startCount: 0,
      remains: 0,
      delivered: exec.input.quantity,
    };
  }

  async cancelExecution(externalExecutionId: string): Promise<CancellationResult> {
    const exec = this.requireExecution(externalExecutionId);
    if (exec.polls >= this.completeAfterPolls) {
      return { canceled: false, reason: "execution already completed" };
    }
    exec.canceled = true;
    return { canceled: true };
  }

  async requestRefill(externalExecutionId: string): Promise<RefillReference> {
    const exec = this.requireExecution(externalExecutionId);
    const externalRefillId = `mock_refill_${this.nextRefillSeq++}`;
    this.refills.set(externalRefillId, exec.externalExecutionId);
    return { externalRefillId };
  }

  private registerExecution(input: CanonicalExecutionInput, behavior: MockBehavior): string {
    const externalExecutionId = `mock_exec_${this.nextExecutionSeq++}`;
    this.executions.set(externalExecutionId, {
      externalExecutionId,
      input,
      behavior,
      canceled: false,
      polls: 0,
    });
    return externalExecutionId;
  }

  private requireExecution(externalExecutionId: string): MockExecution {
    const exec = this.executions.get(externalExecutionId);
    if (!exec) {
      throw new ProviderRejectedError(`unknown execution: ${externalExecutionId}`);
    }
    return exec;
  }
}
