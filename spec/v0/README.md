# OpenSMM Protocol v0.1 (draft)

**Status:** `0.1.0-draft` — experimental. Breaking changes are allowed without notice
until `/v1`. All endpoints live under `/v0`. MCP tool names are stable within a minor
protocol version.

OpenSMM is a domain protocol for ordering and executing social-growth services by AI
agents. MCP is one inbound adapter; REST is the canonical HTTP binding. The same
operation through REST and MCP MUST produce the same domain objects (same `orderId`
for the same `clientReference`).

## 1. Terminology and roles

- **Gateway** — the OpenSMM server agents talk to. Owns catalog, quotes, prices,
  payments, idempotency, policy and refunds.
- **Provider** — an execution supplier behind the Provider SPI. Knows nothing about
  MCP, x402, client wallets or `clientReference`.
- **Agent** — the buyer. May be anonymous (pay-per-order) in later versions; this
  draft assumes a mock payment rail for local development.

## 2. Commands

| Command          | REST                                   | MCP tool           | Required |
|------------------|----------------------------------------|--------------------|----------|
| getCapabilities  | `GET  /v0/capabilities`                | `get_capabilities` | yes      |
| searchServices   | `GET  /v0/services?query=&platform=`   | `search_services`  | yes      |
| getService       | `GET  /v0/services/{serviceId}`        | `get_service`      | yes      |
| getQuote         | `POST /v0/quotes`                      | `get_quote`        | yes      |
| createOrder      | `POST /v0/orders`                      | `create_order`     | yes      |
| getOrder         | `GET  /v0/orders/{orderId}`            | `get_order_status` | yes      |
| cancelOrder      | `POST /v0/orders/{orderId}/cancel`     | `cancel_order`     | optional |
| requestRefill    | `POST /v0/orders/{orderId}/refill`     | `request_refill`   | optional |
| listProviders    | `GET  /v0/providers`                   | `list_providers`   | yes      |
| registerProvider | `POST /v0/providers`                   | `register_provider`| optional |

Out of scope for v0.1: campaigns, subscriptions, mass orders, bargaining,
auto-orders, account farms, A2A.

## 3. Models

JSON Schemas live in [`schemas/`](./schemas/), examples in [`examples/`](./examples/).

- **Service** — a sellable, curated SKU. `serviceId` is the gateway's stable ID; it
  MUST NOT change when the underlying provider changes. Prices use a `Money` object:
  `{ "value": "2.412000", "currency": "USDC" }` — decimal as string, never float.
  `rateBasis` is `PER_1000 | PER_UNIT | PER_PACKAGE`.
- **Quote** — a priced, expiring offer. Mandatory before ordering: `createOrder`
  references `quoteId`. A quote binds `serviceId + quantity + link + amount` and
  carries `catalogVersion`, `expiresAt`, `warnings`, `confirmationRequired`.
  Sell price is public; provider cost and provider identity are not.
- **Order** — the purchased execution. Carries **two independent statuses**
  (`paymentStatus`, `executionStatus`), never one merged `status`.
- **PaymentIntent** — the payment for an order. Separated from the Order so new
  payment rails do not change the order lifecycle. Holds `requirements[]`
  (`x402` / `ton` / `cryptobot` / `mock`).
- **ExecutionAttempt** — one submission of the order to a provider. Retries create
  new attempts; a timed-out submission is `SUBMISSION_UNKNOWN`, never silently
  retried (see §6).
- **ExecutionReceipt** — an observation of provider-side execution: status,
  `startCount`, `remains`, raw provider status.
- **Capabilities** — what this gateway supports: protocol version, commands,
  payment methods, features, `catalogVersion`.
- **Error** — machine-readable failure, see §5.

## 4. Status machines

### 4.1 paymentStatus

```
NOT_REQUIRED        # free/balance-settled orders (not used in v0.1 mock flow)
REQUIRES_PAYMENT    # order created, waiting for payment
VERIFYING           # payment seen, confirmation in progress
SETTLEMENT_PENDING  # accepted by settlement layer, finality pending — NOT an error,
                    # MUST NOT trigger re-payment
SETTLED             # paid; execution may start
FAILED
REFUNDING
REFUNDED
```

### 4.2 executionStatus

```
NOT_STARTED
SUBMITTING           # submission to provider in flight
SUBMISSION_UNKNOWN   # submission result unknown (timeout); no blind retry allowed
PENDING              # provider accepted, not started
IN_PROGRESS
PARTIAL              # partially delivered (does NOT imply a refund happened)
COMPLETED
CANCELED
ERROR
UNKNOWN              # unrecognized provider status; rawStatus preserved
```

## 5. Errors

Error body (REST: `application/problem+json`-compatible; MCP: `isError: true` with
the same JSON in `structuredContent`):

```json
{ "error": { "code": "QUOTE_EXPIRED", "message": "...", "details": {} } }
```

Canonical codes:

