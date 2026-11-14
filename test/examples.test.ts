/**
 * examples/ guard rail (ZHC-663): the REST and the MCP client examples must
 * run end to end against a node on the mock catalog — no keys, no money — and
 * must land on the same orderId for the same clientReference.
 *
 * The node is a real process (`bin/opensmm.mjs gateway`), the examples are
 * launched as users launch them: `node examples/<client>.mjs <url>`.
 */

import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const BIN = path.join(REPO_ROOT, "bin", "opensmm.mjs");
const REST_EXAMPLE = path.join(REPO_ROOT, "examples", "rest-client.mjs");
const MCP_EXAMPLE = path.join(REPO_ROOT, "examples", "mcp-client.mjs");

/** A node must not inherit provider/payment config from the developer shell. */
const CLEAN_ENV = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) => !/^(OPENSMM_|X402_|PORT$|MCP_HTTP_PORT$)/.test(key),
  ),
);

interface ExampleRun {
  code: number;
  stdout: string;
  stderr: string;
}

async function runExample(script: string, args: string[]): Promise<ExampleRun> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [script, ...args], {
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

/** Read one `<name>: <value>` line the examples print. */
function field(stdout: string, name: string): string {
  const match = new RegExp(`^${name}:\\s+(\\S+)`, "m").exec(stdout);
  assert.ok(match, `example output has no "${name}:" line:\n${stdout}`);
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

describe("examples — REST and MCP clients against a mock node", () => {
  let dir: string;
  let child: ChildProcess;
  let baseUrl: string;
  let rest: ExampleRun;
  let restQuote: string;
  let restOrder: string;

  before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "opensmm-examples-"));
    ({ child, baseUrl } = await startNode(path.join(dir, "state.json")));
    rest = await runExample(REST_EXAMPLE, [baseUrl, "--client-reference", "examples-test-shared"]);
    if (rest.code === 0) {
      restQuote = field(rest.stdout, "quote");
      restOrder = field(rest.stdout, "order");
    }
  });

  after(async () => {
    await stopNode(child);
    await rm(dir, { recursive: true, force: true });
  });

  it("the REST example orders and prints the same orderId on replay", () => {
    assert.equal(rest.code, 0, `examples/rest-client.mjs failed:\n${rest.stderr}`);
    assert.match(rest.stdout, /^catalog: MOCK/m, "the mock catalog is labelled as mock");
    assert.match(rest.stdout, /synthetic/i, "the output states the services are synthetic");
    assert.match(restQuote, /^osmm_quote_/);
    assert.match(restOrder, /^osmm_order_/);
    assert.equal(field(rest.stdout, "replay"), restOrder, "the replay prints the same orderId");
  });

  it("the MCP example orders and prints the same orderId on replay", async () => {
    const run = await runExample(MCP_EXAMPLE, [baseUrl, "--client-reference", "examples-test-mcp"]);
    assert.equal(run.code, 0, `examples/mcp-client.mjs failed:\n${run.stderr}`);
    assert.match(run.stdout, /^catalog: MOCK/m, "the mock catalog is labelled as mock");
    assert.match(run.stdout, /JSON-RPC on POST \/mcp/, "the output names the transport");
    assert.match(field(run.stdout, "quote"), /^osmm_quote_/);
    assert.equal(field(run.stdout, "replay"), field(run.stdout, "order"));
  });

  it("both clients reach one orderId for the same clientReference", async () => {
    assert.equal(rest.code, 0, `the REST run must succeed first:\n${rest.stderr}`);
    const run = await runExample(MCP_EXAMPLE, [
      baseUrl,
      "--client-reference",
      "examples-test-shared",
      "--quote",
      restQuote,
    ]);
    assert.equal(run.code, 0, `the MCP replay of the REST order failed:\n${run.stderr}`);
    assert.equal(field(run.stdout, "order"), restOrder, "REST and MCP must share one orderId");
    assert.equal(field(run.stdout, "replay"), restOrder);
  });
});
