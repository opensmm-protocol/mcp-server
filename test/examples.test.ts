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
import { readFileSync } from "node:fs";
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
const EXAMPLES_README = path.join(REPO_ROOT, "examples", "README.md");
const PACKAGE_JSON = path.join(REPO_ROOT, "package.json");
const MCP_JSON = path.join(REPO_ROOT, "mcp.json");

export function extractJsonBlocks(markdown: string): string[] {
  const matches: string[] = [];
  const re = /```json\s*\n([\s\S]*?)\n```/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(markdown)) !== null) {
    matches.push(m[1].trim());
  }
  return matches;
}

export function extractNpmScriptsFromBlock(rawJson: string, parsed: unknown): string[] {
  const found = new Set<string>();
  if (typeof parsed === "object" && parsed !== null) {
    const obj = parsed as Record<string, unknown>;
    if (obj.mcpServers && typeof obj.mcpServers === "object") {
      for (const s of Object.values(obj.mcpServers as Record<string, unknown>)) {
        if (typeof s === "object" && s !== null) {
          const sObj = s as Record<string, unknown>;
          if (sObj.command === "npm" && Array.isArray(sObj.args)) {
            const runIdx = sObj.args.indexOf("run");
            if (runIdx !== -1 && typeof sObj.args[runIdx + 1] === "string") {
              found.add(sObj.args[runIdx + 1] as string);
            }
          }
        }
      }
    }
  }
  const re = /\bnpm\s+run\s+([a-zA-Z0-9_\-:]+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(rawJson)) !== null) {
    found.add(match[1]);
  }
  return Array.from(found);
}

export function validateConfigBlock(
  rawJson: string,
  packageJson: { scripts?: Record<string, string> },
): { parsed: unknown; scripts: string[] } {
  const parsed = JSON.parse(rawJson);
  const scripts = extractNpmScriptsFromBlock(rawJson, parsed);
  const availableScripts = packageJson.scripts ?? {};
  for (const script of scripts) {
    if (!(script in availableScripts)) {
      throw new Error(`script "${script}" from configuration block is not defined in package.json`);
    }
  }
  return { parsed, scripts };
}

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

describe("examples/README.md — MCP client configuration (ZHC-680)", () => {
  const pkg = JSON.parse(readFileSync(PACKAGE_JSON, "utf8"));
  const mcpManifest = JSON.parse(readFileSync(MCP_JSON, "utf8"));

  it("examples/README.md has exactly two MCP configuration blocks and both parse as JSON", () => {
    const content = readFileSync(EXAMPLES_README, "utf8");
    const blocks = extractJsonBlocks(content);
    assert.equal(
      blocks.length,
      2,
      `examples/README.md must contain exactly 2 JSON configuration blocks, found ${blocks.length}`,
    );

    for (let i = 0; i < blocks.length; i++) {
      assert.doesNotThrow(() => {
        JSON.parse(blocks[i]);
      }, `block ${i + 1} must be valid JSON`);
    }

    const [stdioBlock, httpBlock] = blocks.map((b) => JSON.parse(b) as Record<string, any>);
    assert.ok(
      stdioBlock.mcpServers?.opensmm?.command,
      "first block must configure stdio transport via command",
    );
    assert.ok(
      httpBlock.mcpServers?.opensmm?.url,
      "second block must configure HTTP transport via url",
    );
    assert.match(
      httpBlock.mcpServers.opensmm.url,
      /\/mcp$/,
      "HTTP transport url must point to /mcp endpoint",
    );
  });

  it("all npm run scripts in configuration blocks exist in package.json", () => {
    const content = readFileSync(EXAMPLES_README, "utf8");
    const blocks = extractJsonBlocks(content);
    assert.ok(blocks.length >= 2, "README must contain configuration blocks");

    let validatedScriptCount = 0;
    for (const raw of blocks) {
      const { scripts } = validateConfigBlock(raw, pkg);
      for (const s of scripts) {
        assert.ok(s in (pkg.scripts ?? {}), `script "${s}" must exist in package.json`);
        validatedScriptCount++;
      }
    }
    assert.ok(validatedScriptCount > 0, "at least one npm run script (mcp) must be validated");
  });

  it("fails when a configuration block references a script not in package.json", () => {
    const fakeBlock = JSON.stringify({
      mcpServers: {
        opensmm: {
          command: "npm",
          args: ["run", "invented-nonexistent-script-xyz"],
        },
      },
    });

    assert.throws(
      () => validateConfigBlock(fakeBlock, pkg),
      /script "invented-nonexistent-script-xyz" from configuration block is not defined in package\.json/,
    );
  });

  it("stdio configuration aligns with mcp.json in root", () => {
    const content = readFileSync(EXAMPLES_README, "utf8");
    const blocks = extractJsonBlocks(content);
    assert.ok(blocks.length >= 1, "README must contain configuration blocks");

    const stdioBlock = JSON.parse(blocks[0]);
    assert.equal(
      stdioBlock.mcpServers?.opensmm?.command,
      "npm",
      "stdio block uses npm command",
    );
    assert.deepEqual(
      stdioBlock.mcpServers?.opensmm?.args,
      ["run", "mcp"],
      "stdio block runs mcp script",
    );

    assert.equal(
      mcpManifest.packages?.[0]?.transport?.type,
      "stdio",
      "mcp.json declares stdio transport",
    );
    assert.equal(
      mcpManifest.packages?.[0]?.identifier,
      "@opensmm/mcp-server",
      "mcp.json declares package identifier @opensmm/mcp-server",
    );
  });
});