| Code                  | Meaning |
|-----------------------|---------|
| `VALIDATION_FAILED`   | Request failed schema validation (HTTP 400). |
| `NOT_FOUND`           | Unknown service/quote/order/payment (HTTP 404). |
| `SERVICE_UNAVAILABLE` | Service disabled or not sellable (HTTP 409). |
| `QUOTE_EXPIRED`       | `expiresAt` passed (HTTP 409). |
| `QUOTE_MISMATCH`      | Order parameters differ from the quote (HTTP 409). |
| `PAYMENT_REQUIRED`    | Action needs a settled payment first (HTTP 402). |
| `SETTLEMENT_PENDING`  | Payment settlement not final; retry later, do NOT re-pay (HTTP 409). |
| `SUBMISSION_UNKNOWN`  | Provider submission outcome unknown; manual reconciliation (HTTP 502). |
| `PROVIDER_REJECTED`   | Provider refused the order (HTTP 502). |
| `POLICY_DENIED`       | Policy engine denied the request (HTTP 403). |
| `IDEMPOTENCY_CONFLICT`| Same idempotency key, different parameters (HTTP 409). |
| `REFUND_REQUIRED`     | Money received but order cannot be executed (HTTP 500). |
| `INTERNAL`            | Anything else (HTTP 500). |

## 6. Idempotency

- REST: `Idempotency-Key: agent-order-00042` header on `POST /v0/orders`.
- MCP: `clientReference` field in `create_order` arguments.
- Repeating the same key with the **same** payload returns the original order
  (HTTP 200, no second charge, no second execution).
- Repeating the same key with a **different** payload fails with
  `IDEMPOTENCY_CONFLICT`.
- Keys are scoped per command. There is no global ordering guarantee across
  different keys.
- Provider APIs (SMM API v2) have no idempotency: after an ambiguous `add`
  result the order goes to `SUBMISSION_UNKNOWN` and is reconciled, never blindly
  resubmitted.

## 7. Flow (the acceptance scenario)

```
searchServices → getQuote → createOrder
   → paymentStatus: REQUIRES_PAYMENT   (REST answers HTTP 402 with the Order body)
   → payment settles (mock rail: POST /v0/payments/{paymentIntentId}/settle)
   → paymentStatus: SETTLED, executionStatus: SUBMITTING → PENDING → IN_PROGRESS
   → getOrder (poll)
   → executionStatus: COMPLETED
```

- `createOrder` MUST NOT start execution before `paymentStatus = SETTLED`.
- A quote may only be consumed once; reuse returns the order created from it.
- Polling `getOrder` is safe and rate-limit friendly; there are no webhooks in v0.1.

## 8. Settlement topologies (who pays whom)

The protocol is settlement-agnostic: `PaymentRequirement.payTo` decides the
topology, and both are valid OpenSMM. **Direct settlement is the canonical
topology** — the protocol is designed so money never transits a gateway that
is only routing:

- **Direct settlement (canonical).** `payTo` = provider address. The agent
  pays the execution provider directly (x402: USDC on Base). The gateway
  never holds user funds, never custodies balances and is not a party to the
  transaction — it is software that routes and measures. Providers declare
  their payout address at registration (§10); the gateway puts it into the
  payment requirements of that provider's orders.
- **Gateway-as-merchant (optional mode).** `payTo` = gateway address. Needed
  when the upstream only debits prepaid account balances (classic panel APIs)
  and the gateway operator chooses to be the merchant of record for its own
  users. Margin, refunds and buyer protection live in this mode — and so does
  the regulatory weight that comes with custody. Self-hosted gateways choose
  this mode explicitly; it is not the protocol default.

A gateway MUST NOT silently mix topologies within one PaymentIntent: the payer
must be able to see who the payee is before paying.

## 9. Providers: pseudonymity and quality metrics

`listProviders` shows the connected execution providers **pseudonymously**:
each gets a stable `providerKey` (`provider-alpha`, `provider-beta`, ...) assigned
by the gateway. The mapping from `providerKey` to the real provider is never
exposed through the protocol.

