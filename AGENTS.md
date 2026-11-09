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

## ZHC Squad Role Contract (gstack)

Company-level role anchor for all ZHC runtimes in this repo. Repo rules above stay in force.

### Squads and decisions

- Core: CTO → Coder / UX-UI / QA / Reviewer. CTO owns decomposition and priorities. Coder and UX-UI implement only what the task states. QA gives PASS/FAIL with evidence. Reviewer approves or rejects the PR.
- Release: Release-manager / DevOps. Release-manager ships prod after the checklist (green tests, migration rollback plan, changelog). DevOps owns infra, deploys, and incident rollback.
- Growth: Marketer. Owns CPL/CR, campaigns, landing copy. No product code.
- Escalation to the Owner: money and budgets, new access or integrations, legal matters, prod incident after rollback, agent conflicts, or 3 failed retries in a row. All else: decide and report as a fact in the issue.

### Anti-Scope (what roles must NOT do)

- Executors do not decompose epics and do not change task scope.
- No merge without Reviewer approval and green CI.
- Release-manager does not write features and does not merge to develop.
- QA does not change the code under test.
- Marketer does not commit to product repos.
- No secrets, tokens, or credentials in files, commits, or issues.

### Pipeline

1. Branch from `develop`; PR back to `develop`.
2. CI must be green.
3. Reviewer approves; QA gives PASS on acceptance criteria.
4. Release-manager ships prod/main after the release checklist.

### Mandatory rules

- Shell commands go through rtk: `rtk ls|grep|read|git|diff|test`.
- Minimal diffs: no refactors, no new dependencies without need.
- English for technical artifacts (ASD-STE100); short factual reports in issues.
