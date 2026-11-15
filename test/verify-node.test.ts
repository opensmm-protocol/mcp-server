import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { after, before, describe, it } from "node:test";

const execFileAsync = promisify(execFile);
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCRIPT = fileURLToPath(new URL("../scripts/verify-node.mjs", import.meta.url));

async function run(
  file: string,
  args: string[],
  cwd?: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(file, args, {
      encoding: "utf8",
      ...(cwd === undefined ? {} : { cwd }),
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const failure = err as { code?: number; stdout?: string; stderr?: string };
    return {
      code: typeof failure.code === "number" ? failure.code : 1,
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? "",
    };
  }
}

function verify(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return run(process.execPath, [SCRIPT, ...args]);
}

function verifyViaNpm(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return run("npm", ["--silent", "run", "verify:node", "--", ...args], REPO_ROOT);
}

function startMockNode(options: { providers?: boolean } = {}): Promise<{ server: Server; baseUrl: string }> {
  const withProviders = options.providers !== false;
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    if (req.method === "GET" && path === "/v0/services") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ services: [{ serviceId: "svc_1" }], catalogVersion: "mock-1" }));
      return;
    }
    if (req.method === "GET" && path === "/v0/providers" && withProviders) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ providers: [{ providerKey: "mock" }] }));
      return;
    }
    if (req.method === "POST" && path === "/mcp") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: { protocolVersion: "2025-06-18", serverInfo: { name: "mock", version: "0.0.1" } },
        }),
      );
      return;
    }
    res.writeHead(404).end();
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

describe("scripts/verify-node.mjs", () => {
  let mock: { server: Server; baseUrl: string };

  before(async () => {
    mock = await startMockNode();
  });

  after(async () => {
    await new Promise<void>((resolve, reject) =>
      mock.server.close((err) => (err ? reject(err) : resolve())),
    );
  });

  it("passes a responding node with exit 0", async () => {
    const { code, stdout } = await verify(mock.baseUrl);
    assert.equal(code, 0);
    assert.match(stdout, /^PASS {2}GET \/v0\/services — 1 service in the catalog$/m);
    assert.match(stdout, /^PASS {2}POST \/mcp initialize — 2025-06-18, server mock$/m);
    assert.match(stdout, /^PASS {2}GET \/v0\/providers — 1 provider registered {3}\(informational, not counted\)$/m);
    assert.match(stdout, /^PASS — the census counts this node: 2\/2 required checks passed/m);
  });

  it("fails a closed port with exit 1", async () => {
    const { server, baseUrl } = await startMockNode();
    await new Promise<void>((resolve) => server.close(() => resolve()));

    const { code, stdout } = await verify(baseUrl);
    assert.equal(code, 1);
    assert.match(stdout, /^FAIL {2}GET \/v0\/services — /m);
    assert.match(stdout, /^FAIL {2}POST \/mcp initialize — /m);
    assert.match(stdout, /^FAIL — the census will not count this node: 0\/2 required checks passed$/m);
  });

  it("passes a node whose /v0/providers is missing: providers are informational", async () => {
    const { server, baseUrl } = await startMockNode({ providers: false });
    try {
      const { code, stdout } = await verify(baseUrl);
      assert.equal(code, 0);
      assert.match(stdout, /^FAIL {2}GET \/v0\/providers — HTTP 404 {3}\(informational, not counted\)$/m);
      assert.match(stdout, /^PASS — the census counts this node: 2\/2 required checks passed/m);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("exits 1 on a missing or malformed URL without probing anything", async () => {
    const noUrl = await verify();
    assert.equal(noUrl.code, 1);
    assert.match(noUrl.stderr, /no URL given/);

    const notAUrl = await verify("not-a-url");
    assert.equal(notAUrl.code, 1);
    assert.match(notAUrl.stderr, /not a URL/);
  });

  it("accepts --timeout before or after the URL and rejects a bad value", async () => {
    assert.equal((await verify("--timeout", "10000", mock.baseUrl)).code, 0);
    assert.equal((await verify(mock.baseUrl, "--timeout", "10000")).code, 0);

    const bad = await verify("--timeout", "abc", mock.baseUrl);
    assert.equal(bad.code, 1);
    assert.match(bad.stderr, /--timeout: expected an integer between 1000 and 30000 ms/);
  });

  it("prints { entry, checks } as JSON with --json on an up node, exit 0", async () => {
    const { code, stdout } = await verify("--json", mock.baseUrl);
    assert.equal(code, 0);

    const parsed = JSON.parse(stdout) as {
      entry: Record<string, unknown>;
      checks: Array<Record<string, unknown>>;
    };
    assert.deepEqual(Object.keys(parsed).sort(), ["checks", "entry"]);
    assert.equal(parsed.entry.url, mock.baseUrl);
    assert.equal(parsed.entry.status, "up");
    assert.equal(parsed.entry.services, 1);
    assert.equal(parsed.entry.providers, 1);
    assert.equal(parsed.entry.initialize, true);
    assert.equal(typeof parsed.entry.latencyMs, "number");
    assert.equal(parsed.entry.error, undefined);

    assert.deepEqual(
      parsed.checks.map((check) => [check.name, check.ok, check.required]),
      [
        ["GET /v0/services", true, undefined],
        ["POST /mcp initialize", true, undefined],
        ["GET /v0/providers", true, false],
      ],
    );
    assert.equal(typeof parsed.checks[0].detail, "string");
    assert.doesNotMatch(stdout, /^PASS {2}GET /m);
  });

  it("prints JSON with entry.status down and exit 1 with --json on a closed port", async () => {
    const { server, baseUrl } = await startMockNode();
    await new Promise<void>((resolve) => server.close(() => resolve()));

    const { code, stdout } = await verify("--json", baseUrl);
    assert.equal(code, 1);

    const parsed = JSON.parse(stdout) as {
      entry: { status: string; error?: string };
      checks: Array<{ name: string; ok: boolean; required?: boolean }>;
    };
    assert.equal(parsed.entry.status, "down");
    assert.match(parsed.entry.error ?? "", /GET \/v0\/services|POST \/mcp initialize/);
    assert.deepEqual(
      parsed.checks.map((check) => [check.name, check.ok, check.required]),
      [
        ["GET /v0/services", false, undefined],
        ["POST /mcp initialize", false, undefined],
        ["GET /v0/providers", false, false],
      ],
    );
  });

  it("accepts --json before or after the URL and still rejects broken arguments", async () => {
    assert.equal((await verify(mock.baseUrl, "--json")).code, 0);

    const noUrl = await verify("--json");
    assert.equal(noUrl.code, 1);
    assert.equal(noUrl.stdout, "");
    assert.match(noUrl.stderr, /no URL given/);
  });

  it("keeps `npm --silent run verify:node -- --json` stdout pure JSON", async () => {
    const { code, stdout } = await verifyViaNpm("--json", mock.baseUrl);

    assert.equal(code, 0);
    const parsed = JSON.parse(stdout) as { entry: { status: string }; checks: unknown[] };
    assert.equal(parsed.entry.status, "up");
    assert.equal(parsed.checks.length, 3);
  });
});
