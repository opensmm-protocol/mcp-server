#!/usr/bin/env node
/**
 * Asks the MCP Registry API whether it lists the version of a publish manifest
 * with the same package identifier and `fileSha256`. A green publish step is
 * not proof of publication; this answer is.
 *
 * Usage:
 *   node scripts/check-registry-entry.mjs <publish-server.json> [attempts]
 *
 * Exits 0 when listed, 1 when not listed after all attempts.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REGISTRY_URL = "https://registry.modelcontextprotocol.io";

/** Resolves to `undefined` when listed, otherwise to the reason it is not. */
export async function findMismatch(manifest, registryUrl = REGISTRY_URL) {
  const url = `${registryUrl}/v0/servers/${encodeURIComponent(manifest.name)}/versions/${encodeURIComponent(manifest.version)}`;
  let body;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    if (!response.ok) return `HTTP ${response.status} from ${url}`;
    body = await response.json();
  } catch (error) {
    return `cannot query ${url}: ${error.message}`;
  }

  const server = body?.server;
  if (server?.name !== manifest.name || server?.version !== manifest.version) {
    return `${url} does not return ${manifest.name} ${manifest.version}`;
  }
  const [expected] = manifest.packages;
  const listed = server.packages?.some(
    (pkg) => pkg.identifier === expected.identifier && pkg.fileSha256 === expected.fileSha256,
  );
  if (!expected.fileSha256 || !listed) {
    return `${manifest.version} is listed without identifier ${expected.identifier} and fileSha256 ${expected.fileSha256}`;
  }
  return undefined;
}

async function main([manifestPath, attemptsArg = "1"]) {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const attempts = Number(attemptsArg);
  let reason = `invalid attempts: ${attemptsArg}`;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    reason = await findMismatch(manifest);
    if (!reason) {
      console.log(`listed in the MCP Registry: ${manifest.name} ${manifest.version}`);
      return 0;
    }
    if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, 10_000));
  }
  console.error(`not listed in the MCP Registry: ${reason}`);
  return 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
