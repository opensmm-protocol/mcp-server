/**
 * Agent-stack examples (ZHC-1052): the Claude Desktop / Cursor configs must
 * point at real npm scripts and the MCP endpoint, the n8n workflow must walk
 * the REST chain with a mock-only guard, and the LangChain-style script must
 * be runnable against a local node (and refuse a non-mock catalog).
 */
import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const BIN = path.join(REPO_ROOT, "bin", "opensmm.mjs");
const LANGCHAIN = path.join(REPO_ROOT, "examples", "langchain", "agent.mjs");

/** A node must not inherit provider/payment config from the developer shell. */
const CLEAN_ENV = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !/^(OPENSMM_|X402_|PORT$|MCP_HTTP_PORT$)/.test(key)),
);

const at = (relative: string) => path.join(REPO_ROOT, relative);
const read = (relative: string) => readFileSync(at(relative), "utf8");
const pkg = JSON.parse(read("package.json"));

/** Every relative Markdown link in these docs must resolve on disk. */
function internalLinks(relativeDoc: string): string[] {
  const targets: string[] = [];
  for (const [, target] of read(relativeDoc).matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    if (/^(https?:|mailto:|#)/.test(target)) continue;
    targets.push(path.resolve(path.dirname(at(relativeDoc)), target.split("#")[0]));
  }
  return targets;
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function runScript(args: string[]): Promise<RunResult> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [LANGCHAIN, ...args], {
      cwd: REPO_ROOT,
      env: CLEAN_ENV,
      encoding: "utf8",
      timeout: 30_000,
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const failure = err as { code?: number; stdout?: string; stderr?: string; message?: string };
    return {
      code: typeof failure.code === "number" ? failure.code : 1,
      stdout: failure.stdout ?? "",
      stderr: failure.stderr || failure.message || "",
    };
  }
}

function field(stdout: string, name: string): string {
  const match = new RegExp(`^${name}:\\s+(\\S+)`, "m").exec(stdout);
  assert.ok(match, `script output has no "${name}:" line:\n${stdout}`);
  return match[1]!;
}

async function startNode(stateFile: string): Promise<{ child: ChildProcess; baseUrl: string }> {
  const child = spawn(process.execPath, [BIN, "gateway", "--port", "0", "--state", stateFile], {
    cwd: REPO_ROOT,
    env: CLEAN_ENV,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`gateway did not report a port in 20s; stderr:\n${stderr}`)),
      20_000,
    );
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
      const match = /listening on http:\/\/localhost:(\d+)/.exec(stderr);
      if (match) {
        clearTimeout(timer);
        resolve(Number(match[1]));
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`gateway exited early (code ${code}); stderr:\n${stderr}`));
    });
  });
  return { child, baseUrl: `http://127.0.0.1:${port}` };
}

async function stopNode(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, 10_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill("SIGTERM");
  });
}

describe("agent-stack examples are shipped and cross-linked (ZHC-1052)", () => {
  const FILES = [
    "examples/claude-desktop/claude_desktop_config.json",
    "examples/claude-desktop/README.md",
    "examples/cursor/.cursor/mcp.json",
    "examples/cursor/README.md",
    "examples/langchain/agent.mjs",
    "examples/langchain/README.md",
    "examples/n8n/workflow.json",
    "examples/n8n/README.md",
    "docs/AGENT_QUICKSTART.md",
  ];

  it("ships all four example directories and the 5-minute guide", () => {
    for (const file of FILES) assert.ok(existsSync(at(file)), `${file} must exist`);
  });

  it("README.md and examples/README.md link the guide and all four stacks", () => {
    const readme = read("README.md");
    const examples = read("examples/README.md");
    for (const target of [
      "docs/AGENT_QUICKSTART.md",
      "examples/claude-desktop/README.md",
      "examples/cursor/README.md",
      "examples/langchain/README.md",
      "examples/n8n/README.md",
    ]) {
      assert.ok(readme.includes(target), `README.md must link ${target}`);
    }
    for (const target of [
      "../docs/AGENT_QUICKSTART.md",
      "claude-desktop/README.md",
      "cursor/README.md",
      "langchain/README.md",
      "n8n/README.md",
    ]) {
      assert.ok(examples.includes(target), `examples/README.md must link ${target}`);
    }
  });

  it("has no broken relative links in the new docs", () => {
    for (const doc of [
      "README.md",
      "examples/README.md",
      "docs/AGENT_QUICKSTART.md",
      "examples/claude-desktop/README.md",
      "examples/cursor/README.md",
      "examples/langchain/README.md",
      "examples/n8n/README.md",
    ]) {
      for (const target of internalLinks(doc)) {
        assert.ok(existsSync(target), `${doc}: broken link -> ${path.relative(REPO_ROOT, target)}`);
      }
    }
  });
});

