#!/usr/bin/env node
/**
 * Builds the MCP Bundle (`.mcpb`) that the MCP Registry entry points to:
 * `build/opensmm-mcp-server-<version>.mcpb`.
 *
 * The bundle is staged in a temp dir from an explicit list of files, with
 * production `node_modules` installed there from the lockfile, so no local
 * `.env`, state file, test or dev dependency can get in.
 *
 * Usage: npm run build:mcpb
 */
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const MCPB_CLI = path.join(repoRoot, "node_modules", "@anthropic-ai", "mcpb", "dist", "cli", "cli.js");

const BUNDLE_PATHS = ["dist", "bin", "spec", "package.json", "LICENSE", "README.md"];
// Tests that third-party packages publish inside their npm tarballs.
const IGNORED = ["test", "tests", "__tests__", "*.test.*"].map((name) => `node_modules/**/${name}`);

export function bundleName(version) {
  return `opensmm-mcp-server-${version}.mcpb`;
}

function bundleManifest(pkg) {
  return {
    manifest_version: "0.3",
    name: "opensmm-mcp-server",
    display_name: "OpenSMM MCP server (mock catalog)",
    version: pkg.version,
    description:
      "OpenSMM protocol demo over MCP. The catalog is a mock: no real services, orders or payments.",
    author: { name: "OpenSMM Protocol", url: pkg.homepage },
    repository: { type: "git", url: pkg.repository.url },
    homepage: pkg.homepage,
    license: pkg.license,
    server: {
      type: "node",
      entry_point: "bin/opensmm.mjs",
      mcp_config: { command: "node", args: ["${__dirname}/bin/opensmm.mjs", "mcp"] },
    },
    compatibility: { runtimes: { node: pkg.engines.node } },
  };
}

function run(command, args, cwd) {
  execFileSync(command, args, { cwd, stdio: "inherit" });
}

/** Build the bundle and return its absolute path. */
export function buildBundle() {
  const pkg = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  const output = path.join(repoRoot, "build", bundleName(pkg.version));

  // `tsc` never deletes: start clean so no stale module gets bundled.
  rmSync(path.join(repoRoot, "dist"), { recursive: true, force: true });
  run("npm", ["run", "build"], repoRoot);

  const stage = mkdtempSync(path.join(os.tmpdir(), "opensmm-mcpb-stage-"));
  try {
    for (const entry of [...BUNDLE_PATHS, "package-lock.json"]) {
      cpSync(path.join(repoRoot, entry), path.join(stage, entry), { recursive: true });
    }
    // `mcpb pack` leaves package-lock.json out of the archive.
    run("npm", ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], stage);

    writeFileSync(path.join(stage, ".mcpbignore"), `${IGNORED.join("\n")}\n`);
    const manifestPath = path.join(stage, "manifest.json");
    writeFileSync(manifestPath, `${JSON.stringify(bundleManifest(pkg), null, 2)}\n`);

    mkdirSync(path.dirname(output), { recursive: true });
    rmSync(output, { force: true });
    run(process.execPath, [MCPB_CLI, "validate", manifestPath], repoRoot);
    run(process.execPath, [MCPB_CLI, "pack", stage, output], repoRoot);
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
  return output;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(`built ${buildBundle()}`);
}
