/**
 * Access log shared by both inbound transports (ZHC-767): exactly one JSON
 * line per request on stdout — time, method, path without query, status,
 * duration in ms and x-request-id. Bodies, headers and query strings never
 * reach the line: they carry API keys and wallet addresses.
 *
 * OPENSMM_ACCESS_LOG=0 turns the log off; x-request-id is still returned, so an
 * operator can quote it from a failed response even with logging disabled.
 */

import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

const REQUEST_ID_HEADER = "x-request-id";
/** An echo of a client id is accepted only in this shape (header-safe, bounded). */
const CLIENT_REQUEST_ID = /^[\w.:-]{1,128}$/;

export interface AccessLogEntry {
  requestId: string;
  enabled: boolean;
  startedAt: bigint;
  method: string;
  path: string;
}

/** Path as received, minus the query string; never falls back to the raw URL. */
function requestPath(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? "/", "http://localhost").pathname;
  } catch {
    return (req.url ?? "/").split("?")[0] ?? "/";
  }
}

/**
 * Start the access log for one request: echo the caller's x-request-id or
 * assign one, put it on the response, and arm the single line for `finish`.
 */
export function beginAccessLog(req: IncomingMessage, res: ServerResponse): AccessLogEntry {
  const header = req.headers[REQUEST_ID_HEADER];
  const incoming = Array.isArray(header) ? header[0] : header;
  const requestId = incoming && CLIENT_REQUEST_ID.test(incoming) ? incoming : randomUUID();
  res.setHeader(REQUEST_ID_HEADER, requestId);

  const entry: AccessLogEntry = {
    requestId,
    enabled: process.env.OPENSMM_ACCESS_LOG !== "0",
    startedAt: process.hrtime.bigint(),
    method: req.method ?? "GET",
    path: requestPath(req),
  };
  res.once("finish", () => writeAccessLog(entry, res));
  return entry;
}

function writeAccessLog(entry: AccessLogEntry, res: ServerResponse): void {
  if (!entry.enabled) return;
  const line = JSON.stringify({
    time: new Date().toISOString(),
    method: entry.method,
    path: entry.path,
    status: res.statusCode,
    durationMs: Math.round(Number(process.hrtime.bigint() - entry.startedAt) / 1e6),
    requestId: entry.requestId,
  });
  process.stdout.write(`${line}\n`);
}
