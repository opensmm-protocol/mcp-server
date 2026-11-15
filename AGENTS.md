# OpenSMM Protocol (mcp-server) — rules for agents in this repo

## Repo anchor

- Product entry point: `README.md`; state and roadmap: `PROJECT.md`; working agreements: `CONTEXT.md`.
- `spec/v0/` is the protocol contract: JSON Schemas, statuses, error codes, idempotency rules. Spec changes require matching updates in `test/spec-examples.test.ts`.
- `src/core/` is transport-agnostic: no MCP/HTTP imports allowed there.
- Gate before a PR: `npm test` and `npm run typecheck` green (no linter configured).
- Tests and invariants: see `CONTEXT.md` — keep them true.

# RTK

Prefix every shell command with `rtk`: `rtk git status`, `rtk npm test`,
`rtk ls src/`. Keep the prefix inside chains. Commands RTK has no filter
for run as-is, so the prefix is always safe. Re-run as `rtk bypass <cmd>`
only when the filtered result is unusable. RTK condenses command output
to save context tokens; behavior and exit code are unchanged.

## ZHC holding rules

Roles, pipeline (branch from `develop` → PR to `develop` → review → QA → release), escalation and flow limits are defined once: in the ZHC holding rules (workspace context) and the product passport (project description), which every agent run receives. They are not repeated here; this file holds only what is specific to this repository.

- No secrets, tokens, or credentials in files, commits, or issues.
