# Connecting your panel or node to an OpenSMM gateway

Zero-code onboarding: if your API speaks one of the supported dialects, you do
not write any code. Registration is one call.

## Supported dialects

| Dialect   | Shape                                                                 |
|-----------|-----------------------------------------------------------------------|
| `smm-v2`  | Classic panel API: `POST {endpoint}` with `key` + `action` (`services`, `add`, `status`, ...). Behavior profiles handle panel deviations. |
| `rest-v1` | Reseller-style REST: `GET {endpoint}/services`, `POST {endpoint}/orders`, `GET {endpoint}/orders/:id`, Bearer auth. |

## Option 1 — paste this prompt into your AI assistant

```text
You are an integration agent for the OpenSMM protocol.
Register my SMM panel on the OpenSMM gateway at <GATEWAY_URL>.

My panel details:
- API dialect: <smm-v2 or rest-v1>
- API endpoint: <https://your-panel.example/api/v2>
- API key: <your api key>
- Payout address (USDC on Base, optional but recommended): <0x...>

Steps:
1. Call the gateway's registerProvider command
   (REST: POST <GATEWAY_URL>/v0/providers, or the register_provider MCP tool)
   with adapter, endpoint, apiKey and payoutAddress.
   Do not invent a displayName; set publiclyListed only if I asked for it.
2. Report back: providerKey, lifecycle, offersCount.
3. Verify the listing: GET <GATEWAY_URL>/v0/providers and
   GET <GATEWAY_URL>/v0/services should include my offers.
```

## Option 2 — one curl

```bash
curl -X POST https://<gateway>/v0/providers \
  -H 'content-type: application/json' \
  -d '{
    "adapter": "smm-v2",
    "endpoint": "https://your-panel.example/api/v2",
    "apiKey": "<your api key>",
    "payoutAddress": "0xYourUsdcAddressOnBase"
  }'
```

Response:

```json
{
  "providerKey": "provider-beta",
  "lifecycle": "ACTIVE",
  "offersCount": 214,
  "catalogVersion": "2026-11-05T12:00:00.000Z"
}
```

## What happens under the hood

1. **SSRF guard** — your endpoint must be a public `https://` URL (spec/v0 §10.2).
2. **Healthcheck** — the gateway lists your offers once; this proves
   reachability, auth and catalog in a single call.
3. **Catalog sync** — your offers appear in `search_services` under
   gateway-normalized service IDs.
4. **Pseudonymity** — publicly you are `provider-beta`, nothing else.
   `displayName` is published only if you opt in with `publiclyListed: true`.

## Rules that protect you and the network

- Your `apiKey` is used only to call your API. It is never returned by the
  protocol, never logged, never shown in listings.
- Re-registering the same `endpoint` is idempotent — you get the same
  `providerKey` back, no duplicates.
- Reputation is measured by the gateway from real orders (start latency,
  delivered ratio, retention), never self-reported. New nodes start at
  `sampleSize: 0`; quality tiers are computed by an open formula (spec/v0 §9.1)
  that anyone can verify.
- With `payoutAddress` set, agents pay you directly (x402, USDC on Base).
  The gateway never touches the money.
