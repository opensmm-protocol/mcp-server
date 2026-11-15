import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

const repoRoot = path.resolve(import.meta.dirname, "..");
const composePath = path.join(repoRoot, "docker-compose.yml");
const dockerfilePath = path.join(repoRoot, "Dockerfile");

type Lines = string[];

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

/** Compose lines without blank and comment-only lines, indentation preserved. */
function composeLines(): Lines {
  return fs
    .readFileSync(composePath, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "" && !line.trimStart().startsWith("#"));
}

/**
 * Body of `key:` declared at the smallest indentation of `lines`, up to the
 * next key at the same or a lower indentation. Enough YAML for a repo file we
 * keep flat, without a parser dependency.
 */
function child(lines: Lines, key: string): Lines | undefined {
  if (lines.length === 0) return undefined;
  const indent = Math.min(...lines.map(indentOf));
  const prefix = `${" ".repeat(indent)}${key}:`;
  const start = lines.findIndex((line) => line === prefix || line.startsWith(`${prefix} `));
  if (start === -1) return undefined;
  const body: Lines = [];
  for (const line of lines.slice(start + 1)) {
    if (indentOf(line) <= indent) break;
    body.push(line);
  }
  return body;
}

function service(name: string): Lines {
  const services = child(composeLines(), "services");
  assert.ok(services, "docker-compose.yml has no services section");
  const block = child(services, name);
  assert.ok(block, `docker-compose.yml has no services.${name} section`);
  return block;
}

/** `KEY: value` pairs of a mapping block. */
function entries(lines: Lines): Map<string, string> {
  const indent = " ".repeat(Math.min(...lines.map(indentOf)));
  const map = new Map<string, string>();
  for (const line of lines) {
    if (!line.startsWith(indent)) continue;
    const match = /^([A-Za-z0-9_.-]+):[ \t]*(.*)$/.exec(line.slice(indent.length));
    if (match) map.set(match[1]!, match[2]!.trim().replace(/^["']|["']$/g, ""));
  }
  return map;
}

/** Quoted and bare words of a scalar or flow sequence, quotes removed. */
function words(lines: Lines): string[] {
  const text = lines.map((line) => line.trim()).join(" ");
  return [...text.matchAll(/"((?:[^"\\]|\\.)*)"|'((?:[^']|'')*)'|(\S+)/g)]
    .map((match) => (match[1] ?? match[2] ?? match[3] ?? "").replace(/''/g, "'"))
    .filter((word) => word !== "[" && word !== "]" && word !== ",");
}

function durationMs(value: string): number {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)$/.exec(value);
  assert.ok(match, `unsupported duration "${value}"`);
  const factor: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 };
  return Number(match[1]) * factor[match[2]!]!;
}

function installsBinary(dockerfile: string, binary: string): boolean {
  return new RegExp(`apk add[^\\n]*\\b${binary}\\b|apt-get install[^\\n]*\\b${binary}\\b`).test(dockerfile);
}

describe("docker-compose gateway service", () => {
  it("keeps state on the mounted volume via OPENSMM_STATE_FILE", () => {
    const gateway = service("gateway");
    const environment = child(gateway, "environment");
    assert.ok(environment, "services.gateway has no environment block");
    const stateFile = entries(environment).get("OPENSMM_STATE_FILE");
    assert.equal(
      stateFile,
      "/data/opensmm-state.json",
      "services.gateway.environment must set OPENSMM_STATE_FILE=/data/opensmm-state.json",
    );

    const volumes = child(gateway, "volumes") ?? [];
    const targets = volumes
      .map((line) => /^[ \t]*-[ \t]*(.+)$/.exec(line)?.[1]?.trim().replace(/^["']|["']$/g, "") ?? "")
      .map((mount) => mount.split(":").at(-1) ?? "")
      .filter((target) => target !== "");
    assert.ok(
      targets.includes("/data"),
      `services.gateway must mount a volume at /data, got ${JSON.stringify(targets)}`,
    );
    assert.ok(
      stateFile.startsWith("/data/"),
      `state file ${stateFile} must live inside the mounted /data volume`,
    );
  });

  it("declares a healthcheck on the gateway service", () => {
    const healthcheck = child(service("gateway"), "healthcheck");
    assert.ok(healthcheck, "services.gateway has no healthcheck section");
  });

  it("probes GET /v0/services from the healthcheck", () => {
    const healthcheck = child(service("gateway"), "healthcheck") ?? [];
    const command = words(child(healthcheck, "test") ?? []);
    assert.ok(command.length > 0, "healthcheck has no test command");

    const modes = new Set(["CMD", "CMD-SHELL", "NONE"]);
    const mode = modes.has(command[0]!) ? command[0]! : "CMD-SHELL";
    const rest = modes.has(command[0]!) ? command.slice(1) : command;
    assert.notEqual(mode, "NONE", "healthcheck must run a command");
    assert.ok(rest.length > 0, `healthcheck ${mode} has no command`);

    assert.ok(
      rest.join(" ").includes("/v0/services"),
      `healthcheck must poll GET /v0/services, got ${JSON.stringify(rest)}`,
    );
  });

  it("runs a checker the runtime image ships", () => {
    const healthcheck = child(service("gateway"), "healthcheck") ?? [];
    const command = words(child(healthcheck, "test") ?? []);
    const modes = new Set(["CMD", "CMD-SHELL", "NONE"]);
    const rest = modes.has(command[0]!) ? command.slice(1) : command;
    const executable = rest[0];
    assert.ok(executable, "healthcheck has no executable");

    // The runtime stage is a node image: node is present, curl/wget are not
    // unless the Dockerfile installs them explicitly.
    if (executable !== "node") {
      const dockerfile = fs.readFileSync(dockerfilePath, "utf8");
      assert.ok(
        installsBinary(dockerfile, executable),
        `healthcheck runs "${executable}", which the runtime image does not install`,
      );
    }
  });

  it("keeps the inline node checker syntactically valid", () => {
    const healthcheck = child(service("gateway"), "healthcheck") ?? [];
    const command = words(child(healthcheck, "test") ?? []);
    const scriptAt = command.indexOf("-e");
    if (command[0] !== "CMD" || command[1] !== "node" || scriptAt === -1) return;
    const script = command[scriptAt + 1];
    assert.ok(script, "node -e in the healthcheck has no script");
    assert.doesNotThrow(() => new Function(script), `healthcheck script does not compile: ${script}`);
  });

  it("bounds the healthcheck timing", () => {
    const healthcheck = child(service("gateway"), "healthcheck") ?? [];
    const settings = entries(healthcheck);
    const interval = durationMs(settings.get("interval") ?? "");
    const timeout = durationMs(settings.get("timeout") ?? "");
    const startPeriod = durationMs(settings.get("start_period") ?? "");
    const retries = Number(settings.get("retries"));

    assert.ok(interval > 0, "healthcheck needs a positive interval");
    assert.ok(timeout > 0 && timeout < interval, "healthcheck timeout must be positive and below the interval");
    assert.ok(Number.isInteger(retries) && retries > 0, "healthcheck needs a positive retry count");
    assert.ok(
      startPeriod >= 5000,
      "healthcheck start_period must cover gateway boot (>= 5s), otherwise the node is marked unhealthy on start",
    );
  });
});
