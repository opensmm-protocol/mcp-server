/**
 * Request-body reading shared by the two HTTP bindings (REST /v0 and MCP
 * /mcp): every POST is capped at OPENSMM_MAX_BODY_BYTES, so one oversized
 * request cannot exhaust the memory of a public node. Past the cap the read
 * stops and the binding answers 413 PAYLOAD_TOO_LARGE (spec/v0 §5).
 */

import type { IncomingMessage } from "node:http";
import { OpenSmmError } from "../../core/errors.ts";

/** Cap used when OPENSMM_MAX_BODY_BYTES is unset: 1 MiB. */
export const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;

/**
 * The cap in bytes. Read once per binding at boot: a malformed value fails
 * the start instead of silently serving with a different limit.
 */
export function maxBodyBytesFromEnv(): number {
  const raw = process.env.OPENSMM_MAX_BODY_BYTES?.trim();
  if (!raw) return DEFAULT_MAX_BODY_BYTES;
  const bytes = Number(raw);
  if (!Number.isInteger(bytes) || bytes <= 0) {
    throw new Error(`OPENSMM_MAX_BODY_BYTES must be a positive integer, got "${raw}"`);
  }
  return bytes;
}

/**
 * Reads the whole body up to `maxBodyBytes`. The declared Content-Length is
 * checked first, then every chunk as it arrives, so an oversized POST is cut
 * off as soon as it crosses the cap and never buffered past it.
 */
export function readBodyLimited(req: IncomingMessage, maxBodyBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const payloadTooLarge = (): OpenSmmError =>
      new OpenSmmError("PAYLOAD_TOO_LARGE", `request body exceeds ${maxBodyBytes} bytes`, {
        maxBodyBytes,
      });

    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > maxBodyBytes) {
      reject(payloadTooLarge());
      return;
    }

    const chunks: Buffer[] = [];
    let total = 0;

    const cleanup = (): void => {
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onError);
    };
    const onData = (chunk: Buffer): void => {
      total += chunk.length;
      if (total > maxBodyBytes) {
        cleanup();
        // Stop pulling from the socket: the binding replies 413 from here.
        req.pause();
        reject(payloadTooLarge());
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = (): void => {
      cleanup();
      resolve(Buffer.concat(chunks));
    };
    const onError = (err: Error): void => {
      cleanup();
      reject(err);
    };

    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
  });
}
