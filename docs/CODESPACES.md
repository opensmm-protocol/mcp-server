# Run an OpenSMM node in GitHub Codespaces

A codespace gives you a ready Node.js workspace and a forwarded port with a
public URL — no local Docker, domain or TLS setup. You only need a GitHub
account and a browser. The whole path takes about five minutes.

> **The catalog is mock.** Without a connected provider you see synthetic
> services (`"synthetic": true`): no real supply, no real orders, no
> ProstoSpets key. Do not treat the services or prices as live SMM supply.

## 1. Create the codespace

1. Open <https://github.com/opensmm-protocol/mcp-server>.
2. **Code → Codespaces → Create codespace on `main`** (use `develop` to try the
   latest changes).
3. Wait for the terminal to finish `postCreateCommand` (`npm ci`) — the
   devcontainer installs dependencies for you.

The devcontainer lives in `.devcontainer/devcontainer.json`: Node.js 22, port
8080 forwarded, no extra editor extensions. Gateway core code is unchanged.

## 2. Start the node

In the codespace terminal:

```sh
npm ci                      # already done on create; safe to re-run
PORT=8080 npm run gateway
```

It reports the local endpoint on stderr:

```text
OpenSMM 0.1.1 gateway listening on http://localhost:8080 (REST /v0, MCP /mcp; provider: mock, mock catalog — not real supply)
```

## 3. Make port 8080 public

The devcontainer forwards 8080 automatically. In the **Ports** tab, right-click
8080 → **Port Visibility → Public**, then copy the Forwarded Address
(`https://<codespace-name>-8080.app.github.dev`). That is the URL an external
agent or the census will call. A private, "only you" port works in your own
browser but is not reachable from outside.

Check visibility again after restarting or recreating the codespace — the
setting is per workspace.

## 4. Check the node

Inside the codespace, all three must answer `200`:

```sh
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:8080/health
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:8080/v0/services
curl -s -X POST http://localhost:8080/mcp \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"codespaces","version":"1"}}}' \
  -o /dev/null -w '%{http_code}\n'
```

Now run the same probes against the public URL (paste the address from step 3):

```sh
npm run verify:node -- https://<codespace-name>-8080.app.github.dev
```

A PASS verdict means the weekly census will count this node. The exact
definition of a node is in [`docs/NODES.md`](./NODES.md).

## 5. Report the node

Once the public URL passes, report it for the weekly census via the
[node report template](https://github.com/opensmm-protocol/mcp-server/issues/new?template=node-report.md).

## Limits — read before you rely on this

- GitHub Codespaces is a paid service with a free monthly allowance for
  personal accounts. The allowance, quotas and whether it applies to your
  account depend on GitHub's current terms — check the billing page for your
  plan. No guarantee here of free capacity, a running workspace or uptime:
  idle codespaces stop, and organization policies can disable public port
  forwarding.
- A codespace node serves the mock catalog until you connect a real provider
  ([`docs/PROVIDER_ONBOARDING.md`](./PROVIDER_ONBOARDING.md)). No keys, npm
  publish access or container registry access are needed for the mock node.
- For a permanent node with your own domain and TLS, see
  [`docs/DEPLOY.md`](./DEPLOY.md). For the temporary tunnel alternative, see
  [`docs/NODES.md` («Public URL without a custom domain»)](./NODES.md#public-url-without-a-custom-domain).
