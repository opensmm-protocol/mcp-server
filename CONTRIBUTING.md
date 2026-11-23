# Contributing

## Language

English only, everywhere, no exceptions: code, comments, docs, commit messages, branch names, PR titles and descriptions, review comments, and every public text (website, `llms.txt`, `server.json`, registry and catalog listings, npm and ghcr metadata). CI runs `node scripts/check-english.mjs` and fails on any Cyrillic in tracked files; write source-language literals that the code must match as `\uXXXX` escapes.

## Workflow

- Branch from `develop`, open the PR against `develop`, put the card key in the title (`ZHC-N: ...`).
- Before a PR: `npm test`, `npm run typecheck` and `node scripts/check-english.mjs` must pass.
