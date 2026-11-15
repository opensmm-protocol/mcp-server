# Node census

How we count external OpenSMM nodes for the 30-day metric (ZHC-324).

## Definition of a node

A public URL is a node when both checks pass (redirects are not followed):

- `GET <url>/v0/services` — 200 with a JSON `services` array;
- `POST <url>/mcp` with `initialize` (JSON-RPC) — 200 with a JSON-RPC `result`.

`GET <url>/v0/providers` is informational: it never decides up or down.

## Check your own node first

Before the weekly census, run the same two checks locally — PASS/FAIL per
check, a verdict, exit 0 when the census would count the node and 1 when it
would not:

```sh
npm run verify:node -- http://127.0.0.1:8080
```

```text
verify-node: http://127.0.0.1:8080

PASS  GET /v0/services — 6 services in the catalog
PASS  POST /mcp initialize — 2025-06-18, server opensmm
PASS  GET /v0/providers — 1 provider registered   (informational, not counted)

PASS — the census counts this node: 2/2 required checks passed in 1315 ms
```

`scripts/verify-node.mjs` imports the probes from `scripts/node-census.mjs`:
one definition of a node, so a local PASS means the census sees the same node.
For a node behind a proxy or on a public host, pass the URL the census will
call (redirects are not followed — use the final URL).

### Machine-readable output for monitoring

Add `--json` to print the same result as JSON on stdout instead of the
human-readable report — for a cron job or a CI step that alerts on a down node:

```sh
npm run verify:node -- --json http://127.0.0.1:8080
```

The script prints only this JSON on stdout; `npm run` itself echoes the command
it runs above it, so a pipeline uses the `--silent` form or the direct `node`
call shown further down:

```json
{
  "entry": {
    "url": "http://127.0.0.1:8080",
    "services": 6,
    "providers": 1,
    "initialize": true,
    "latencyMs": 1315,
    "status": "up"
  },
  "checks": [
    { "name": "GET /v0/services", "ok": true, "detail": "6 services in the catalog" },
    { "name": "POST /mcp initialize", "ok": true, "detail": "2025-06-18, server opensmm" },
    {
      "name": "GET /v0/providers",
      "ok": true,
      "detail": "1 provider registered",
      "required": false
    }
  ]
}
```

`entry` is the census entry (`status` is `"up"` or `"down"`, `entry.error`
explains a down node); `checks` is the per-check report, where
`required: false` marks a check that never decides the verdict. Exit codes are
unchanged: 0 when the census would count the node, 1 when it would not or the
arguments are broken.

`--json` prints nothing else on stdout, but `npm run` echoes the command it
runs, and those `> ...` lines land on stdout and break a parser. Put npm's
`--silent` before the command, or call the script directly, when the output goes
into `jq` or a monitoring agent:

```sh
npm --silent run verify:node -- --json <url> | jq .entry.status
node scripts/verify-node.mjs --json <url> | jq .entry.status
```

A daily cron check that reports a down node through its exit code:

```sh
npm --silent run verify:node -- --json https://mcp.example.org > /var/log/opensmm-verify.json \
  || echo "OpenSMM node is down" >&2
```

Once your node passes locally and is publicly accessible, submit its URL for the
weekly census via the issue template:
[`issues/new?template=node-report.md`](https://github.com/opensmm-protocol/mcp-server/issues/new?template=node-report.md).

## Public URL without a custom domain

Census counts only publicly reachable HTTPS/HTTP URLs. If you do not have a
custom domain or a configured TLS reverse proxy yet, you can expose your local
gateway through a free Cloudflare quick tunnel without creating an account:

1. Start your gateway locally on port 8080:

```sh
npm run gateway
```

2. In another terminal, start the Cloudflare quick tunnel:

```sh
cloudflared tunnel --url http://127.0.0.1:8080
```

`cloudflared` prints a temporary `*.trycloudflare.com` URL (allow a few seconds
for tunnel registration and edge DNS propagation):

```text
+--------------------------------------------------------------------------------------------+
|  Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):  |
|  https://gamma-vegetable-sphere-waves.trycloudflare.com                                    |
+--------------------------------------------------------------------------------------------+
```

3. Verify that the census probes reach your public endpoint:

```sh
npm run verify:node -- https://gamma-vegetable-sphere-waves.trycloudflare.com
```

```text
verify-node: https://gamma-vegetable-sphere-waves.trycloudflare.com

PASS  GET /v0/services — 6 services in the catalog
PASS  POST /mcp initialize — 2025-06-18, server opensmm
PASS  GET /v0/providers — 1 provider registered   (informational, not counted)

PASS — the census counts this node: 2/2 required checks passed in 1949 ms
```

4. Once verified, report your URL for the weekly census via the issue template:
[`issues/new?template=node-report.md`](https://github.com/opensmm-protocol/mcp-server/issues/new?template=node-report.md).

> Warning: a quick tunnel URL is temporary and changes every time the tunnel
> process restarts. For a permanent node, set up TLS on your own domain with
> Caddy as described in [`docs/DEPLOY.md`](./DEPLOY.md#tls--public-endpoint-caddy).

## Run the census

```sh
npm run census -- --url http://127.0.0.1:8080 --url https://mcp.opensmm.dev
npm run census -- --file nodes.txt   # one URL per line, "#" starts a comment
node scripts/node-census.mjs --url http://127.0.0.1:8080 --url https://mcp.opensmm.dev
node scripts/node-census.mjs --file nodes.txt   # one URL per line, "#" starts a comment
```

A node started from a checkout (see README, «Run a node from source in 5
minutes») is checked the same way:
`npm run census -- --url http://127.0.0.1:8080`
(or `node scripts/node-census.mjs --url http://127.0.0.1:8080` without npm).

Limit is 20 URLs per run. Output is JSON on stdout; a summary goes to stderr.
An unreachable node is data, not a failure: `status: "down"`, exit 0. Exit 1 = broken arguments.

Both commands take `--timeout <ms>`: one budget for all three probes of a node,
default 5000 ms, allowed range 1000–30000 ms. On a slow network raise it, so a
reachable node is not reported as down:

```sh
npm run verify:node -- --timeout 10000 http://127.0.0.1:8080
npm run census -- --timeout 10000 --url https://mcp.opensmm.dev
node scripts/node-census.mjs --timeout 10000 --url https://mcp.opensmm.dev
```

A value outside the range or not an integer (`--timeout abc`, `--timeout -1`)
is a broken argument: exit 1 with the message
`--timeout: expected an integer between 1000 and 30000 ms`.

## Weekly report line

Copy one line per week into the ZHC-324 thread, with the JSON below it:

```
2026-11-09 — 1 node up of 3 checked: http://127.0.0.1:8080, https://mcp.opensmm.dev, https://example.org
```