describe("MCP client configs (ZHC-1052)", () => {
  it("Claude Desktop starts the stdio server via npm run mcp", () => {
    const config = JSON.parse(read("examples/claude-desktop/claude_desktop_config.json"));
    const server = config.mcpServers.opensmm;
    assert.equal(server.command, "npm");
    assert.deepEqual(server.args, ["run", "mcp"]);
    assert.ok(server.cwd, "cwd must point at the checkout");
    assert.ok("mcp" in pkg.scripts, "the config must reference a real package.json script");
  });

  it("Cursor connects over HTTP POST /mcp", () => {
    const config = JSON.parse(read("examples/cursor/.cursor/mcp.json"));
    const server = config.mcpServers.opensmm;
    assert.equal(server.command, undefined, "HTTP transport needs no local process");
    assert.match(server.url, /\/mcp$/);
  });
});

describe("n8n workflow (ZHC-1052)", () => {
  const workflow = JSON.parse(read("examples/n8n/workflow.json"));
  const nodes = new Map<string, any>(workflow.nodes.map((node: any) => [node.name, node]));

  it("walks catalog → quote → order → replay → poll over REST", () => {
    const http = workflow.nodes.filter((node: any) => node.type === "n8n-nodes-base.httpRequest");
    assert.ok(
      http.some((node: any) => node.parameters.method === "GET" && node.parameters.url.includes("/v0/services")),
      "a GET /v0/services node is required",
    );
    assert.ok(
      http.some((node: any) => node.parameters.method === "POST" && node.parameters.url.includes("/v0/quotes")),
      "a POST /v0/quotes node is required",
    );
    for (const name of ["Create order", "Replay order"]) {
      const node = nodes.get(name);
      assert.ok(node, `${name} node is required`);
      assert.equal(node.parameters.method, "POST");
      assert.equal(
        node.parameters.options?.response?.response?.neverError,
        true,
        `${name} must accept the expected 402`,
      );
      assert.match(node.parameters.jsonBody, /clientReference/);
    }
    assert.equal(
      nodes.get("Create order").parameters.jsonBody,
      nodes.get("Replay order").parameters.jsonBody,
      "order and replay must send an identical body",
    );
    assert.match(nodes.get("Poll order").parameters.url, /\/v0\/orders\//);
  });

  it("refuses non-mock catalogs before quoting", () => {
    assert.match(nodes.get("Guard: mock only").parameters.jsCode, /synthetic/);
    assert.match(nodes.get("Verify idempotency").parameters.jsCode, /orderId/);
  });
});

describe("LangChain-style example against a local node (ZHC-1052)", () => {
  let dir: string;
  let child: ChildProcess;
  let baseUrl: string;

  before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "opensmm-agent-stacks-"));
    ({ child, baseUrl } = await startNode(path.join(dir, "state.json")));
  });

  after(async () => {
    await stopNode(child);
    await rm(dir, { recursive: true, force: true });
  });

  it("orders catalog → quote → order → replay and lands on one orderId", async () => {
    const run = await runScript([baseUrl, "--client-reference", "agent-stacks-test"]);
    assert.equal(run.code, 0, `examples/langchain/agent.mjs failed:\n${run.stderr}`);
    assert.match(run.stdout, /^catalog:\s+MOCK/m, "the mock catalog is labelled as mock");
    assert.match(run.stdout, /POST \/mcp/, "the output names the MCP transport");
    const quote = field(run.stdout, "quote");
    const order = field(run.stdout, "order");
    assert.match(quote, /^osmm_quote_/);
    assert.match(order, /^osmm_order_/);
    assert.equal(field(run.stdout, "replay"), order, "one clientReference → one orderId");
  });

  it("refuses a catalog whose service is not synthetic", async () => {
    const fake: Server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk.toString()));
      req.on("end", () => {
        const request = JSON.parse(body);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: request.id,
            result: {
              structuredContent: {
                services: [{ serviceId: "real_svc", name: "real supply", synthetic: false }],
              },
            },
          }),
        );
      });
    });
    await new Promise<void>((resolve) => fake.listen(0, "127.0.0.1", resolve));
    const address = fake.address();
    if (!address || typeof address === "string") throw new Error("fake server has no port");
    try {
      const run = await runScript([
        `http://127.0.0.1:${address.port}`,
        "--client-reference",
        "must-not-order",
      ]);
      assert.notEqual(run.code, 0, "the script must fail on a non-mock catalog");
      assert.match(run.stderr, /refusing to place a demo order/);
    } finally {
      await new Promise<void>((resolve) => fake.close(() => resolve()));
    }
  });
});
