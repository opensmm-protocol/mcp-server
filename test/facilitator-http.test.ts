import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  HttpFacilitator,
  toWireRequirements,
  USDC_ADDRESSES,
} from "../src/adapters/payments/x402/facilitator-http.ts";
import { PaymentRejectedError } from "../src/core/payment-rail.ts";
import type { PaymentRequirement } from "../src/core/types.ts";

const REQUIREMENT: PaymentRequirement = {
  method: "x402",
  network: "eip155:84532",
  asset: "USDC",
  amount: { value: "2.412000", currency: "USDC" },
  payTo: "0xGatewayReceiver",
};

function stubFetch(handler: (url: string, body: any, headers: any) => unknown): typeof fetch {
  return (async (url: any, init: any) => {
    const payload = handler(String(url), JSON.parse(init.body), init.headers);
    const status = (payload as any)?.__status ?? 200;
    return new Response(JSON.stringify(payload), { status });
  }) as typeof fetch;
}

describe("toWireRequirements", () => {
  it("maps the internal requirement to the x402 v2 wire shape", () => {
    const wire = toWireRequirements(REQUIREMENT);
    assert.equal(wire.scheme, "exact");
    assert.equal(wire.network, "eip155:84532");
    assert.equal(wire.asset, USDC_ADDRESSES["eip155:84532"]);
    assert.equal(wire.payTo, "0xGatewayReceiver");
    assert.equal(wire.amount, "2412000"); // decimal string → atomic units, exact integer math
    assert.equal(wire.maxTimeoutSeconds, 300);
    // The facilitator derives the EIP-712 domain from extra; without it the
    // real facilitator rejects the payload (invalid_exact_evm_missing_eip712_domain).
    assert.deepEqual(wire.extra, { name: "USDC", version: "2" });
  });

  it("uses the mainnet USDC EIP-712 domain name on eip155:8453", () => {
    const wire = toWireRequirements({ ...REQUIREMENT, network: "eip155:8453" });
    assert.equal(wire.asset, USDC_ADDRESSES["eip155:8453"]);
    assert.deepEqual(wire.extra, { name: "USD Coin", version: "2" });
  });

  it("allows an explicit EIP-712 domain override", () => {
    const wire = toWireRequirements(REQUIREMENT, {
      eip712Domain: { name: "Custom USD", version: "1" },
    });
    assert.deepEqual(wire.extra, { name: "Custom USD", version: "1" });
  });

  it("rejects unknown networks unless a USDC address override is given", () => {
    const alien = { ...REQUIREMENT, network: "eip155:999" };
    assert.throws(() => toWireRequirements(alien), PaymentRejectedError);
    assert.throws(
      () => toWireRequirements(alien, { usdcAddress: "0xCustomUsdc" }),
      PaymentRejectedError, // domain must be explicit too — no silent Base Sepolia fallback
    );
    const wire = toWireRequirements(alien, {
      usdcAddress: "0xCustomUsdc",
      eip712Domain: { name: "Custom USD", version: "3" },
    });
    assert.equal(wire.asset, "0xCustomUsdc");
    assert.deepEqual(wire.extra, { name: "Custom USD", version: "3" });
  });

  it("requires network and payTo", () => {
    assert.throws(
      () => toWireRequirements({ ...REQUIREMENT, network: undefined }),
      PaymentRejectedError,
    );
    assert.throws(
      () => toWireRequirements({ ...REQUIREMENT, payTo: undefined }),
      PaymentRejectedError,
    );
  });
});

