/**
 * Combined gateway entry: one process, one core, one state file —
 * MCP over Streamable HTTP on /mcp, REST /v0 on everything else.
 * This is the deployment shape for a hosted gateway (docs/DEPLOY.md).
 *
 * Run: `npm run gateway` (PORT env, default 8080) or
 * `npx -y @opensmm/mcp-server gateway --port 8080`
 * (CLI flags, see bin/opensmm.mjs).
 */

import { createServer, type Server } from "node:http";
import path from "node:path";
import { createStackFromEnv } from "../../bootstrap.ts";
import { createMcpHttpHandler } from "./mcp/http.ts";
import { createRestHandler } from "./rest/handler.ts";

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
  const { core, provider } = await createStackFromEnv();
  const requestedPort = options.port ?? Number(process.env.PORT ?? 8080);
  const rest = createRestHandler(core);
  const mcp = createMcpHttpHandler(core);

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
    `OpenSMM 0.1.0 gateway listening on http://localhost:${port} ` +
      `(REST /v0, MCP /mcp; provider: ${provider.providerId}` +
      `${provider.synthetic ? ", mock catalog — not real supply" : ""})`,
  );
  return server;
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
