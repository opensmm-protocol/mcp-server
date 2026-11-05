/**
 * Atomic JSON state store (gateway persistence). Snapshots are small —
 * orders, payments, counters, node registrations — so a single atomically
 * replaced file is enough for the reference gateway.
 *
 * The snapshot contains provider credentials (nodes[].registrationInput):
 * the file is written with mode 0600 and must be treated like a secret
 * (spec/v0 §10.3).
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { CoreSnapshot } from "./core.ts";

export class StateFile {
  readonly path: string;
  private timer?: ReturnType<typeof setInterval>;

  constructor(path: string) {
    this.path = path;
  }

  /** Parsed snapshot, or undefined when the file is missing or unreadable. */
  load(): CoreSnapshot | undefined {
    if (!existsSync(this.path)) return undefined;
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8")) as CoreSnapshot;
      return parsed.format === 1 ? parsed : undefined;
    } catch {
      return undefined; // corrupt state must never block the gateway from booting
    }
  }

  /** Atomic replace: write temp file in the same directory, then rename. */
  save(snapshot: CoreSnapshot): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = join(dirname(this.path), `.${basename(this.path)}.tmp-${process.pid}`);
    writeFileSync(tmp, JSON.stringify(snapshot), { mode: 0o600 });
    renameSync(tmp, this.path);
    chmodSync(this.path, 0o600);
  }

  /**
   * Periodic save plus a final flush on SIGINT/SIGTERM. The autosave timer
   * is unref'd so it never keeps the process alive.
   */
  startAutosave(getSnapshot: () => CoreSnapshot, intervalMs = 30_000): void {
    this.stopAutosave();
    this.timer = setInterval(() => {
      try {
        this.save(getSnapshot());
      } catch {
        // A failed save is retried on the next tick; never crash the gateway.
      }
    }, intervalMs);
    this.timer.unref();
    const flush = () => {
      try {
        this.save(getSnapshot());
      } catch {
        // ignore: the process is exiting anyway
      }
      process.exit(0);
    };
    process.once("SIGINT", flush);
    process.once("SIGTERM", flush);
  }

  stopAutosave(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }
}
