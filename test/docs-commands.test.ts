import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");

export interface ExtractedCommand {
  type: "npm-run" | "node-script";
  target: string;
  line: number;
  raw: string;
}

const NPM_RUN_RE = /\bnpm\s+run\s+([a-zA-Z0-9_\-:]+)/g;
const NODE_SCRIPT_RE = /\bnode(?:\s+--[a-zA-Z0-9_\-=.+]+)*\s+(?:\.\/)?scripts\/([a-zA-Z0-9_./-]+)/g;

export function extractCommands(content: string): ExtractedCommand[] {
  const commands: ExtractedCommand[] = [];
  const lines = content.split("\n");

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex];
    const lineNumber = lineIndex + 1;

    for (const match of line.matchAll(NPM_RUN_RE)) {
      commands.push({
        type: "npm-run",
        target: match[1],
        line: lineNumber,
        raw: match[0],
      });
    }

    for (const match of line.matchAll(NODE_SCRIPT_RE)) {
      const cleaned = match[1].replace(/[`'".,;:)]+$/, "");
      commands.push({
        type: "node-script",
        target: cleaned,
        line: lineNumber,
        raw: match[0],
      });
    }
  }

  return commands;
}

export function validateDocCommands(
  relativeDocPath: string,
  content: string,
  packageJson: { scripts?: Record<string, string> },
  repoRoot: string = REPO_ROOT,
): { valid: boolean; errors: string[]; commands: ExtractedCommand[] } {
  const commands = extractCommands(content);
  const errors: string[] = [];
  const scripts = packageJson.scripts ?? {};

  for (const cmd of commands) {
    if (cmd.type === "npm-run") {
      if (!(cmd.target in scripts)) {
        errors.push(
          `${relativeDocPath}:${cmd.line}: script "${cmd.target}" from "${cmd.raw}" is not defined in package.json`,
        );
      }
    } else if (cmd.type === "node-script") {
      const scriptPath = path.resolve(repoRoot, "scripts", cmd.target);
      if (!fs.existsSync(scriptPath) || !fs.statSync(scriptPath).isFile()) {
        errors.push(
          `${relativeDocPath}:${cmd.line}: script file "scripts/${cmd.target}" from "${cmd.raw}" does not exist`,
        );
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    commands,
  };
}

describe("documentation commands verification (ZHC-681)", () => {
  const DOCS = ["README.md", "docs/DEPLOY.md", "docs/NODES.md"] as const;
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"));

  for (const doc of DOCS) {
    it(`verifies all commands in ${doc} match package.json and scripts/`, () => {
      const docPath = path.join(REPO_ROOT, doc);
      assert.ok(fs.existsSync(docPath), `${doc} must exist`);
      const content = fs.readFileSync(docPath, "utf8");

      const result = validateDocCommands(doc, content, pkg, REPO_ROOT);
      assert.ok(
        result.commands.length > 0,
        `Expected ${doc} to contain commands, but none were found`,
      );
      assert.equal(
        result.valid,
        true,
        `Found discrepancies in ${doc}:\n${result.errors.join("\n")}`,
      );
    });
  }

  it("fails when an invented npm run script is referenced", () => {
    const fakeDoc = "test-doc.md";
    const fakeContent = `
# How to run
Run the following:
\`\`\`bash
npm run invented-fake-script-xyz
\`\`\`
`;
    const result = validateDocCommands(fakeDoc, fakeContent, pkg, REPO_ROOT);
    assert.equal(result.valid, false);
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0], /invented-fake-script-xyz.*not defined in package\.json/);
  });

  it("fails when an invented node scripts/ file is referenced", () => {
    const fakeDoc = "test-doc.md";
    const fakeContent = `
# How to run
Run the following:
\`\`\`bash
node scripts/nonexistent-script-xyz.mjs --flag
\`\`\`
`;
    const result = validateDocCommands(fakeDoc, fakeContent, pkg, REPO_ROOT);
    assert.equal(result.valid, false);
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0], /scripts\/nonexistent-script-xyz\.mjs.*does not exist/);
  });
});
