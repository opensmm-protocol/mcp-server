/**
 * Combined gateway entry: one process, one core, one state file —
 * MCP over Streamable HTTP on /mcp, REST /v0 on everything else.
 * This is the deployment shape for a hosted gateway (docs/DEPLOY.md).
 *
 * Run: `npm run gateway` (PORT env, default 8080) or
 * `node bin/opensmm.mjs gateway --port 8080` from a source checkout
 * (CLI flags, see bin/opensmm.mjs).
 */

import { createServer, type Server } from "node:http";
import path from "node:path";
import { createStackFromEnv, type Stack } from "../../bootstrap.ts";
import { VERSION } from "../../version.ts";
import { createMcpHttpHandler } from "./mcp/http.ts";
import { createRateLimiterFromEnv } from "./rate-limit.ts";
import { createRestHandler } from "./rest/handler.ts";

/** Grace period a stop waits for open connections before forcing them shut. */
const SHUTDOWN_GRACE_MS = 5_000;

export interface GatewayOptions {
  /** Listen port; overrides PORT. 0 picks a free port (tests). */
  port?: number;
  /** State snapshot path; overrides OPENSMM_STATE_FILE. */
  stateFile?: string;
}

export const GATEWAY_HELP = `Usage: opensmm gateway [options]
       npm run gateway -- [options]

One OpenSMM node: REST /v0 and MCP /mcp on one port.

Options:
  --port <number>                 Listen port (overrides PORT; default: 8080; 0 picks a free port)
  --state <path>                  State snapshot path (overrides OPENSMM_STATE_FILE)
  -h, --help                      Show this help

Default state file:
  /data/opensmm-state.json (in Docker; unset = in-memory only)

Environment variables (.env.example):
  PORT                            Listen port for the combined node (REST /v0 and MCP /mcp). Default 8080.
  OPENSMM_ACCESS_LOG              JSON request log on stdout: 0 turns it off (default 1). One line per request, no bodies, headers or query.
  OPENSMM_MAX_BODY_BYTES          Largest accepted request body, bytes, for REST /v0 and MCP /mcp (default: 1048576 = 1 MiB).
                                  A bigger POST is answered 413 and the body read stops; the node keeps serving.
  OPENSMM_STATE_FILE              Path to the JSON state snapshot (default: /data/opensmm-state.json; unset = in-memory only).
  OPENSMM_STATE_SAVE_MS           Autosave cadence of the state snapshot, milliseconds (default: 30000).
  OPENSMM_REST_V1_BASE_URL        Base URL of a live execution provider (reseller-style REST v1 API).
  OPENSMM_REST_V1_API_KEY         API key for the live execution provider.
  OPENSMM_PROVIDER_ID             providerId override for the live provider (default: "rest-v1").
  OPENSMM_PROVIDER_LISTED_NAME    Opt-in public displayName in list_providers (spec/v0 §9; default: hidden).
  OPENSMM_PROVIDER_PAYOUT         Direct-settlement payTo address (USDC on Base) published in payment requirements.
  OPENSMM_CURATED_CATALOG         Path to a curated public catalog JSON (replaces seed/sync; disables background sync).
  OPENSMM_SUPERVISOR              Background supervision: catalog sync and order polling (default: 1 for live provider, 0 disables).
  OPENSMM_SYNC_INTERVAL_MS        Supervision catalog sync cadence, milliseconds (default: 300000).
  OPENSMM_POLL_INTERVAL_MS        Supervision in-flight order polling cadence, milliseconds (default: 30000).
  OPENSMM_RETENTION_CHECK_MS      Supervision retention check cadence, milliseconds (default: 604800000).
  OPENSMM_RATE_LIMIT_PER_MIN      Requests allowed per minute per client IP, sliding window (default: 120; 0 disables the limit).
  OPENSMM_TRUST_PROXY             Set to 1 behind your own reverse proxy: take the client IP from x-forwarded-for (default: 0).
  OPENSMM_ALLOW_PRIVATE_ENDPOINTS Dev-only SSRF escape hatch: allow private/loopback provider endpoints (default: 0).
  X402_FACILITATOR_URL            URL of the x402 facilitator for real payment settlement.
  X402_PAYTO_ADDRESS              Direct-settlement payTo address for x402 payment rail.
  X402_FACILITATOR_API_KEY        Optional API key for authenticating with the x402 facilitator.
  X402_NETWORK                    CAIP-2 network id for x402 payments (default: eip155:84532 — Base Sepolia).
  X402_USDC_ADDRESS               USDC contract override for networks outside the built-in table.
  X402_EIP712_DOMAIN_NAME         EIP-712 domain override, paired with X402_USDC_ADDRESS.
  X402_EIP712_DOMAIN_VERSION      EIP-712 domain version override, paired with X402_USDC_ADDRESS.
`;

