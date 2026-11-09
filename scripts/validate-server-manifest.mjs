#!/usr/bin/env node
/**
 * Offline validator for the MCP Registry manifest (`server.json`).
 *
 * The vendored schema is a byte-for-byte copy of
 * https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json,
 * so validation never touches the network. On top of the schema, this script
 * enforces the project rules that the registry schema leaves open:
 *   - every `packages[]` entry has a non-empty `identifier`;
 *   - `remotes` is absent or empty (the entry is package-only until a public
 *     remote endpoint exists);
 *   - `title` and `description` stay within the registry limit of 100 chars.
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

const scriptDir = path.dirname(fileURLToPath(import.meta.url));

export const DEFAULT_MANIFEST_PATH = path.resolve(scriptDir, "..", "server.json");
export const PACKAGE_JSON_PATH = path.resolve(scriptDir, "..", "package.json");
export const SCHEMA_PATH = path.join(scriptDir, "schemas", "server-2025-12-11.schema.json");
export const MAX_TEXT_LENGTH = 100;

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
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
