# ElizaOS plugin: search → quote → order → replay

A copy-paste plugin for [ElizaOS](https://github.com/elizaOS/eliza) agents with
three actions — `SEARCH_SERVICES`, `GET_QUOTE`, `CREATE_ORDER` — that call a
running OpenSMM node over `POST /mcp`. Written for the **ElizaOS 1.x** plugin
shape (`@elizaos/core` `1.6.x`). `plugin.mjs` imports nothing from
`@elizaos/*`, so this repository gains no dependency.

**Honest scope:** the node's catalog is a **mock** — every service is marked
`synthetic: true`, nothing is executed, and the order stays `REQUIRES_PAYMENT`.
No keys, no money.

## Run the smoke test (~2 minutes)

```bash
git clone https://github.com/opensmm-protocol/mcp-server.git
cd mcp-server
npm ci
PORT=8080 npm run gateway &
node examples/eliza/smoke.mjs http://127.0.0.1:8080
```

Expected: `action:` lines for each step, then `replay:` with the **same
`orderId`** as the first order, and `done:      ElizaOS plugin OK` (exit 0).

## Use in your agent

```bash
cp examples/eliza/plugin.mjs <your-eliza-project>/src/opensmm-plugin.mjs
```

```js
import { opensmmPlugin } from "./opensmm-plugin.mjs";
export const character = { name: "Shop", plugins: [opensmmPlugin] /* ... */ };
```

Point it at your node with the runtime setting (or env) `OPENSMM_NODE_URL`
(default `http://127.0.0.1:8080`). Action inputs: `SEARCH_SERVICES` `{ query? }`,
`GET_QUOTE` `{ serviceId, quantity, link }`, `CREATE_ORDER` `{ quoteId, link,
clientReference }`. Repeating `CREATE_ORDER` with the same `clientReference`
returns the same order.
