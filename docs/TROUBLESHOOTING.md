# Troubleshooting OpenSMM Gateway

This page describes typical startup failures when running an OpenSMM gateway
from source, their symptoms, root causes, verification commands, and fixes.

All error messages and symptoms below are captured from real local runs.

## 1. Node.js < 22.18 (Missing native TypeScript support)

### Symptom
When running the gateway from source on Node.js older than 22.18, the process
fails immediately with:

```text
node:internal/modules/esm/get_format:243
  throw new ERR_UNKNOWN_FILE_EXTENSION(ext, filepath);
        ^

TypeError [ERR_UNKNOWN_FILE_EXTENSION]: Unknown file extension ".ts" for /path/to/mcp-server/src/adapters/inbound/gateway.ts
    at Object.getFileProtocolModuleFormat [as file:] (node:internal/modules/esm/get_format:243:9)
    at defaultGetFormat (node:internal/modules/esm/get_format:283:36)
    at defaultLoadSync (node:internal/modules/esm/load:161:16)
    at #loadAndMaybeBlockOnLoaderThread (node:internal/modules/esm/loader:806:12)
    at #loadSync (node:internal/modules/esm/loader:838:53)
    at ModuleLoader.load (node:internal/modules/esm/loader:787:26)
    at ModuleLoader.loadAndTranslate (node:internal/modules/esm/loader:498:31)
    at #getOrCreateModuleJobAfterResolve (node:internal/modules/esm/loader:564:36)
    at afterResolve (node:internal/modules/esm/loader:611:52)
    at ModuleLoader.getOrCreateModuleJob (node:internal/modules/esm/loader:617:12) {
  code: 'ERR_UNKNOWN_FILE_EXTENSION'
}
```

During `npm ci` or `npm install`, npm reports an engine warning or error:

```text
npm WARN EBADENGINE Unsupported engine {
npm WARN EBADENGINE   package: '@opensmm/mcp-server@0.1.0',
npm WARN EBADENGINE   required: { node: '>=22.18' },
npm WARN EBADENGINE   current: { node: 'v20.18.0', ... }
npm WARN EBADENGINE }
```

### Cause
OpenSMM runs TypeScript source files directly without a pre-compilation step in
development. Node.js requires version ≥ 22.18 for native TypeScript type stripping
by default.

### Verification command
```bash
node -v
```

Output must be `v22.18.0` or higher (e.g. `v24.x`).

### Fix
Install or activate Node.js ≥ 22.18 via your version manager:

```bash
nvm install 22.18.0 && nvm use 22.18.0
# or with fnm:
fnm use 22.18.0
```

Alternatively, if building the distributed package with `npm run build`, run
the compiled JS entrypoint from `dist/` or `bin/opensmm.mjs`.


## 2. Port already in use (`EADDRINUSE`, `--port 0`)

### Symptom
When starting the gateway on a port already occupied by another process (default: 8080),
the process crashes with an unhandled `'error'` event:

```text
node:events:505
    throw er; // Unhandled 'error' event
    ^

Error: listen EADDRINUSE: address already in use :::8080
    at Server.setupListenHandle [as _listen2] (node:net:2390:16)
    at listenInCluster (node:net:2499:12)
    at Server.listen (node:net:2624:7)
    at file:///path/to/mcp-server/src/adapters/inbound/gateway.ts:39:47
    at new Promise (<anonymous>)
    at serveGateway (file:///path/to/mcp-server/src/adapters/inbound/gateway.ts:39:9)
    at async file:///path/to/mcp-server/src/adapters/inbound/gateway.ts:54:3
Emitted 'error' event on Server instance at:
    at emitErrorNT (node:net:2478:8)
    at process.processTicksAndRejections (node:internal/process/task_queues:90:21) {
  code: 'EADDRINUSE',
  errno: -98,
  syscall: 'listen',
  address: '::',
  port: 8080
}
```

### Cause
Another gateway instance or a different service is already listening on the requested
port (`8080` by default).

### Verification command
Check which process is listening on the port:

```bash
lsof -i :8080
# or:
ss -tulpn | grep 8080
```

### Fix
1. **Kill the conflicting process:**
   ```bash
   kill $(lsof -t -i :8080)
   ```
2. **Or pick an alternate port via `PORT`:**
   ```bash
   PORT=8081 npm run gateway
   ```
3. **Or use `--port 0` (or `PORT=0`) for automatic ephemeral port allocation:**
   ```bash
   node bin/opensmm.mjs gateway --port 0
   ```
   With `--port 0`, the OS assigns an available free port. The gateway prints the
   bound port on stderr:
   ```text
   OpenSMM 0.1.0 gateway listening on http://localhost:39307 (REST /v0, MCP /mcp; provider: mock, mock catalog — not real supply)
   ```


## 3. State file permissions (`EACCES`)

### Symptom
When `OPENSMM_STATE_FILE` (or `--state`) points to a path where write access is denied,
saving the snapshot fails with:

```text
Error: EACCES: permission denied, open '/root/.opensmm-state.json.tmp-1244552'
    at Object.openSync (node:fs:621:18)
    at writeFileSync (node:fs:2496:35)
    at StateFile.save (file:///path/to/mcp-server/src/core/state-file.ts:38:5)
    ...
  errno: -13,
  code: 'EACCES',
  syscall: 'open',
  path: '/root/.opensmm-state.json.tmp-1244552'
}
```

