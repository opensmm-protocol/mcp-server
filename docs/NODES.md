# Node census

How we count external OpenSMM nodes for the 30-day metric (ZHC-324).

## Definition of a node

A public URL is a node when both checks answer 200:

- `GET <url>/v0/services` — the node serves a catalog;
- `POST <url>/mcp` with `initialize` (JSON-RPC) — the node speaks MCP.

`GET <url>/v0/providers` is informational: it never decides up or down.

## Run the census

```sh
node scripts/node-census.mjs --url http://127.0.0.1:8080 --url https://mcp.opensmm.dev
node scripts/node-census.mjs --file nodes.txt   # one URL per line, "#" starts a comment
```

Limit is 20 URLs per run. Output is JSON on stdout; a summary goes to stderr.
An unreachable node is data, not a failure: `status: "down"`, exit 0. Exit 1 = broken arguments.

## Weekly report line

Copy one line per week into the ZHC-324 thread, with the JSON below it:

```
2026-11-09 — 1 node up of 3 checked: http://127.0.0.1:8080, https://mcp.opensmm.dev, https://example.org
```
