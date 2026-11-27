# MCP Registry entry

OpenSMM is listed in the official MCP Registry.

| Field | Value |
| --- | --- |
| Name | `io.github.opensmm-protocol/mcp-server` |
| Package type | `mcpb` (MCP Bundle), a GitHub Release asset |
| Transport | stdio |
| Manifest | [`server.json`](../server.json), schema `2025-12-11` |

The bundle is the MCP server on the **mock catalog**: no real services, orders
or payments. It needs Node.js ≥ 22.18 and no keys. The entry has no npm package,
no container image and no `remotes`. To run a node (REST and MCP over HTTP), see
[Run a node from source in 5 minutes](../README.md#run-a-node-from-source-in-5-minutes).

## Download and check the SHA-256

The registry stores the SHA-256 of the bundle in `packages[0].fileSha256`. These
commands take the URL and the hash of the latest version from the registry API,
download the file anonymously and compare (they need `curl`, `jq` and
`sha256sum`):

```bash
entry="$(curl -fsS https://registry.modelcontextprotocol.io/v0/servers/io.github.opensmm-protocol%2Fmcp-server/versions/latest)"
url="$(jq -r '.server.packages[0].identifier' <<<"$entry")"
sha="$(jq -r '.server.packages[0].fileSha256' <<<"$entry")"
curl -fLO "$url"
echo "$sha  $(basename "$url")" | sha256sum -c -   # <file name>: OK
```

Do not use a file that fails the check. Version 0.1.8 is at
<https://github.com/opensmm-protocol/mcp-server/releases/download/v0.1.8/opensmm-mcp-server-0.1.8.mcpb>.

To install the checked file, see
[Install the MCP bundle](../README.md#install-the-mcp-bundle-mcpb).

## How it is published

The `registry` job of
[`registry-publish.yml`](../.github/workflows/registry-publish.yml) runs on a
`v*` tag (or a manual run from such a tag). It does not depend on npm
publication.

1. Version gate: the tag, `package.json` and `server.json` must carry the same
   version. Otherwise the job publishes nothing, and the run stays green with a
   notice.
2. `npm run build:mcpb` builds `opensmm-mcp-server-<version>.mcpb`.
3. The job creates the GitHub Release if it does not exist and uploads the
   bundle. An asset that is already attached is reused, never replaced.
4. It downloads the asset without a token, smoke-tests that file (`initialize`
   and `tools/list` over stdio) and writes a publish copy of `server.json` with
   the file's `fileSha256`. The hash is not committed to the repository.
5. If the registry does not list this version with this identifier and hash yet,
   the job installs a pinned, cosign-verified `mcp-publisher`, logs in with
   GitHub OIDC and publishes the copy. If it is already listed, these steps are
   skipped.

A published version and its asset are never replaced: a fix is a new version
(see [Release version and tag](./DEPLOY.md#release-version-and-tag)).

## How publication is verified

The last step of the job queries the registry API with retries and fails unless
this version is listed with this identifier and `fileSha256`
(`scripts/check-registry-entry.mjs`). A green run alone is not proof, because a
skipped publication is green too. Check the API:

```bash
curl -s "https://registry.modelcontextprotocol.io/v0/servers?search=opensmm"
```
