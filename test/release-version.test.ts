/**
 * Release version and tag (ZHC-928): `scripts/check-release-version.mjs` must
 * skip publishing instead of failing the run when a tag and the package version
 * disagree, and the release version must live in one place — `package.json` —
 * mirrored by `src/version.ts` and `server.json`.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { VERSION } from "../src/version.ts";

const repoRoot = path.resolve(import.meta.dirname, "..");
const script = path.join(repoRoot, "scripts", "check-release-version.mjs");

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opensmm-release-"));
  tempDirs.push(dir);
  return dir;
}

interface ScriptRun {
  status: number | null;
  stdout: string;
  stderr: string;
  outputs: Record<string, string>;
}

/** Run the gate the way `registry-publish.yml` does: env ref, `$GITHUB_OUTPUT` file. */
function runScript(env: { refType: string; refName: string }, cwd = repoRoot): ScriptRun {
  const outputFile = path.join(tempDir(), "github-output");
  fs.writeFileSync(outputFile, "");

  const result = spawnSync(process.execPath, [script], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GITHUB_REF_TYPE: env.refType,
      GITHUB_REF_NAME: env.refName,
      GITHUB_OUTPUT: outputFile,
    },
  });

  const outputs: Record<string, string> = {};
  for (const line of fs.readFileSync(outputFile, "utf8").split("\n")) {
    const match = /^([^=]+)=(.*)$/.exec(line);
    if (match) outputs[match[1]] = match[2];
  }

  return { status: result.status, stdout: result.stdout, stderr: result.stderr, outputs };
}

function readJson(...segments: string[]): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, ...segments), "utf8"));
}

after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

describe("release version gate", () => {
  it("publishes when the tag matches the package and manifest versions", () => {
    const pkg = readJson("package.json");
    const result = runScript({ refType: "tag", refName: `v${pkg.version}` });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.outputs.publish, "true");
    assert.equal(result.outputs.version, pkg.version);
  });

  it("skips publishing with a notice when the tag does not match the package version", () => {
    const result = runScript({ refType: "tag", refName: "v9.9.9" });

    assert.equal(result.status, 0, "a version mismatch must not fail the run");
    assert.equal(result.outputs.publish, "false");
    assert.match(result.stderr, /::notice title=release publish skipped::/);
    assert.match(result.stderr, /v9\.9\.9/);
  });

  it("skips publishing with a notice when server.json drifts from package.json", () => {
    const dir = tempDir();
    const pkg = readJson("package.json");
    fs.writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ name: pkg.name, version: pkg.version }),
    );
    fs.writeFileSync(
      path.join(dir, "server.json"),
      JSON.stringify({ name: pkg.mcpName, version: "0.0.1" }),
    );

    const result = runScript({ refType: "tag", refName: `v${pkg.version}` }, dir);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.outputs.publish, "false");
    assert.match(result.stderr, /server\.json version 0\.0\.1/);
  });

  it("fails outside a tag ref", () => {
    const result = runScript({ refType: "branch", refName: "develop" });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /::error::Publishing runs only from a v\* tag/);
  });
});

describe("release version", () => {
  it("is the same in src/version.ts, package.json, package-lock.json and server.json", () => {
    const pkg = readJson("package.json");
    const manifest = readJson("server.json");
    const packages = manifest.packages as { identifier: string }[];

    assert.equal(VERSION, pkg.version);
    assert.equal(manifest.version, pkg.version);
    assert.ok(packages[0]?.identifier.endsWith(`/v${pkg.version}/opensmm-mcp-server-${pkg.version}.mcpb`));
    const lock = readJson("package-lock.json") as { version: string; packages: Record<string, { version: string }> };
    assert.equal(lock.version, pkg.version);
    assert.equal(lock.packages[""]?.version, pkg.version);
  });

  it("keeps the manifest mirrors byte-for-byte equal to server.json", () => {
    const source = fs.readFileSync(path.join(repoRoot, "server.json"), "utf8");

    for (const target of ["mcp.json", "website/mcp.json"]) {
      assert.equal(fs.readFileSync(path.join(repoRoot, target), "utf8"), source, target);
    }
  });
});
