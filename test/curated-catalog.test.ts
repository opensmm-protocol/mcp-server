import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, describe, it } from "node:test";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createStackFromEnv } from "../src/bootstrap.ts";
import { createRestHandler } from "../src/adapters/inbound/rest/handler.ts";
import { createMcpServer } from "../src/adapters/inbound/mcp/server.ts";
import {
  CuratedCatalogError,
  loadCuratedCatalog,
  parseCuratedCatalog,
} from "../src/core/curated-catalog.ts";
import { MOCK_CATALOG_VERSION, mockCatalogEntries } from "../src/adapters/providers/mock/seed.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const STUB_PATH = path.join(REPO_ROOT, "data/curated-services.json");
const SCHEMAS_DIR = path.join(REPO_ROOT, "spec/v0/schemas");

const tmpDirs: string[] = [];

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opensmm-curated-"));
  tmpDirs.push(dir);
  return dir;
}

function stubFile(): any {
  return JSON.parse(fs.readFileSync(STUB_PATH, "utf8"));
}

function writeCatalog(data: unknown): string {
  const file = path.join(tmpDir(), "curated-services.json");
  fs.writeFileSync(file, typeof data === "string" ? data : JSON.stringify(data, null, 2));
  return file;
}

/** Run `fn` with the curated env var set, restoring the environment afterwards. */
async function withCuratedEnv<T>(
  value: string | undefined,
  fn: () => Promise<T>,
  extraEnv: Record<string, string> = {},
): Promise<T> {
  const saved = {
    curated: process.env.OPENSMM_CURATED_CATALOG,
    baseUrl: process.env.OPENSMM_REST_V1_BASE_URL,
    apiKey: process.env.OPENSMM_REST_V1_API_KEY,
    facilitator: process.env.X402_FACILITATOR_URL,
  };
  delete process.env.OPENSMM_REST_V1_BASE_URL;
  delete process.env.OPENSMM_REST_V1_API_KEY;
  delete process.env.X402_FACILITATOR_URL;
  if (value === undefined) delete process.env.OPENSMM_CURATED_CATALOG;
  else process.env.OPENSMM_CURATED_CATALOG = value;
  for (const [key, envValue] of Object.entries(extraEnv)) process.env[key] = envValue;
  try {
    return await fn();
  } finally {
    for (const [key, savedValue] of [
      ["OPENSMM_CURATED_CATALOG", saved.curated],
      ["OPENSMM_REST_V1_BASE_URL", saved.baseUrl],
      ["OPENSMM_REST_V1_API_KEY", saved.apiKey],
      ["X402_FACILITATOR_URL", saved.facilitator],
    ] as const) {
      if (savedValue === undefined) delete process.env[key];
      else process.env[key] = savedValue;
    }
  }
}

