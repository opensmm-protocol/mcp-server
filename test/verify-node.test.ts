import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { after, before, describe, it } from "node:test";

const execFileAsync = promisify(execFile);
const SCRIPT = fileURLToPath(new URL("../scripts/verify-node.mjs", import.meta.url));

async function verify(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [SCRIPT, ...args]);
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

function startMockNode(): Promise<{ server: Server; baseUrl: string }> {
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    if (req.method === "GET" && path === "/v0/services") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ services: [{ serviceId: "svc_1" }], catalogVersion: "mock-1" }));
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

  it("prints PASS per check and exits 0 for a live node", async () => {
    const { code, stdout } = await verify(mock.baseUrl);
    assert.equal(code, 0);
    assert.match(stdout, /PASS {2}GET \/v0\/services {2,}1 service/);
    assert.match(stdout, /PASS {2}POST \/mcp initialize/);
    assert.match(stdout, /PASS {2}node is counted by the census \(2\/2 checks/);
    assert.doesNotMatch(stdout, /FAIL/);
  });

  it("prints FAIL and exits 1 for a closed port", async () => {
    const { server, baseUrl } = await startMockNode();
    await new Promise<void>((resolve) => server.close(() => resolve()));

    const { code, stdout, stderr } = await verify(baseUrl);
    assert.equal(code, 1);
    assert.match(stdout, /FAIL {2}GET \/v0\/services/);
    assert.match(stdout, /FAIL {2}POST \/mcp initialize/);
    assert.match(stdout, /FAIL {2}node is not counted by the census \(0\/2 checks/);
    assert.ok(stderr.length > 0);
  });

  it("exits 1 without a URL or with a malformed one", async () => {
    assert.equal((await verify()).code, 1);
    assert.equal((await verify("not-a-url")).code, 1);
    assert.equal((await verify("http://user:s3cret@127.0.0.1:1")).code, 1);
    const { stderr } = await verify("http://user:s3cret@127.0.0.1:1");
    assert.doesNotMatch(stderr, /s3cret/);
  });
});
