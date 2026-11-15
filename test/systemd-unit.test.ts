/**
 * examples/systemd/ guard rail (ZHC-698): operators on a Linux VPS without
 * Docker install this unit as their node. A missing directive does not fail
 * loudly — the service starts once and stays down after the first crash — so
 * the template is asserted here, together with the install steps it documents.
 *
 * The unit is parsed, not executed: the test runs on every developer host and
 * in CI, where systemd is not available.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const UNIT_PATH = path.join(REPO_ROOT, "examples", "systemd", "opensmm.service");
const README_PATH = path.join(REPO_ROOT, "examples", "systemd", "README.md");
const DEPLOY_PATH = path.join(REPO_ROOT, "docs", "DEPLOY.md");
const ENV_FILE = "/etc/opensmm/opensmm.env";
const STATE_DIR = "/var/lib/opensmm";

export interface UnitFile {
  sections: Record<string, Record<string, string>>;
  /** ExecStart argv: the binary and its arguments, quotes removed. */
  execStart: string[];
}

/** Parse the subset of the systemd unit syntax this template uses. */
export function parseUnit(content: string): UnitFile {
  const sections: Record<string, Record<string, string>> = {};
  let current = "";

  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#") || line.startsWith(";")) continue;

    const section = /^\[([^\]]+)\]$/.exec(line);
    if (section) {
      current = section[1]!;
      sections[current] ??= {};
      continue;
    }

    const directive = /^([A-Za-z][A-Za-z0-9]*)=(.*)$/.exec(line);
    if (!directive) {
      throw new Error(`invalid unit line: "${rawLine}"`);
    }
    if (!current) {
      throw new Error(`directive outside a section: "${rawLine}"`);
    }
    // systemd allows a repeated directive; keep every occurrence for the checks.
    const key = directive[1]!;
    const value = directive[2]!.trim();
    const existing = sections[current]![key];
    sections[current]![key] = existing === undefined ? value : `${existing}\n${value}`;
  }

  const execStart = (sections.Service?.ExecStart ?? "")
    .match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)
    ?.map((arg) => arg.replace(/^["']|["']$/g, "")) ?? [];

  return { sections, execStart };
}

/** The directives a node service needs to survive a reboot, a crash and an OOM kill. */
export function checkUnit(unit: UnitFile): string[] {
  const problems: string[] = [];
  const service = unit.sections.Service ?? {};
  const install = unit.sections.Install ?? {};

  if (!unit.sections.Unit?.Description) problems.push("[Unit] Description is missing");

  if (service.Type !== "simple") problems.push("Type=simple is missing");
  if (!service.User || service.User === "root") {
    problems.push("User= must name an unprivileged user");
  }
  if (!service.Group) problems.push("Group= is missing");
  if (!service.WorkingDirectory) problems.push("WorkingDirectory= is missing");
  if (service.EnvironmentFile !== ENV_FILE) {
    problems.push(`EnvironmentFile=${ENV_FILE} is missing`);
  }
  if (service.Restart !== "always") problems.push("Restart=always is missing");
  if (!service.RestartSec) problems.push("RestartSec= is missing");
  if (!service.LimitNOFILE) problems.push("LimitNOFILE= is missing");
  if (!service.MemoryMax) problems.push("MemoryMax= is missing");
  if (service.NoNewPrivileges !== "true") problems.push("NoNewPrivileges=true is missing");
  if (service.UMask !== "0077") problems.push("UMask=0077 is missing (state file 0600)");
  if (service.StateDirectory !== "opensmm" && service.ReadWritePaths !== STATE_DIR) {
    problems.push(`StateDirectory=opensmm (or ReadWritePaths=${STATE_DIR}) is missing`);
  }
  if (install.WantedBy !== "multi-user.target") {
    problems.push("[Install] WantedBy=multi-user.target is missing");
  }

  const [binary, ...args] = unit.execStart;
  if (!binary || !path.isAbsolute(binary)) {
    problems.push("ExecStart= must start with an absolute path to the node binary");
  } else if (path.basename(binary) !== "node") {
    problems.push(`ExecStart= must run node, got "${binary}"`);
  }
  const script = args.find((arg) => arg.endsWith(".mjs"));
  if (!script) {
    problems.push("ExecStart= must run the opensmm entry point (bin/opensmm.mjs)");
  } else if (!fs.existsSync(path.join(REPO_ROOT, script))) {
    problems.push(`ExecStart= entry point "${script}" does not exist in the repository`);
  }
  if (!args.includes("gateway")) {
    problems.push('ExecStart= must run the "gateway" command (one node: REST /v0 + MCP /mcp)');
  }

  return problems;
}

describe("examples/systemd/opensmm.service (ZHC-698)", () => {
  const content = fs.readFileSync(UNIT_PATH, "utf8");
  const unit = parseUnit(content);

  it("parses as a systemd unit with Unit, Service and Install sections", () => {
    assert.deepEqual(Object.keys(unit.sections).sort(), ["Install", "Service", "Unit"]);
  });

  it("contains every directive a node service needs", () => {
    assert.deepEqual(checkUnit(unit), []);
  });

  it("starts bin/opensmm.mjs gateway from the checkout as an unprivileged user", () => {
    const service = unit.sections.Service!;
    const [, ...args] = unit.execStart;

    assert.deepEqual(args.slice(0, 2), ["bin/opensmm.mjs", "gateway"]);
    assert.equal(service.User, "opensmm");
    assert.equal(service.WorkingDirectory, "/opt/opensmm/mcp-server");
  });

  it("keeps state in /var/lib/opensmm and reads config from the environment file", () => {
    const service = unit.sections.Service!;

    assert.equal(service.StateDirectory, "opensmm");
    assert.equal(service.EnvironmentFile, ENV_FILE);
    assert.equal(service.Environment?.includes(`OPENSMM_STATE_FILE=${STATE_DIR}/opensmm-state.json`), true);
  });

  it("catches a unit that lost Restart=always or the environment file", () => {
    const broken = content
      .replace(/^Restart=always$/m, "")
      .replace(/^EnvironmentFile=.*$/m, "");
    const problems = checkUnit(parseUnit(broken));

    assert.ok(problems.some((p) => p.includes("Restart=always")));
    assert.ok(problems.some((p) => p.includes("EnvironmentFile")));
  });

  it("catches an ExecStart= that points at a script missing from the repository", () => {
    const broken = content.replace(
      /^ExecStart=.*$/m,
      "ExecStart=/usr/bin/node bin/opensmm-node.mjs gateway",
    );
    const problems = checkUnit(parseUnit(broken));

    assert.ok(problems.some((p) => p.includes("does not exist in the repository")));
  });
});

describe("examples/systemd/README.md install steps (ZHC-698)", () => {
  const readme = fs.readFileSync(README_PATH, "utf8");

  const steps: Array<[string, RegExp]> = [
    ["service user", /useradd --system[^\n]*opensmm/],
    ["checkout", /git clone https:\/\/github\.com\/opensmm-protocol\/mcp-server\.git/],
    ["dependencies", /npm ci/],
    ["environment file", new RegExp(ENV_FILE.replace(/\./g, "\\."))],
    ["environment file mode 0600", /install -m 0600[^\n]*opensmm\.env|chmod 0600[^\n]*opensmm\.env/],
    ["state directory", new RegExp(STATE_DIR.replace(/\//g, "\\/"))],
    ["state file mode 0600", /chmod 0600[^\n]*opensmm-state\.json/],
    ["unit copy", /cp \S*opensmm\.service \/etc\/systemd\/system\//],
    ["daemon-reload", /systemctl daemon-reload/],
    ["enable and start", /systemctl enable --now opensmm/],
    ["status", /systemctl status opensmm/],
    ["logs", /journalctl -u opensmm/],
  ];

  for (const [name, pattern] of steps) {
    it(`documents the ${name} step`, () => {
      assert.match(readme, pattern);
    });
  }

  it("points at the unit file and at docs/DEPLOY.md", () => {
    assert.match(readme, /opensmm\.service/);
    assert.match(readme, /docs\/DEPLOY\.md/);
    assert.match(readme, /StateDirectory=opensmm/);
  });
});

describe("docs/DEPLOY.md systemd section (ZHC-698)", () => {
  const deploy = fs.readFileSync(DEPLOY_PATH, "utf8");

  it("has a systemd section for Linux without Docker", () => {
    assert.match(deploy, /^## systemd service \(Linux without Docker\)$/m);
  });

  it("links the unit and the install README", () => {
    assert.match(deploy, /examples\/systemd\/README\.md/);
    assert.match(deploy, /examples\/systemd\/opensmm\.service/);
  });
});