after(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

describe("curated public catalog", () => {
  it("ships an example stub that passes validation", () => {
    const loaded = loadCuratedCatalog(STUB_PATH);
    assert.equal(loaded.file.format, 1);
    assert.equal(loaded.file.entries.length, 3);
    assert.equal(loaded.exampleCount, 3, "every stub record must be marked as an example");
    assert.equal(loaded.catalog.list().length, 3);
    assert.equal(loaded.catalog.version, loaded.file.version);
    for (const entry of loaded.file.entries) {
      assert.equal(entry.example, true);
      assert.ok(entry.provenance.sourceUrl.startsWith("https://"));
      assert.match(entry.provenance.syncedAt, /T.*Z$/);
      assert.ok(entry.provenance.providerId.length > 0);
      assert.ok(entry.provenance.externalServiceId.length > 0);
    }
  });

  it("stub services satisfy the protocol Service JSON schema", () => {
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    const applyFormats = typeof addFormats === "function" ? addFormats : (addFormats as any).default;
    applyFormats(ajv);
    for (const file of fs.readdirSync(SCHEMAS_DIR).filter((f) => f.endsWith(".json"))) {
      const raw = JSON.parse(fs.readFileSync(path.join(SCHEMAS_DIR, file), "utf8"));
      ajv.addSchema(raw, raw.$id);
    }
    const validate = ajv.getSchema("https://opensmm.dev/spec/v0/schemas/service.json");
    assert.ok(validate);
    for (const entry of stubFile().entries) {
      const valid = validate(entry.service);
      assert.ok(
        valid,
        `stub service ${entry.service.serviceId} is off-spec: ${JSON.stringify(validate.errors)}`,
      );
    }
  });

  it("rejects a duplicate serviceId", () => {
    const file = stubFile();
    file.entries[1].service.serviceId = file.entries[0].service.serviceId;
    assert.throws(
      () => parseCuratedCatalog(file, "fixture"),
      /duplicate osmm_svc_tg_members_std/,
    );
  });

  it("rejects a duplicate provider offer (providerId + externalServiceId)", () => {
    const file = stubFile();
    file.entries[1].provenance.externalServiceId = file.entries[0].provenance.externalServiceId;
    assert.throws(
      () => parseCuratedCatalog(file, "fixture"),
      /duplicate provider offer mock\/1001/,
    );
  });

  it("rejects out-of-range rating, rate and quantities", () => {
    const rating = stubFile();
    rating.entries[0].rating = 5.5;
    assert.throws(() => parseCuratedCatalog(rating, "fixture"), /entries\.0\.rating/);

    const rate = stubFile();
    rate.entries[0].service.rate.value = "999999.000000";
    assert.throws(() => parseCuratedCatalog(rate, "fixture"), /outside/);

    const zeroRate = stubFile();
    zeroRate.entries[0].service.rate.value = "0.000000";
    assert.throws(() => parseCuratedCatalog(zeroRate, "fixture"), /outside/);

    const quantity = stubFile();
    quantity.entries[0].service.maxQuantity = 10;
    assert.throws(() => parseCuratedCatalog(quantity, "fixture"), /below minQuantity/);
  });

  it("requires provenance on every record", () => {
    const file = stubFile();
    delete file.entries[0].provenance;
    assert.throws(() => parseCuratedCatalog(file, "fixture"), /entries\.0\.provenance/);
  });

  it("refuses a broken file at boot", async () => {
    const file = writeCatalog("{ not json");
    await assert.rejects(
      withCuratedEnv(file, () => createStackFromEnv()),
      (err: unknown) => {
        assert.ok(err instanceof CuratedCatalogError);
        assert.match(err.message, new RegExp(file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
        assert.match(err.message, /cannot read JSON/);
        return true;
      },
    );
  });

  it("refuses a catalog whose provider is not registered", async () => {
    const file = stubFile();
    for (const entry of file.entries) entry.provenance.providerId = "ghost-provider";
    const at = writeCatalog(file);
    await assert.rejects(
      withCuratedEnv(at, () => createStackFromEnv()),
      /unknown providerId: ghost-provider/,
    );
  });

  it("serves the curated set identically over REST and MCP", async () => {
    let server: Server | undefined;
    let mcpClient: Client | undefined;
    try {
      await withCuratedEnv(STUB_PATH, async () => {
        const stack = await createStackFromEnv();
        server = createServer((req, res) => void createRestHandler(stack.core)(req, res));
        await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
        const { port } = server.address() as AddressInfo;

        const restServices = await (await fetch(`http://127.0.0.1:${port}/v0/services`)).json();
        const restProviders = await (await fetch(`http://127.0.0.1:${port}/v0/providers`)).json();

        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await createMcpServer(stack.core).connect(serverTransport);
        mcpClient = new Client({ name: "curated-test", version: "0.0.1" });
        await mcpClient.connect(clientTransport);
        const mcpServices = (await mcpClient.callTool({ name: "search_services", arguments: {} }))
          .structuredContent as any;

        const restIds = restServices.services.map((s: any) => s.serviceId).sort();
        const mcpIds = mcpServices.services.map((s: any) => s.serviceId).sort();
        const stubIds = stubFile()
          .entries.map((e: any) => e.service.serviceId)
          .sort();

        assert.deepEqual(restIds, stubIds);
        assert.deepEqual(mcpIds, stubIds);
        assert.equal(restServices.catalogVersion, mcpServices.catalogVersion);
        assert.equal(restProviders.providers[0].offersCount, stubIds.length);
      });
    } finally {
      if (mcpClient) await mcpClient.close();
      if (server) {
        await new Promise<void>((resolve, reject) =>
          server!.close((err) => (err ? reject(err) : resolve())),
        );
      }
    }
  });

  it("does not let provider sync overwrite the curated set", async () => {
    const stack = await withCuratedEnv(STUB_PATH, () => createStackFromEnv());
    const report = await stack.supervisor.tickSync("mock");
    assert.equal(report.ok, true);
    assert.equal(report.skipped, true);
    assert.equal(report.error, undefined);
    assert.equal(stack.core.catalog.list().length, 3);
  });

  it("boots from a curated catalog without calling the provider", async () => {
    const file = stubFile();
    for (const entry of file.entries) {
      delete entry.example;
      entry.provenance.providerId = "rest-v1";
    }
    const at = writeCatalog(file);
    const stack = await withCuratedEnv(at, () => createStackFromEnv(), {
      // Unreachable on purpose: the curated path must not call listOffers().
      OPENSMM_REST_V1_BASE_URL: "https://127.0.0.1:1/api/v1",
      OPENSMM_REST_V1_API_KEY: "test-key",
    });
    assert.equal(stack.core.catalog.list().length, 3);
    stack.supervisor.stop();
  });

  it("refuses example records once a live provider is configured", async () => {
    await assert.rejects(
      withCuratedEnv(STUB_PATH, () => createStackFromEnv(), {
        OPENSMM_REST_V1_BASE_URL: "https://provider.example/api/v1",
        OPENSMM_REST_V1_API_KEY: "test-key",
      }),
      /contains 3 example record\(s\)/,
    );
  });

  it("keeps the mock seed when OPENSMM_CURATED_CATALOG is not set", async () => {
    const stack = await withCuratedEnv(undefined, () => createStackFromEnv());
    assert.equal(stack.core.catalog.list().length, mockCatalogEntries.length);
    assert.equal(stack.core.catalog.version, MOCK_CATALOG_VERSION);
  });
});
