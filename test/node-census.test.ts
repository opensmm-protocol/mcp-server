import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { after, before, describe, it } from "node:test";

const execFileAsync = promisify(execFile);
const SCRIPT = fileURLToPath(new URL("../scripts/node-census.mjs", import.meta.url));

type CensusNode = {
  url: string;
  services: number | null;
  providers: number | null;
  initialize: boolean;
  latencyMs: number;
  status: "up" | "down";
  error?: string;
};

async function census(...args: string[]): Promise<{ code: number; nodes: CensusNode[]; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [SCRIPT, ...args]);
    return { code: 0, nodes: JSON.parse(stdout) as CensusNode[], stderr };
  } catch (err) {
    const failure = err as { code?: number; stdout?: string };
    return {
      code: typeof failure.code === "number" ? failure.code : 1,
      nodes: failure.stdout ? (JSON.parse(failure.stdout) as CensusNode[]) : [],
      stderr: "",
    };
  }
}

function startMockNode(): Promise<{ server: Server; baseUrl: string }> {
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    if (req.method === "GET" && path === "/v0/services") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ services: [{ serviceId: "svc_1" }], catalogVersion: "mock-1" }));
      return;
    }
    if (req.method === "GET" && path === "/v0/providers") {
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

describe("scripts/node-census.mjs", () => {
  let mock: { server: Server; baseUrl: string };

  before(async () => {
    mock = await startMockNode();
  });

  after(async () => {
    await new Promise<void>((resolve, reject) =>
      mock.server.close((err) => (err ? reject(err) : resolve())),
    );
  });

  it("reports a responding gateway as one up node", async () => {
    const { code, nodes, stderr } = await census("--url", mock.baseUrl);
    assert.equal(code, 0);
    assert.equal(nodes.length, 1);
    assert.equal(nodes[0]!.status, "up");
    assert.equal(nodes[0]!.services, 1);
    assert.equal(nodes[0]!.providers, 1);
    assert.equal(nodes[0]!.initialize, true);
    assert.match(stderr, /1 узел: 1 up, 0 down/);
  });

  it("reports a closed port as down and still exits 0", async () => {
    const { server, baseUrl } = await startMockNode();
    await new Promise<void>((resolve) => server.close(() => resolve()));

    const { code, nodes } = await census("--url", baseUrl);
    assert.equal(code, 0);
    assert.equal(nodes.length, 1);
    assert.equal(nodes[0]!.status, "down");
    assert.equal(nodes[0]!.initialize, false);
    assert.ok(nodes[0]!.error);
  });

  it("reads URLs from --file and ignores comments and blank lines", async () => {
    const dir = await mkdtemp(join(tmpdir(), "node-census-"));
    const file = join(dir, "nodes.txt");
    await writeFile(file, `# known OpenSMM nodes\n\n${mock.baseUrl}\n`, "utf8");

    const { code, nodes } = await census("--file", file);
    assert.equal(code, 0);
    assert.equal(nodes.length, 1);
    assert.equal(nodes[0]!.url, mock.baseUrl);
    assert.equal(nodes[0]!.status, "up");
  });

  it("exits 1 on broken arguments", async () => {
    assert.equal((await census()).code, 1);
    assert.equal((await census("--url", "not-a-url")).code, 1);
    assert.equal((await census("--nope")).code, 1);

    const tooMany = Array.from({ length: 21 }, () => ["--url", mock.baseUrl]).flat();
    assert.equal((await census(...tooMany)).code, 1);
  });
});