export function printGatewayHelp(): void {
  console.log(GATEWAY_HELP);
}

export function parseGatewayCliArgs(
  argv: string[] = process.argv.slice(2),
): GatewayOptions & { help?: boolean } {
  const options: GatewayOptions & { help?: boolean } = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      return options;
    }
    if (arg === "--port") {
      const raw = argv[++i];
      if (raw !== undefined) {
        options.port = Number(raw);
      }
      continue;
    }
    if (arg === "--state") {
      options.stateFile = argv[++i];
      continue;
    }
  }
  return options;
}

export async function serveGateway(options: GatewayOptions = {}): Promise<Server> {
  if (options.stateFile) process.env.OPENSMM_STATE_FILE = options.stateFile;
  // The gateway owns SIGTERM/SIGINT: it drains connections, stops
  // supervision and flushes the snapshot itself (installShutdownHandlers).
  const stack = await createStackFromEnv({}, { stateFileSignalExit: false });
  const { core, provider } = stack;
  const requestedPort = options.port ?? Number(process.env.PORT ?? 8080);
  // One limiter for both bindings: a client cannot double its budget by
  // alternating between REST /v0 and MCP /mcp.
  const rateLimiter = createRateLimiterFromEnv();
  const rest = createRestHandler(core, { rateLimiter });
  const mcp = createMcpHttpHandler(core, { rateLimiter });

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const handler = url.pathname === "/mcp" || url.pathname.startsWith("/mcp/") ? mcp : rest;
    void handler(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });

  await new Promise<void>((resolve) => server.listen(requestedPort, resolve));
  // The stderr line is the contract the CLI smoke tests read the port from:
  // with --port 0 the OS picks the port, so report the bound one, not the ask.
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : requestedPort;
  console.error(
    `OpenSMM ${VERSION} gateway listening on http://localhost:${port} ` +
      `(REST /v0, MCP /mcp; provider: ${provider.providerId}` +
      `${provider.synthetic ? ", mock catalog — not real supply" : ""})`,
  );
  installShutdownHandlers(server, stack);
  return server;
}

/**
 * SIGTERM/SIGINT → one orderly stop: stop accepting connections, stop
 * supervision, flush the state snapshot, exit 0. This is what makes
 * `docker stop` (SIGTERM + 10s grace) safe on the deploy shape: orders and
 * metrics reach the state file instead of dying with the process.
 *
 * Both process entry points (`npm run gateway`, the published CLI) go
 * through `serveGateway`, so the handlers belong here — the entry owns the
 * process, it is not a library for embedding.
 */
function installShutdownHandlers(
  server: Server,
  stack: Pick<Stack, "core" | "supervisor" | "stateFile">,
): void {
  let stopping = false;
  let finished = false;
  const stop = (signal: NodeJS.Signals): void => {
    if (stopping) return;
    stopping = true;
    const finish = (): void => {
      if (finished) return;
      finished = true;
      stack.supervisor.stop();
      try {
        stack.stateFile?.save(stack.core.exportState());
      } catch (err) {
        console.error(`opensmm: state flush on ${signal} failed: ${String(err)}`);
      }
      process.exit(0);
    };
    server.close(() => finish());
    // Drop idle keep-alive sockets so close() can settle; long-lived MCP
    // streams get SHUTDOWN_GRACE_MS and are then cut.
    server.closeIdleConnections();
    const forced = setTimeout(() => {
      server.closeAllConnections();
      finish();
    }, SHUTDOWN_GRACE_MS);
    forced.unref();
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

const isMain =
  process.argv[1] &&
  (import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/")) ||
    (typeof import.meta.filename === "string" && path.resolve(process.argv[1]) === import.meta.filename));

if (isMain) {
  const cliArgs = parseGatewayCliArgs();
  if (cliArgs.help) {
    printGatewayHelp();
    process.exit(0);
  }
  await serveGateway(cliArgs);
}