- `displayName` is **opt-in**: it appears only when the provider explicitly chose
  public listing (providers may want the visibility; it is their choice, not the
  gateway's default).
- Provider cost, upstream URLs and credentials are never public — quotes and
  orders expose only the gateway's sell price.
- `metrics` are **measured by the gateway** from its own orders, never provider
  self-reports. A metric field is omitted until `sampleSize` justifies it;
  `sampleSize` is always shown so agents can judge confidence. Publishing
  `successRate: 100` by default is forbidden.

### 9.1 Quality tiers (computed, open formula)

The protocol publishes raw measured metrics only. Quality tiers are **derived
by anyone** from those metrics using this open formula — the gateway does not
hand out subjective scores:

```
qualityScore = deliveredRatio^1.5 × retentionD7^2 × exp(-measuredStartP50Sec / 300)

tier S:  sampleSize ≥ 50  AND  deliveredRatio ≥ 0.98  AND  retentionD7 ≥ 0.95  AND  measuredStartP50Sec ≤ 60
tier A:  sampleSize ≥ 20  AND  deliveredRatio ≥ 0.95  AND  retentionD7 ≥ 0.85
tier B:  sampleSize ≥ 5   AND  deliveredRatio ≥ 0.80
else:    UNRANKED (insufficient data — treat as sandbox)
```

A provider wins placement by measured price and quality, never by arrangement
with the gateway operator. Any agent can recompute every tier from public data.

## 10. Provider registration (registerProvider)

A supply node joins a gateway by calling `registerProvider` — no manual
onboarding, no email exchanges:

```
POST /v0/providers            (REST)
register_provider             (MCP)
```

Request: [`schemas/register-provider-request.json`](./schemas/register-provider-request.json)
Response: [`schemas/register-provider-response.json`](./schemas/register-provider-response.json)

Flow:

1. **SSRF guard (§10.2).** The endpoint URL is validated before any network
   call. Failure → `POLICY_DENIED`.
2. **Adapter + healthcheck.** The gateway builds the adapter for the declared
   dialect (`smm-v2` or `rest-v1`) and lists the provider's offers. A
   successful listing proves reachability, auth and catalog in one call.
   Failure → `PROVIDER_REJECTED`, nothing is registered.
3. **Catalog sync.** The offers are normalized into gateway catalog entries
   (`serviceId` = `osmm_svc_<nodeId>_<externalId>`); `catalogVersion` changes.
4. **Node goes `UNVERIFIED`** with `metrics.sampleSize: 0`. Reputation accrues
   only from gateway-measured orders (§9); until promotion the node is
   volume-capped (§10.1).

Registration is **idempotent per endpoint**: re-registering the same
`endpoint` returns the existing `providerKey` instead of duplicating the node.

### 10.1 Lifecycle

```
UNVERIFIED → ACTIVE → SUSPENDED
```

- `UNVERIFIED`: registered and healthchecked, but without gateway-measured
  history. Routable and searchable, with an **anti exit-scam volume cap**:
  `getQuote` fails with `POLICY_DENIED` when the nominal order amount exceeds
  the cap (this implementation: 50 units of the quote currency per order).
  Promotion is computed, not negotiated:

  ```
  UNVERIFIED → ACTIVE when  sampleSize ≥ 5  AND  deliveredRatio ≥ 0.80  AND  errorRate ≤ 0.20
  ACTIVE → SUSPENDED when   sampleSize ≥ 10 AND  errorRate > 0.50
  ```

  Both transitions run automatically after every measured order outcome.
- `ACTIVE`: routable without the volume cap.
- `SUSPENDED`: excluded from routing and search; reactivation is a gateway
  policy decision. In-flight orders of a suspended node keep polling to
  completion — suspension stops *new* business, not existing obligations.

### 10.4 Supervision (catalog sync and the circuit breaker)

A gateway supervises its nodes continuously; registration is not a one-time
check:

- **Catalog sync.** Each node's offers are re-listed on an interval and its
  catalog entries are replaced (`catalogVersion` changes). Prices and
  availability drift; the catalog MUST follow the provider, not the
  registration snapshot.
- **Circuit breaker.** After N consecutive sync failures (this implementation:
  3) the node moves `ACTIVE → SUSPENDED` automatically. The first successful
  sync resets the counter and moves it back to `ACTIVE`. Failure of one node
  never delays the sync of others.
- **Order polling.** In-flight orders (`PENDING` / `IN_PROGRESS` / `PARTIAL`)
  are polled in the background on an interval, independent of client
  `getOrder` calls. Polling failures never move an order backwards.
- **Metrics feed.** Every observed transition (submission, first progress,
  terminal outcome, delivered units) feeds the gateway-measured metrics of
  §9 — they are the only source of provider reputation.

### 10.2 SSRF guard (mandatory)

An open registration endpoint turns the gateway into an HTTP client chosen by
strangers. Implementations MUST:

- require `https://` and reject URLs with embedded credentials;
- reject loopback, link-local, CGNAT, private and documentation ranges
  (IPv4 and IPv6, including v4-mapped IPv6), both as IP literals and after
  DNS resolution — resolve the hostname and check every returned address;
- reject non-resolving hostnames;
- treat DNS-rebinding as a known residual risk: hardened deployments SHOULD
  pin the validated address for the actual connection.

### 10.3 Credential handling

- `apiKey` is used only to call the provider's API. It MUST never appear in
  protocol responses, error messages, logs or public listings.
- Gateways SHOULD encrypt stored credentials at rest (envelope encryption)
  and MUST NOT log request bodies of `registerProvider`.
- Where possible, prefer agent-supplied credentials (BYOK) over storing
  provider keys at all.

## 11. Mock payment rail (development only)

`method: "mock"` exists so the full lifecycle is testable without x402/TON.
`POST /v0/payments/{paymentIntentId}/settle` marks the intent `SETTLED`.
This endpoint and method MUST NOT be enabled in production configuration.

## 12. Versioning

- Protocol: `0.1.0-draft`, URL prefix `/v0`.
- `catalogVersion` changes whenever the catalog content changes; quotes pin it.
- Supported protocol versions are announced via `getCapabilities`.
- Deprecations require a deprecation window after `/v1` exists.
