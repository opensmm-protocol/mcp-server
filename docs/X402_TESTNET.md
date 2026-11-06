# x402 on Base Sepolia: live facilitator setup

How to run the gateway against a real x402 facilitator on the Base Sepolia
testnet, and how to fire one live small-amount payment end to end
(quote → order → 402 → settle → execution start).

No keys, no problem: without the env below the stack keeps the dev-only mock
rail and nothing changes for local dev or tests.

## 1. Create the receiving wallet

```bash
node scripts/create-wallet.ts
```

This appends to `.env` (chmod 600, gitignored):

```
X402_NETWORK=eip155:84532
X402_PAYTO_ADDRESS=0x...   # gateway's receiving address
X402_PRIVATE_KEY=0x...     # never printed, never committed
```

For a first probe the same wallet can play payer and recipient (self-payment
is a valid EIP-3009 transfer). For a realistic flow use a second wallet as
payer and set `X402_PAYTO_ADDRESS` to the gateway's wallet.

## 2. Fund the payer wallet (testnet, free)

- **USDC (Base Sepolia)** — Circle faucet: <https://faucet.circle.com>
  (select Base Sepolia, paste the payer address). USDC contract:
  `0x036CbD53842c5426634e7929541eC2318f3dCF7e`.
- **ETH is not required on the payer** for the `exact` scheme — the
  facilitator sponsors gas for `transferWithAuthorization`.

## 3. Point the gateway at the facilitator

Public testnet facilitator (no auth):

```
X402_FACILITATOR_URL=https://x402.org/facilitator
```

Production facilitators (e.g. Coinbase CDP) require an API key:

```
X402_FACILITATOR_URL=https://api.cdp.coinbase.com/platform/v2/x402
X402_FACILITATOR_API_KEY=<cdp jwt>
```

Full env reference:

| Var | Default | Purpose |
| --- | --- | --- |
| `X402_FACILITATOR_URL` | — (mock rail) | Facilitator base URL; setting it enables the real rail and disables mock settlement |
| `X402_PAYTO_ADDRESS` | — | Default recipient of payment requirements (provider `payoutAddress` still wins per-order, spec/v0 §8) |
| `X402_NETWORK` | `eip155:84532` | CAIP-2 network (`eip155:8453` = Base mainnet) |
| `X402_FACILITATOR_API_KEY` | — | Bearer token for auth-gated facilitators |
| `X402_USDC_ADDRESS` | built-in table | USDC contract override for other networks |

Then boot as usual — REST, MCP or the combined gateway:

```bash
npm run gateway     # or: npm run rest / npm run mcp:http
```

`GET /v0/capabilities` now reports `paymentMethods: ["x402"]`, and every order
carries a real x402 payment requirement (network, USDC asset, `payTo`,
amount). Settling with `method: "mock"` is rejected in this configuration.

Each requirement is translated to the facilitator wire shape with `extra:
{ name, version }` — the USDC contract's EIP-712 domain, which the payer must
sign with and the facilitator derives verification from: `USDC`/`2` on Base
Sepolia, `USD Coin`/`2` on Base mainnet. Without it the facilitator answers
`invalid_exact_evm_missing_eip712_domain`.

## 4. Fire the live payment

```bash
npm run x402:testnet
```

The script (`scripts/x402-testnet-run.ts`) runs the whole flow in-process
against the mock provider catalog with the real rail:

1. quotes the default service at its minimum quantity (0.2412 USDC),
2. creates the order and reads its x402 payment requirement,
3. signs an EIP-3009 `transferWithAuthorization` with `X402_PRIVATE_KEY`
   (EIP-712 domain taken from the requirement's `extra`: `USDC`/`2` on Base
   Sepolia, `USD Coin`/`2` on Base mainnet, against the network's USDC
   contract),
4. submits the payload via `core.settlePayment` → facilitator `/verify` →
   `/settle`,
5. prints the on-chain tx hash and the execution status.

Optional overrides: `X402_SERVICE_ID`, `X402_QUANTITY`, `X402_LINK`.

Expected output:

```
payer:   0x...
payTo:   0x...
network: eip155:84532 via https://x402.org/facilitator
quote:   Telegram Channel Members — Standard x100 = 0.241200 USDC
order:   osmm_ord_... — payment REQUIRES_PAYMENT
settle:  SETTLED tx=0x...
execution: SUBMITTING (payment SETTLED)
tx:      https://sepolia.basescan.org/tx/0x...
```

## Failure semantics (already covered by tests)

- Facilitator rejection (bad signature, insufficient balance) →
  `PAYMENT_REQUIRED` with the facilitator's reason; the order stays
  `REQUIRES_PAYMENT`.
- `settlement_pending` from the facilitator → order moves to
  `SETTLEMENT_PENDING` with the broadcast tx hash: reconcile on chain, never
  re-pay.
- Facilitator HTTP 5xx / timeout → plain error, the intent stays retryable.
