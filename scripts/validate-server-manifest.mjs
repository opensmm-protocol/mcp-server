#!/usr/bin/env node
/**
 * Offline validator for the MCP Registry manifest (`server.json`).
 *
 * The vendored schema is a byte-for-byte copy of
 * https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json,
 * so validation never touches the network. On top of the schema, this script
 * enforces the project rules that the registry schema leaves open:
 *   - every `packages[]` entry has a non-empty `identifier`;
 *   - an `mcpb` package is an https GitHub release asset URL containing "mcp",
 *     without `registryBaseUrl`;
 *   - `remotes` is absent or empty (the entry is package-only until a public
 *     remote endpoint exists);
 *   - `title` and `description` stay within the registry limit of 100 chars.
 *
 * The repository `server.json` must also be exactly one stdio `mcpb` package
 * whose URL matches the `package.json` version, with no committed `fileSha256`.
 *
 * Usage:
 *   node scripts/validate-server-manifest.mjs [path-to-server.json]
 *
 * Exits 0 on a valid manifest and 1 with a readable error list otherwise.
 * The function is exported so tests can validate fixtures in-process.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import { bundleName } from "./build-mcpb.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));

export const DEFAULT_MANIFEST_PATH = path.resolve(scriptDir, "..", "server.json");
export const PACKAGE_JSON_PATH = path.resolve(scriptDir, "..", "package.json");
export const SCHEMA_PATH = path.join(scriptDir, "schemas", "server-2025-12-11.schema.json");
export const MAX_TEXT_LENGTH = 100;
const RELEASES_URL = "https://github.com/opensmm-protocol/mcp-server/releases/download";
const GITHUB_ASSET_PATH = /^\/[^/]+\/[^/]+\/releases\/download\/[^/]+\/[^/]+$/;

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function mcpbErrors(pkg, index) {
  const errors = [];
  const url = URL.parse(pkg.identifier);
  if (
    url?.protocol !== "https:" ||
    url.host !== "github.com" ||
    !GITHUB_ASSET_PATH.test(url.pathname) ||
    !pkg.identifier.toLowerCase().includes("mcp")
  ) {
    errors.push(`/packages/${index}/identifier must be an https GitHub release asset URL containing "mcp"`);
  }
  if (pkg.registryBaseUrl !== undefined) {
    errors.push(`/packages/${index}/registryBaseUrl must be absent for an mcpb package`);
  }
  return errors;
}

/**
 * Rules for the tracked `server.json` only: fixtures and the publish copy
 * (which carries `fileSha256`) are not held to them.
 *
 * @returns {string[]} errors
 */
export function repositoryManifestErrors(manifest, version) {
  const errors = [];
  if (manifest?.version !== version) {
    errors.push(`/version must equal the package.json version ${version}`);
  }
  if (manifest?.packages?.length !== 1) {
    errors.push("/packages must hold exactly one package");
  }
  const pkg = manifest?.packages?.[0];
  if (pkg?.registryType !== "mcpb") errors.push('/packages/0/registryType must be "mcpb"');
  if (pkg?.transport?.type !== "stdio") errors.push('/packages/0/transport/type must be "stdio"');
  const expected = `${RELEASES_URL}/v${version}/${bundleName(version)}`;
  if (pkg?.identifier !== expected) errors.push(`/packages/0/identifier must be ${expected}`);
  for (const field of ["version", "runtimeHint", "fileSha256"]) {
    if (pkg?.[field] !== undefined) errors.push(`/packages/0/${field} must be absent from the tracked manifest`);
  }
  return errors;
}

/**
 * Validate a registry manifest.
 *
 * @param {string} [manifestPath] absolute or relative path to the manifest
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateManifest(manifestPath = DEFAULT_MANIFEST_PATH) {
  const resolvedPath = path.resolve(manifestPath);

  let manifest;
  try {
    manifest = readJson(resolvedPath);
  } catch (error) {
    return {
      valid: false,
      errors: [`cannot read or parse ${resolvedPath}: ${error.message}`],
    };
  }

  const errors = [];

  let validate;
  try {
    // The registry schema is generated upstream and uses annotation keywords
    // such as `example` that Ajv's strict mode does not know.
    const ajv = new Ajv({ allErrors: true, strictSchema: false });
    addFormats(ajv);
    validate = ajv.compile(readJson(SCHEMA_PATH));
  } catch (error) {
    return {
      valid: false,
      errors: [`cannot load schema ${SCHEMA_PATH}: ${error.message}`],
    };
  }

  if (!validate(manifest)) {
    for (const error of validate.errors ?? []) {
      errors.push(`${error.instancePath || "/"} ${error.message ?? "is invalid"}`);
    }
  }

  // Project rules not expressed by the registry schema.
  const packages = manifest?.packages;
  if (!Array.isArray(packages) || packages.length === 0) {
    errors.push("/packages must list at least one publishable package");
  } else {
    packages.forEach((pkg, index) => {
      if (typeof pkg?.identifier !== "string" || pkg.identifier.trim() === "") {
        errors.push(`/packages/${index}/identifier must be a non-empty string`);
      } else if (pkg.registryType === "mcpb") {
        errors.push(...mcpbErrors(pkg, index));
      }
    });
  }

  if (manifest?.remotes !== undefined) {
    if (!Array.isArray(manifest.remotes)) {
      errors.push("/remotes must be an array when present");
    } else if (manifest.remotes.length > 0) {
      errors.push(
        "/remotes must be absent or empty: the registry entry is package-only until a public remote endpoint exists",
      );
    }
  }

  for (const field of ["title", "description"]) {
    const value = manifest?.[field];
    if (typeof value === "string" && value.length > MAX_TEXT_LENGTH) {
      errors.push(`/${field} must be at most ${MAX_TEXT_LENGTH} characters (got ${value.length})`);
    }
  }

  // The MCP Registry proves npm package ownership by matching package.json
  // `mcpName` against server.json `name`. Without this check CI stays green
  // and `mcp-publisher publish` fails only on the release tag.
  try {
    const pkg = readJson(PACKAGE_JSON_PATH);
    if (typeof pkg.mcpName !== "string" || pkg.mcpName.trim() === "") {
      errors.push(
        `/package.json must set "mcpName": "${manifest?.name}" so the registry can verify npm package ownership`,
      );
    } else if (pkg.mcpName !== manifest?.name) {
      errors.push(`/package.json mcpName ("${pkg.mcpName}") must equal the manifest name ("${manifest?.name}")`);
    }
    if (resolvedPath === DEFAULT_MANIFEST_PATH) {
      errors.push(...repositoryManifestErrors(manifest, pkg.version));
    }
  } catch (error) {
    errors.push(`cannot read or parse ${PACKAGE_JSON_PATH}: ${error.message}`);
  }

  return { valid: errors.length === 0, errors };
}

function main(argv) {
  const manifestPath = path.resolve(argv[2] ?? DEFAULT_MANIFEST_PATH);
  const { valid, errors } = validateManifest(manifestPath);

  if (!valid) {
    console.error(`invalid MCP Registry manifest: ${manifestPath}`);
    for (const error of errors) {
      console.error(`  - ${error}`);
    }
    return 1;
  }

  console.log(`valid MCP Registry manifest (schema 2025-12-11): ${manifestPath}`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv);
}
