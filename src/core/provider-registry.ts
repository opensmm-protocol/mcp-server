/**
 * Provider node registry (spec/v0 §9–§10).
 * Nodes are pseudonymous in the public API: providerKey is assigned at
 * registration (provider-alpha, provider-beta, ...) and never reveals the
 * operator. Credentials handed over at registration live only in the adapter
 * instance and are never exposed through the registry or the protocol.
 */

import type { OpenSmmProvider } from "./provider-spi.ts";
import type { NodeLifecycle } from "./types.ts";

export type { NodeLifecycle } from "./types.ts";

export interface ProviderNode {
  providerId: string;
  /** Pseudonymous public key, stable for the life of the process. */
  providerKey: string;
  provider: OpenSmmProvider;
  lifecycle: NodeLifecycle;
  displayName?: string;
  publiclyListed: boolean;
  /** Direct-settlement address of the provider (spec/v0 §8). */
  payoutAddress?: string;
  /** Registration endpoint; used for idempotent re-registration, never published. */
  endpoint?: string;
  registeredAt: string;
  lastHealthcheckAt?: string;
}

const KEY_WORDS = [
  "alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta",
  "iota", "kappa", "lambda", "mu", "nu", "xi", "omicron", "pi",
  "rho", "sigma", "tau", "upsilon", "phi", "chi", "psi", "omega",
];

export class ProviderRegistry {
  private readonly nodes = new Map<string, ProviderNode>();

  register(node: Omit<ProviderNode, "providerKey">): ProviderNode {
    if (this.nodes.has(node.providerId)) {
      throw new Error(`provider already registered: ${node.providerId}`);
    }
    const full: ProviderNode = { ...node, providerKey: this.nextKey() };
    this.nodes.set(full.providerId, full);
    return full;
  }

  get(providerId: string): ProviderNode | undefined {
    return this.nodes.get(providerId);
  }

  list(): ProviderNode[] {
    return [...this.nodes.values()];
  }

  setLifecycle(providerId: string, lifecycle: NodeLifecycle): void {
    const node = this.nodes.get(providerId);
    if (node) node.lifecycle = lifecycle;
  }

  private nextKey(): string {
    const n = this.nodes.size;
    const word = KEY_WORDS[n % KEY_WORDS.length]!;
    const cycle = Math.floor(n / KEY_WORDS.length);
    return cycle === 0 ? `provider-${word}` : `provider-${word}-${cycle + 1}`;
  }
}
