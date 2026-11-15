# Run an OpenSMM node as a systemd service

A typical unit for a Linux VPS without Docker: the node starts at boot, restarts
after a crash or an OOM kill, keeps its state in `/var/lib/opensmm` and reads its
configuration from `/etc/opensmm/opensmm.env`.

The service runs as the unprivileged user `opensmm`; nothing in it needs root.
Requires Node.js ≥ 22.18 (`node --version`), the same as every other route in
[`docs/DEPLOY.md`](../../docs/DEPLOY.md).

## 1. Service user and checkout

```bash
sudo useradd --system --home /opt/opensmm --shell /usr/sbin/nologin opensmm
sudo mkdir -p /opt/opensmm
sudo chown opensmm:opensmm /opt/opensmm
sudo -u opensmm git clone https://github.com/opensmm-protocol/mcp-server.git /opt/opensmm/mcp-server
cd /opt/opensmm/mcp-server && sudo -u opensmm npm ci
```

`npm ci` installs the runtime dependencies; no build step is needed — the node
runs the TypeScript sources directly on Node 22.18+, and `dist/` is used when it
exists.

## 2. Environment file

```bash
sudo install -d -m 0750 -o root -g opensmm /etc/opensmm
sudo install -m 0600 -o root -g opensmm /dev/null /etc/opensmm/opensmm.env
sudo editor /etc/opensmm/opensmm.env
```

Minimal content of `/etc/opensmm/opensmm.env` (every variable is commented in
[`.env.example`](../../.env.example), the full table is in
[`docs/DEPLOY.md`](../../docs/DEPLOY.md#environment)):

```bash
PORT=8080
OPENSMM_STATE_FILE=/var/lib/opensmm/opensmm-state.json
# Optional live provider and payout address:
#OPENSMM_REST_V1_BASE_URL=https://provider.example/api/v1
#OPENSMM_REST_V1_API_KEY=
#OPENSMM_PROVIDER_PAYOUT=0xYourUsdcBaseAddress
```

The file stays `0600` (owner `root`, group `opensmm`): it holds provider and
payment credentials. The unit reads it as `EnvironmentFile=` and falls back to
`OPENSMM_STATE_FILE=/var/lib/opensmm/opensmm-state.json` when the file does not
set it.

## 3. State directory

The unit declares `StateDirectory=opensmm`, so systemd creates
`/var/lib/opensmm` with mode `0700`, owned by `opensmm:opensmm`, and makes it
writable under `ProtectSystem=strict`. No manual `mkdir` is needed; check it
after the first start:

```bash
sudo systemctl start opensmm
sudo ls -ld /var/lib/opensmm          # drwx------ opensmm opensmm
sudo ls -l /var/lib/opensmm/opensmm-state.json   # -rw------- (0600)
```

If you create the directory yourself, keep it `0700`, owned by `opensmm`, and
make the state file `0600` — it contains provider credentials, back it up like a
secret:

```bash
sudo install -d -m 0700 -o opensmm -g opensmm /var/lib/opensmm
sudo chmod 0600 /var/lib/opensmm/opensmm-state.json
```

The node writes the snapshot with mode `0600` (`UMask=0077` in the unit), so a
missing file is created correctly; the `chmod` above is for a file restored from
a backup.

## 4. Install the unit

```bash
sudo cp /opt/opensmm/mcp-server/examples/systemd/opensmm.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now opensmm
```

`enable` starts the node at boot, `--now` starts it immediately. If the checkout
or the Node.js binary is not at the default path, edit `WorkingDirectory=` and
`ExecStart=` first (`command -v node` prints the absolute path systemd needs).

## 5. Check the node

```bash
sudo systemctl status opensmm        # active (running), restart counter 0
sudo journalctl -u opensmm -n 50     # "gateway listening on http://localhost:8080"
curl -s http://127.0.0.1:8080/health # {"status":"ok",...}
curl -s http://127.0.0.1:8080/v0/services
cd /opt/opensmm/mcp-server && sudo -u opensmm npm run verify:node -- http://127.0.0.1:8080
```

`verify:node` runs the two checks the census counts (catalog and MCP
`initialize`), so a PASS here means the node is a valid external node once it is
reachable from the internet.

## 6. Operations

```bash
sudo systemctl restart opensmm     # restart, e.g. after editing the env file
sudo systemctl stop opensmm        # SIGTERM: the node flushes its state file
sudo journalctl -u opensmm -f      # follow the log
```

`Restart=always` with `RestartSec=5` brings the node back after a crash, an OOM
kill (`MemoryMax=512M`) or a reboot; a config error is not hidden — the unit
enters `failed` after the restart burst and `journalctl` shows the reason.

The node itself has no TLS and no authentication: it listens on all interfaces
and must not be exposed directly. Put Caddy in front and proxy to
`127.0.0.1:8080` (section «TLS + public endpoint» in
[`docs/DEPLOY.md`](../../docs/DEPLOY.md)), or restrict the port in the firewall
until then.
