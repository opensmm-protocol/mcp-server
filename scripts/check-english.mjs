#!/usr/bin/env node
/**
 * English-only gate: fails when any tracked text file contains Cyrillic.
 * Usage: node scripts/check-english.mjs   (exit 0 = clean, exit 1 = violations)
 * No exceptions: source-language literals must be written as \uXXXX escapes.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const CYRILLIC = /[\u0400-\u04ff]/;

const files = execFileSync("git", ["ls-files", "-z"], {
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024,
})
  .split("\0")
  .filter(Boolean);

const violations = [];
for (const file of files) {
  let text;
  try {
    const buf = readFileSync(file);
    if (buf.includes(0)) continue; // binary
    text = buf.toString("utf8");
  } catch {
    continue; // deleted or unreadable
  }
  text.split("\n").forEach((line, i) => {
    if (CYRILLIC.test(line)) violations.push(`${file}:${i + 1}: ${line.trim().slice(0, 120)}`);
  });
}

if (violations.length > 0) {
  console.error(`check-english: ${violations.length} line(s) with Cyrillic (English only):`);
  for (const v of violations) console.error(`  ${v}`);
  process.exit(1);
}
console.log(`check-english: OK (${files.length} tracked files, no Cyrillic)`);
