# MCP Registry entry

How the OpenSMM MCP server is listed in the official MCP Registry, how to
update the entry, how to verify it, and how to measure discovery.

## The entry

| Field | Value |
|---|---|
| Name | `io.github.opensmm-protocol/mcp-server` |
| Package | `@opensmm/mcp-server` (npm, `stdio` transport) |
| Registry search | `https://registry.modelcontextprotocol.io/v0/servers?search=opensmm` |
| Schema | `https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json` |

The entry is **package-only**. `remotes` is absent on purpose: OpenSMM has no
public hosted MCP endpoint on `opensmm.dev` yet, so an agent installs the npm
package and runs it over `stdio`. Do not add `remotes` until such an endpoint
exists and is deployed.

## Single source of truth

`server.json` in the repo root is the only file to edit. Two byte-identical
mirrors are generated from it:

- `mcp.json` (repo root)
- `website/mcp.json`

```bash
npm run manifests:sync    # rewrite the mirrors from server.json
npm run manifests:check   # exit 1 when a mirror drifts
```

`manifests:check` runs in `prepublishOnly`, and the mirror files must stay
byte-for-byte equal to `server.json`.

## Fields under schema 2025-12-11

| Field | Rule |
|---|---|
| `name` | Registry identity, `io.github.opensmm-protocol/mcp-server`. Stable — changing it creates a new entry. |
| `title` | Human title, ≤ 100 characters. |
| `description` | ≤ 100 characters. Written for search: `smm`, `social media growth`, `instagram growth`, `telegram views`, `follower purchase`, `MCP server`. |
| `version` | Must equal `package.json` `version` and `packages[].version`. |
| `websiteUrl` | Project site. `homepage` is **not** a field of this schema — use `websiteUrl`. |
| `repository` | `{ "url": ..., "source": "github" }`. |
| `packages[]` | The schema requires `registryType`, `identifier` and `transport`; `version` is optional there but our publish workflow requires it to equal `package.json` `version`. `runtimeHint: "npx"` tells clients how to run it. |
| `remotes` | Omit. The schema allows it, but we have no public remote endpoint. |
| `license` | **Not** a field of `ServerDetail` — it lives only in `package.json`. |

## Update the entry

Publishing is driven by a git tag; version numbers are bumped by hand.

1. Bump the version in **both** files:
   - `package.json` → `"version"`
   - `server.json` → `"version"` and `packages[].version`
2. Regenerate the mirrors and check them:

   ```bash
   npm run manifests:sync
   npm run manifests:check
   ```

3. Run the gates locally:

   ```bash
   npm test
   npm run typecheck
   ```

4. Open a PR to `develop` and merge it after review and green CI.
5. Tag the merge commit and push the tag:

   ```bash
   git tag v0.1.1
   git push origin v0.1.1
   ```

6. `.github/workflows/registry-publish.yml` runs only on `v*` tags. Its first
   step rejects any ref that is not a `v*` tag matching the `package.json`
   version, so a manual `workflow_dispatch` run from a branch fails by design —
   to re-run a publish, re-run that tag's workflow run. The workflow publishes
   in order: **npm first** (`npm publish --access public`), **registry second**
   (`mcp-publisher`, GitHub OIDC login), because the registry entry points at a
   package that must already exist. Without the `NPM_TOKEN` secret the npm job
   skips with a notice instead of failing, and the registry job is gated on that
   job's `published` output — so without `NPM_TOKEN` nothing is published at
   all: neither the package nor the entry.
7. Verify the entry (next section).

When the tag workflow cannot be used, the same two steps can be run by hand
with the official `mcp-publisher` CLI (`login github` is the local device
flow; `login github-oidc` works only inside GitHub Actions):

```bash
npm publish --access public
curl -sSfL "https://github.com/modelcontextprotocol/registry/releases/latest/download/mcp-publisher_$(uname -s | tr '[:upper:]' '[:lower:]')_$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/').tar.gz" | tar xz mcp-publisher
./mcp-publisher login github
./mcp-publisher publish
```

## Verify the entry

Registry, by our name:

```bash
curl -s "https://registry.modelcontextprotocol.io/v0/servers?search=opensmm"
```

Registry, by the search term agents actually type:

```bash
curl -s "https://registry.modelcontextprotocol.io/v0/servers?search=smm"
```

The second query returns every SMM-related server, so grep the output for
`io.github.opensmm-protocol/mcp-server`:

```bash
curl -s "https://registry.modelcontextprotocol.io/v0/servers?search=smm" \
  | jq -r '.servers[].server.name' | grep opensmm
```

Before the first successful publish both queries come back without our name
(`{"servers":[],"metadata":{"count":0}}` for `opensmm`).

## Weekly metric

npm downloads for the published package, last 30 days:

```bash
curl -s https://api.npmjs.org/downloads/point/last-month/@opensmm/mcp-server
```

Target: **≥ 100 downloads in the first 30 days after the first publish**.
Take the reading once a week and record it here:

| Week | Date | Downloads (last 30 days) |
|---|---|---|
| 1 | | |
| 2 | | |
| 3 | | |
| 4 | | |

Before the package is published the endpoint answers
`{"error":"package @opensmm/mcp-server not found"}` — that is not a failure of
the command.

## Do not

- Do not invent `remotes` or a remote URL.
- Do not list tools the code does not expose — the tool list comes from
  `src/adapters/inbound/mcp/server.ts`.
- Do not repeat the README discovery section here: `README.md` carries the
  pointers, this file carries the procedure.
