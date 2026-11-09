import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

const repoRoot = path.resolve(import.meta.dirname, "..");
const validator = path.join(repoRoot, "scripts", "validate-server-manifest.mjs");
const fixtures = path.join(repoRoot, "test", "fixtures", "registry");

function runValidator(manifestPath: string) {
  return spawnSync(process.execPath, [validator, manifestPath], {
    encoding: "utf8",
    cwd: repoRoot,
  });
}

function assertRejected(fixture: string, expectedMessage: string): void {
  const result = runValidator(path.join(fixtures, fixture));

  assert.notEqual(result.status, 0, `${fixture} must exit with a non-zero code`);
  assert.match(result.stderr, new RegExp(expectedMessage.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
}

describe("registry manifest validator", () => {
  it("is wired into package.json under the documented script name", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
    assert.equal(pkg.scripts["validate:manifest"], "node scripts/validate-server-manifest.mjs");
  });

  it("ships the vendored 2025-12-11 registry schema", () => {
    const schemaPath = path.join(repoRoot, "scripts", "schemas", "server-2025-12-11.schema.json");
    const schema = JSON.parse(fs.readFileSync(schemaPath, "utf8"));

    assert.equal(schema.$id, "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json");
  });

  it("accepts the repository server.json", () => {
    const result = runValidator(path.join(repoRoot, "server.json"));

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /valid MCP Registry manifest/);
  });

  it("accepts a valid manifest fixture", () => {
    const result = runValidator(path.join(fixtures, "valid-server.json"));

    assert.equal(result.status, 0, result.stderr);
  });

  it("rejects a manifest whose description exceeds 100 characters", () => {
    assertRejected("broken-description.json", "/description must be at most 100 characters");
  });

  it("rejects a package with a blank identifier", () => {
    assertRejected("broken-identifier.json", "/packages/0/identifier must be a non-empty string");
  });

  it("rejects a manifest that declares remotes", () => {
    assertRejected("broken-remotes.json", "/remotes must be absent or empty");
  });

  it("declares the registry name in package.json mcpName", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
    const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, "server.json"), "utf8"));

    assert.equal(pkg.mcpName, manifest.name);
  });

  it("rejects a manifest whose name does not match package.json mcpName", () => {
    assertRejected("broken-mcp-name.json", 'package.json mcpName ("io.github.opensmm-protocol/mcp-server")');
  });

  it("rejects a package that breaks the registry schema", () => {
    assertRejected("broken-schema.json", "must have required property");
  });

  it("rejects a manifest that is not valid JSON", () => {
    assertRejected("broken-json.json", "cannot read or parse");
  });
});
