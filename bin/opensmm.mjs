#!/usr/bin/env node
/**
 * OpenSMM entry point for the published package. Requires Node.js >= 22.18.
 *
 *   npx -y @opensmm/mcp-server                  MCP server over stdio (default)
 *   npx -y @opensmm/mcp-server gateway ...      one node: REST /v0 + MCP /mcp
 *
 * Modules come from `dist/` (built by `npm run build`, wired into `prepack`):
 * Node refuses native TypeScript type stripping for files under node_modules,
 * so the shipped entry point must be plain JS. A source checkout without a
 * build falls back to `src/`, where Node 22.18+ runs the TypeScript directly.
 */
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const USAGE = `Usage: opensmm [command]

Commands:
  (none)                 MCP server over stdio (default; keep the old behaviour)
  gateway [options]      One OpenSMM node: REST /v0 and MCP /mcp on one port

Gateway options:
  --port <number>        Listen port (default: PORT, else 8080; 0 picks a free port)
  --state <path>         State snapshot file (default: OPENSMM_STATE_FILE)
  -h, --help             Show this help

Examples:
  npx -y @opensmm/mcp-server gateway --port 8080
  npx -y @opensmm/mcp-server gateway --port 8080 --state ./opensmm-state.json

No keys and no external services are required: the node boots on the built-in
mock catalog. Docs: docs/DEPLOY.md («Run a node in 5 minutes»).
`;

class UsageError extends Error {}

async function loadModule(relative) {
  const dist = fileURLToPath(new URL(`../dist/${relative}.js`, import.meta.url));
  if (existsSync(dist)) return import(pathToFileURL(dist).href);
  return import(new URL(`../src/${relative}.ts`, import.meta.url).href);
}

function parseGatewayArgs(args) {
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") return { help: true };
    if (arg === "--port") {
      const raw = args[++i];
      if (raw === undefined) throw new UsageError("--port requires a value");
      const port = Number(raw);
      if (!Number.isInteger(port) || port < 0 || port > 65535) {
        throw new UsageError(`invalid --port: ${raw}`);
      }
      options.port = port;
      continue;
    }
    if (arg === "--state") {
      const raw = args[++i];
      if (!raw) throw new UsageError("--state requires a path");
      options.stateFile = raw;
      continue;
    }
    throw new UsageError(`unknown gateway option: ${arg}`);
  }
  return options;
}

async function main(argv) {
  const [command, ...rest] = argv;

  if (command === undefined) {
    const { serveStdio } = await loadModule("adapters/inbound/mcp/server");
    await serveStdio();
    return;
  }
  if (command === "--help" || command === "-h") {
    console.log(USAGE);
    return;
  }
  if (command === "gateway") {
    const options = parseGatewayArgs(rest);
    if (options.help) {
      console.log(USAGE);
      return;
    }
    const { serveGateway } = await loadModule("adapters/inbound/gateway");
    await serveGateway(options);
    return;
  }
  throw new UsageError(`unknown command: ${command}`);
}

try {
  await main(process.argv.slice(2));
} catch (err) {
  if (err instanceof UsageError) {
    console.error(`opensmm: ${err.message}\n`);
    console.error(USAGE);
    process.exitCode = 1;
  } else {
    throw err;
  }
}
