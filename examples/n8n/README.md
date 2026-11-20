# n8n: quote → order → replay → poll on the mock catalog

[`workflow.json`](./workflow.json) is an importable n8n workflow. Its HTTP
Request nodes walk the REST API of a local node; two Code nodes keep the demo
honest (mock-only guard) and check the idempotency invariant.

Pinned to n8n 1.x with the HTTP Request node `typeVersion: 4.2` (workflow
format as exported by n8n). No credentials, API keys or money: the node is the
default mock node from this checkout.

## Run

```bash
git clone https://github.com/opensmm-protocol/mcp-server.git
cd mcp-server
npm ci
npm run gateway
```

Then in n8n: **Workflows → Import from File → `examples/n8n/workflow.json`**,
open the workflow and press **Execute Workflow**.

## Nodes and expected output

| Node | Call | Output |
| --- | --- | --- |
| Config | — | `baseUrl`, `quantity: 100`, `link`, fresh `clientReference` (`n8n-demo-…`) |
| GET catalog | `GET /v0/services` | the mock catalog |
| Guard: mock only | Code | refuses to continue unless the first service is `synthetic: true`; passes its `serviceId` on |
| Create quote | `POST /v0/quotes` | `osmm_quote_...` |
| Create order | `POST /v0/orders` | `osmm_order_...`, `REQUIRES_PAYMENT` |
| Replay order | `POST /v0/orders` (identical body) | **the same** `orderId` |
| Verify idempotency | Code | fails if the two order IDs differ; emits `catalog: MOCK` |
| Poll order | `GET /v0/orders/:id` | the stored order |

`Create order` and `Replay order` return HTTP 402 while payment is outstanding;
their “Never Error” response option keeps the order body flowing to the next
node. The replay returns 200 with the same body. Nothing is paid and no
provider executes anything.

The **Guard: mock only** node throws when the catalog contains a non-mock
service, so importing this workflow cannot place a demo order against real
supply. To point it at another node, edit only `baseUrl` in **Config**.

Next: [the 5-minute guide](../../docs/AGENT_QUICKSTART.md) ·
[all examples](../README.md).
