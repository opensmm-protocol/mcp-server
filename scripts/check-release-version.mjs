#!/usr/bin/env node
/**
 * Release-version gate for `registry-publish.yml`.
 *
 * The release tag marks a merge commit; it must never turn a release red
 * because the package version was not bumped (ZHC-928). This script reads the
 * tag from the GitHub environment and compares it with `package.json` and
 * `server.json`:
 *
 *   - all three agree      → `version=<X.Y.Z>`, `publish=true`, exit 0;
 *   - any of them differs  → `::notice title=release publish skipped::…`,
 *                            `publish=false`, exit 0 (the calling job
 *                            publishes nothing, the run stays green);
 *   - not a `v*` tag       → `::error::…`, exit 1 (a workflow misconfiguration).
 *
 * Outputs go to `$GITHUB_OUTPUT` when the variable is set, to stdout otherwise.
 */
import { appendFileSync, readFileSync } from "node:fs";

const refType = process.env.GITHUB_REF_TYPE ?? "";
const refName = process.env.GITHUB_REF_NAME ?? "";
const outputPath = process.env.GITHUB_OUTPUT;

function setOutput(name, value) {
  const line = `${name}=${value}\n`;
  if (outputPath) appendFileSync(outputPath, line);
  else process.stdout.write(line);
}

function skip(message) {
  console.error(`::notice title=release publish skipped::${message}`);
  setOutput("publish", "false");
}

if (refType !== "tag" || !refName.startsWith("v") || refName.length < 2) {
  console.error(
    `::error::Publishing runs only from a v* tag; got ref "${refName}" of type "${refType}".`,
  );
  process.exitCode = 1;
} else {
  const tagVersion = refName.slice(1);
  const pkgVersion = JSON.parse(readFileSync("package.json", "utf8")).version;
  const manifestVersion = JSON.parse(readFileSync("server.json", "utf8")).version;

  setOutput("version", pkgVersion);

  if (tagVersion !== pkgVersion) {
    skip(
      `Tag ${refName} does not match package.json version ${pkgVersion}; ` +
        "skipping publication instead of failing the run.",
    );
  } else if (manifestVersion !== pkgVersion) {
    skip(
      `server.json version ${manifestVersion} does not match package.json version ${pkgVersion}; ` +
        "skipping publication instead of failing the run.",
    );
  } else {
    setOutput("publish", "true");
  }
}