If the state file exists but lacks read permissions (`chmod 000`), `StateFile.load()`
silently returns `undefined`. The gateway boots with an empty state instead of
restoring previous orders, metrics, and registered provider nodes.

### Cause
The state file or its target directory is owned by root (e.g. from a prior Docker run)
or has restrictive permissions that prevent the current user from reading or writing.
State snapshots contain provider credentials and are written with `0600` permissions.

### Verification command
```bash
ls -la "$OPENSMM_STATE_FILE"
# or check the containing directory:
ls -la "$(dirname "$OPENSMM_STATE_FILE")"
```

### Fix
Grant read/write permissions to the running user:

```bash
touch "$OPENSMM_STATE_FILE"
chmod 600 "$OPENSMM_STATE_FILE"
chown $(id -u):$(id -g) "$OPENSMM_STATE_FILE"
```


## 4. `npm ci` without network connection

### Symptom
Running `npm ci` without an internet connection or with an unreachable npm registry
fails with connection errors:

```text
npm error code ECONNREFUSED
npm error syscall connect
npm error errno ECONNREFUSED
npm error FetchError: request to http://127.0.0.1:9999/zod-to-json-schema/-/zod-to-json-schema-3.25.2.tgz failed, reason: connect ECONNREFUSED 127.0.0.1:9999
    at ClientRequest.<anonymous> (/usr/lib/node_modules/npm/node_modules/minipass-fetch/lib/index.js:130:14)
    at ClientRequest.emit (node:events:514:28)
    at emitErrorEvent (node:_http_client:114:11)
...
npm error If you are behind a proxy, please make sure that the 'proxy' config is set properly.  See: 'npm help config'
```

Or when DNS is unreachable:

```text
npm error code ENOTFOUND
npm error syscall getaddrinfo
npm error errno ENOTFOUND
npm error FetchError: request to https://registry.npmjs.org/... failed, reason: getaddrinfo ENOTFOUND registry.npmjs.org
```

Or if `--offline` is used with missing packages in cache:

```text
npm error code ENOTCACHED
npm error request to https://registry.npmjs.org/... failed: cache mode is 'only-if-cached' but no cached response is available.
```

### Cause
`npm ci` requires downloading packages defined in `package-lock.json`. If network
access is disabled, the npm registry is blocked by a proxy/firewall, or packages are
not present in the local npm cache (`~/.npm`), installation cannot proceed.

### Verification command
Check registry connectivity:

```bash
curl -I https://registry.npmjs.org
# or:
npm ping
```

### Fix
1. **Verify network connectivity and proxy settings:**
   ```bash
   npm config get proxy
   npm config get https-proxy
   ```
2. **If working offline in an isolated environment**, ensure dependencies were
   pre-cached on a machine with internet access:
   ```bash
   npm ci --prefer-offline
   ```
3. **If using Docker**, ensure the build context has internet access or uses a local
   mirror.


## 5. Empty / synthetic catalog with MockProvider

### Symptom
After starting the gateway, querying `/v0/services` shows only synthetic development
items where every service has `"synthetic": true`:

```json
{
  "services": [
    {
      "serviceId": "osmm_svc_tg_members_std",
      "name": "Telegram Channel Members — Standard",
      "description": "Real-looking members for public Telegram channels. Start 0-1h, speed ~5k/day.",
      "platform": "telegram",
      "objective": "members",
      "category": "Telegram / Members",
      "rate": {
        "value": "2.412000",
        "currency": "USDC"
      },
      "rateBasis": "PER_1000",
      "minQuantity": 100,
      "maxQuantity": 50000,
      "qualityTier": "standard",
      "parameters": [],
      "capabilities": {
        "refill": true,
        "cancel": true,
        "dripfeed": false
      },
      "status": "ACTIVE",
      "providerRef": "provider-alpha",
      "synthetic": true,
      "quality": {
        "tier": "standard",
        "orders": 0
      }
    }
  ]
}
```

Filtering by platforms not included in the mock set (e.g. `?platform=twitter`)
returns an empty list:

```json
{"services":[]}
```

And stderr explicitly reports:

```text
OpenSMM 0.1.0 gateway listening on http://localhost:8080 (REST /v0, MCP /mcp; provider: mock, mock catalog — not real supply)
```

Orders placed against these mock services are executed in-memory only and never sent
to real social media execution suppliers.

### Cause
The gateway defaults to `MockProvider` unless both `OPENSMM_REST_V1_BASE_URL` and
`OPENSMM_REST_V1_API_KEY` are provided. If either variable is missing or empty,
`createStackFromEnv()` silently falls back to `createDevStack()` with the 6-item
synthetic mock catalog.

### Verification command
Check whether the node is running in mock/synthetic mode:

```bash
curl -s http://localhost:8080/v0/providers | grep '"synthetic":true'
# and check provider env vars:
env | grep OPENSMM_REST_V1
```

### Fix
To connect real supply, set both variables in `.env` or the process environment:

```bash
export OPENSMM_REST_V1_BASE_URL="https://provider.example/api/v1"
export OPENSMM_REST_V1_API_KEY="your-api-key"
npm run gateway
```

For SMM API v2 panels, use the pre-onboarding diagnostic tool first:
```bash
node src/cli/provider-doctor.ts --url https://panel.example/api/v2 --key YOUR_KEY
```
