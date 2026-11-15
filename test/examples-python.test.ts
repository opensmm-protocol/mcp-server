/**
 * examples/rest-client.py (ZHC-701): the Python client example must run end
 * to end against a node on the mock catalog using the standard library only —
 * no pip install, no keys, no money — and must replay one `clientReference`
 * onto one `orderId`.
 *
 * The node is a real process (`bin/opensmm.mjs gateway`), the example is
 * launched as users launch it: `python3 examples/rest-client.py <url>`.
 */

import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const BIN = path.join(REPO_ROOT, "bin", "opensmm.mjs");
const PYTHON = process.env.PYTHON ?? "python3";
const PY_EXAMPLE = path.join(REPO_ROOT, "examples", "rest-client.py");
const EXAMPLES_README = path.join(REPO_ROOT, "examples", "README.md");

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

async function runPython(args: string[]): Promise<ExampleRun> {
  try {
    const { stdout, stderr } = await execFileAsync(PYTHON, [PY_EXAMPLE, ...args], {
      cwd: REPO_ROOT,
      env: CLEAN_ENV,
      encoding: "utf8",
      timeout: 30_000,
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const failure = err as {
      code?: number | string;
      stdout?: string;
      stderr?: string;
      message?: string;
    };
    const missing = failure.code === "ENOENT";
    return {
      code: typeof failure.code === "number" ? failure.code : 1,
      stdout: failure.stdout ?? "",
      stderr: missing
        ? `python3 is required to run examples/rest-client.py: ${failure.message}`
        : failure.stderr || failure.message || "",
    };
  }
}

/** Read one `<name>: <value>` line the example prints. */
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

describe("examples — Python REST client against a mock node", () => {
  let dir: string;
  let child: ChildProcess;
  let baseUrl: string;
  let run: ExampleRun;

  before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "opensmm-python-example-"));
    ({ child, baseUrl } = await startNode(path.join(dir, "state.json")));
    run = await runPython([baseUrl, "--client-reference", "examples-python-test"]);
  });

  after(async () => {
    await stopNode(child);
    await rm(dir, { recursive: true, force: true });
  });

  it("reads capabilities and the catalog, prices a service and places an order", () => {
    assert.equal(run.code, 0, `examples/rest-client.py failed:\n${run.stderr}`);
    assert.match(
      run.stdout,
      /^protocol: 0\.1\.0 - \d+ commands, payment: /m,
      "the capabilities call is printed",
    );
    assert.match(run.stdout, /^catalog: MOCK/m, "the mock catalog is labelled as mock");
    assert.match(run.stdout, /synthetic/i, "the output states the services are synthetic");
    assert.match(field(run.stdout, "quote"), /^osmm_quote_/);
    assert.match(field(run.stdout, "order"), /^osmm_order_/);
    assert.match(
      run.stdout,
      /^order:\s+\S+ - REQUIRES_PAYMENT, clientReference "examples-python-test"$/m,
      "the order is unpaid and carries the clientReference",
    );
    assert.match(run.stdout, /^done: {4}Python client OK$/m);
  });

  it("prints the same orderId on replay (idempotency by clientReference)", () => {
    assert.equal(run.code, 0, `examples/rest-client.py failed:\n${run.stderr}`);
    assert.equal(field(run.stdout, "replay"), field(run.stdout, "order"));
  });

  it("reuses a quote passed with --quote and still lands on the same order", async () => {
    assert.equal(run.code, 0, `the first run must succeed:\n${run.stderr}`);
    const replay = await runPython([
      baseUrl,
      "--client-reference",
      "examples-python-test",
      "--quote",
      field(run.stdout, "quote"),
    ]);
    assert.equal(replay.code, 0, `the replay with --quote failed:\n${replay.stderr}`);
    assert.match(replay.stdout, /^quote:\s+\S+ \(reused\)$/m, "the reused quote is labelled");
    assert.equal(field(replay.stdout, "order"), field(run.stdout, "order"));
  });

  it("prints usage on --help and exits 0", async () => {
    const help = await runPython(["--help"]);
    assert.equal(help.code, 0, `--help failed:\n${help.stderr}`);
    assert.match(help.stdout, /Usage: python3 examples\/rest-client\.py \[base-url\] \[options\]/);
    assert.match(help.stdout, /--client-reference <ref>/);
  });
});

describe("examples/README.md — Python client (ZHC-701)", () => {
  it("documents how to run the Python client", () => {
    const readme = readFileSync(EXAMPLES_README, "utf8");
    assert.match(
      readme,
      /python3 examples\/rest-client\.py/,
      "examples/README.md must show how to run the Python client",
    );
    assert.match(
      readme,
      /standard library|stdlib|no pip/i,
      "examples/README.md must state that the Python client needs no pip packages",
    );
  });
});
