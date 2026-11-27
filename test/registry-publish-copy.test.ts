/**
 * The publish copy of `server.json` (with `fileSha256`) and the registry API
 * check that `registry-publish.yml` relies on.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
// @ts-expect-error: untyped .mjs script
import { findMismatch } from "../scripts/check-registry-entry.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..");
const render = path.join(repoRoot, "scripts", "render-registry-manifest.mjs");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opensmm-publish-copy-"));
const tracked = ["server.json", "mcp.json", "website/mcp.json"];
const readTracked = () => tracked.map((file) => fs.readFileSync(path.join(repoRoot, file), "utf8"));

after(() => fs.rmSync(dir, { recursive: true, force: true }));

function runRender(...args: string[]) {
  return spawnSync(process.execPath, [render, ...args], { cwd: repoRoot, encoding: "utf8" });
}

describe("registry publish copy", () => {
  it("adds the SHA-256 of the file and leaves tracked manifests unchanged", () => {
    const bundle = path.join(dir, "bundle.mcpb");
    const output = path.join(dir, "server.publish.json");
    fs.writeFileSync(bundle, "bundle bytes");
    const before = readTracked();

    const result = runRender(bundle, output);

    assert.equal(result.status, 0, result.stderr);
    const expected = JSON.parse(before[0]!);
    expected.packages[0].fileSha256 = createHash("sha256").update("bundle bytes").digest("hex");
    assert.deepEqual(JSON.parse(fs.readFileSync(output, "utf8")), expected);
    assert.deepEqual(readTracked(), before);
  });

  it("refuses to write over a tracked manifest", () => {
    const bundle = path.join(dir, "other.mcpb");
    fs.writeFileSync(bundle, "x");
    const before = readTracked();

    for (const target of tracked) {
      assert.equal(runRender(bundle, target).status, 1, target);
    }
    assert.deepEqual(readTracked(), before);
  });

  it("fails when the bundle is missing", () => {
    assert.notEqual(runRender(path.join(dir, "absent.mcpb"), path.join(dir, "x.json")).status, 0);
  });
});

describe("registry entry check", () => {
  const manifest = {
    name: "io.github.opensmm-protocol/mcp-server",
    version: "1.2.3",
    packages: [{ identifier: "https://github.com/o/r/releases/download/v1.2.3/mcp.mcpb", fileSha256: "a".repeat(64) }],
  };

  async function ask(status: number, body: unknown): Promise<string | undefined> {
    const server = http.createServer((req, res) => {
      const known = req.url === "/v0/servers/io.github.opensmm-protocol%2Fmcp-server/versions/1.2.3";
      res.writeHead(known ? status : 400).end(JSON.stringify(body));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      return await findMismatch(manifest, `http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    } finally {
      server.close();
    }
  }

  it("passes when the version is listed with the identifier and hash", async () => {
    assert.equal(await ask(200, { server: manifest }), undefined);
  });

  it("fails when the API has no entry", async () => {
    assert.match((await ask(404, { title: "Not Found" }))!, /HTTP 404/);
  });

  it("fails when the listed hash or identifier differs", async () => {
    for (const change of [{ fileSha256: "b".repeat(64) }, { identifier: "https://example.com/mcp.mcpb" }]) {
      const server = { ...manifest, packages: [{ ...manifest.packages[0], ...change }] };
      assert.match((await ask(200, { server }))!, /listed without identifier/);
    }
  });

  it("fails when the API returns another version", async () => {
    assert.match((await ask(200, { server: { ...manifest, version: "1.2.2" } }))!, /does not return/);
  });
});