describe("HttpFacilitator", () => {
  it("verify forwards the payload and maps a valid answer", async () => {
    const calls: any[] = [];
    const facilitator = new HttpFacilitator({
      url: "https://facilitator.example/",
      fetchImpl: stubFetch((url, body) => {
        calls.push({ url, body });
        return { isValid: true, payer: "0xPayer" };
      }),
    });
    const result = await facilitator.verify({ x402Version: 2 }, REQUIREMENT);
    assert.deepEqual(result, { valid: true });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://facilitator.example/verify"); // trailing slash normalized
    assert.equal(calls[0].body.paymentRequirements.asset, USDC_ADDRESSES["eip155:84532"]);
    assert.deepEqual(calls[0].body.paymentRequirements.extra, { name: "USDC", version: "2" });
  });

  it("sends the EIP-712 domain on settle too (real-facilitator contract)", async () => {
    // Fixture mirrors https://x402.org/facilitator: it rejects a payload whose
    // requirements lack `extra` with invalid_exact_evm_missing_eip712_domain.
    const seen: any[] = [];
    const facilitator = new HttpFacilitator({
      url: "https://facilitator.example",
      fetchImpl: stubFetch((_url, body) => {
        seen.push(body.paymentRequirements);
        if (!body.paymentRequirements?.extra?.name) {
          return {
            success: false,
            errorReason: "invalid_exact_evm_missing_eip712_domain",
            errorMessage: "missing eip712 domain",
          };
        }
        return { success: true, transaction: "0xsettled", network: "eip155:84532" };
      }),
    });
    const result = await facilitator.settle({ x402Version: 2 }, REQUIREMENT);
    assert.deepEqual(result, { outcome: "settled", txHash: "0xsettled" });
    assert.deepEqual(seen[0].extra, { name: "USDC", version: "2" });
  });

  it("verify maps an invalid answer to a reason, code first", async () => {
    const facilitator = new HttpFacilitator({
      url: "https://facilitator.example",
      fetchImpl: stubFetch(() => ({
        isValid: false,
        invalidReason: "invalid_exact_evm_payload",
        invalidMessage: "signature must be a string",
      })),
    });
    const result = await facilitator.verify({}, REQUIREMENT);
    assert.equal(result.valid, false);
    assert.equal(result.reason, "invalid_exact_evm_payload: signature must be a string");
  });

  it("verify keeps the message when the facilitator sends no code", async () => {
    const facilitator = new HttpFacilitator({
      url: "https://facilitator.example",
      fetchImpl: stubFetch(() => ({
        isValid: false,
        invalidMessage: "payload expired",
      })),
    });
    const result = await facilitator.verify({}, REQUIREMENT);
    assert.equal(result.valid, false);
    assert.equal(result.reason, "payload expired");
  });

  it("settle returns settled with the on-chain tx hash", async () => {
    const facilitator = new HttpFacilitator({
      url: "https://facilitator.example",
      fetchImpl: stubFetch(() => ({
        success: true,
        transaction: "0xabc123",
        network: "eip155:84532",
      })),
    });
    const result = await facilitator.settle({}, REQUIREMENT);
    assert.deepEqual(result, { outcome: "settled", txHash: "0xabc123" });
  });

  it("settle maps settlement_pending to a non-terminal pending outcome", async () => {
    const facilitator = new HttpFacilitator({
      url: "https://facilitator.example",
      fetchImpl: stubFetch(() => ({
        success: false,
        errorReason: "settlement_pending",
        transaction: "0xpendingtx",
        network: "eip155:84532",
      })),
    });
    const result = await facilitator.settle({}, REQUIREMENT);
    assert.deepEqual(result, { outcome: "pending", txHash: "0xpendingtx" });
  });

  it("settle throws PaymentRejectedError on a definitive failure, code first on one line", async () => {
    // Public facilitator shape (x402.org): both the code and a multi-line
    // viem revert. The CLI prints err.message, so the code must lead and the
    // detail must not spread over several lines.
    const facilitator = new HttpFacilitator({
      url: "https://facilitator.example",
      fetchImpl: stubFetch(() => ({
        success: false,
        errorReason: "invalid_exact_evm_insufficient_balance",
        errorMessage:
          "Error: revert\n\nDetails: balance 0 < required 2412000\nVersion: viem@2.57.16",
        transaction: "",
        network: "eip155:84532",
      })),
    });
    await assert.rejects(
      () => facilitator.settle({}, REQUIREMENT),
      (err: unknown) => {
        assert.ok(err instanceof PaymentRejectedError);
        assert.match(err.message, /^invalid_exact_evm_insufficient_balance: /);
        assert.match(err.message, /balance 0 < required 2412000/);
        assert.ok(!err.message.includes("\n"), "error must be a single line");
        return true;
      },
    );
  });

  it("settle keeps the message when the facilitator sends no code", async () => {
    const facilitator = new HttpFacilitator({
      url: "https://facilitator.example",
      fetchImpl: stubFetch(() => ({
        success: false,
        errorMessage: "payer balance too low",
        network: "eip155:84532",
      })),
    });
    await assert.rejects(
      () => facilitator.settle({}, REQUIREMENT),
      (err: unknown) =>
        err instanceof PaymentRejectedError && err.message === "payer balance too low",
    );
  });

  it("settle falls back to a non-empty reason when the answer has neither code nor message", async () => {
    const facilitator = new HttpFacilitator({
      url: "https://facilitator.example",
      fetchImpl: stubFetch(() => ({ success: false })),
    });
    await assert.rejects(
      () => facilitator.settle({}, REQUIREMENT),
      (err: unknown) =>
        err instanceof PaymentRejectedError && err.message === "facilitator failed to settle",
    );
  });

  it("a 200 with a non-JSON body is a plain facilitator error, not a raw SyntaxError", async () => {
    const facilitator = new HttpFacilitator({
      url: "https://facilitator.example",
      // Proxy / captive-portal style answer: HTTP 200, HTML body.
      fetchImpl: (async () => new Response("<html>bad gateway</html>", { status: 200 })) as typeof fetch,
    });
    await assert.rejects(
      () => facilitator.settle({}, REQUIREMENT),
      (err: unknown) =>
        err instanceof Error &&
        !(err instanceof SyntaxError) &&
        // Still retryable: the facilitator broke, the payment was not rejected.
        !(err instanceof PaymentRejectedError) &&
        /x402 facilitator \/settle answered invalid JSON/.test(err.message),
    );
  });

  it("HTTP errors surface as plain errors, not payment rejections", async () => {
    const facilitator = new HttpFacilitator({
      url: "https://facilitator.example",
      fetchImpl: stubFetch(() => ({ __status: 500, error: "boom" })),
    });
    await assert.rejects(
      () => facilitator.verify({}, REQUIREMENT),
      (err: unknown) => !(err instanceof PaymentRejectedError) && /HTTP 500/.test(String(err)),
    );
  });

  it("sends the Bearer token when an apiKey is configured", async () => {
    let seenAuth: string | undefined;
    const facilitator = new HttpFacilitator({
      url: "https://facilitator.example",
      apiKey: "cdp-key",
      fetchImpl: stubFetch((_url, _body, headers) => {
        seenAuth = headers["authorization"];
        return { isValid: true };
      }),
    });
    await facilitator.verify({}, REQUIREMENT);
    assert.equal(seenAuth, "Bearer cdp-key");
  });
});
