#!/usr/bin/env node
/**
 * Writes the publish copy of `server.json`: the tracked manifest plus
 * `fileSha256` of the given bundle. The registry requires the hash for MCPB;
 * it is never committed, because it is only known for the released asset.
 *
 * Usage:
 *   node scripts/render-registry-manifest.mjs <bundle.mcpb> <output.json>
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TRACKED = ["server.json", "mcp.json", "website/mcp.json"].map((file) => path.join(repoRoot, file));

const [bundle, output] = process.argv.slice(2);

if (!bundle || !output) {
  console.error("usage: render-registry-manifest.mjs <bundle.mcpb> <output.json>");
  process.exitCode = 1;
} else if (TRACKED.includes(path.resolve(output))) {
  console.error(`refusing to overwrite the tracked manifest ${output}`);
  process.exitCode = 1;
} else {
  const manifest = JSON.parse(readFileSync(path.join(repoRoot, "server.json"), "utf8"));
  const fileSha256 = createHash("sha256").update(readFileSync(bundle)).digest("hex");
  manifest.packages[0].fileSha256 = fileSha256;
  writeFileSync(output, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`wrote ${output} (fileSha256 ${fileSha256})`);
}
