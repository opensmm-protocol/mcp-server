/**
 * Live x402 testnet probe: quote → order → sign EIP-3009 payload → settle via
 * a real facilitator → execution start. Small USDC amount on Base Sepolia.
 *
 * Required env (see docs/X402_TESTNET.md):
 *   X402_PRIVATE_KEY    — payer key holding Base Sepolia USDC (never printed)
 *   X402_PAYTO_ADDRESS  — recipient; defaults to the payer (self-payment probe)
 * Optional:
 *   X402_FACILITATOR_URL (default https://x402.org/facilitator)
 *   X402_NETWORK         (default eip155:84532)
 *   X402_SERVICE_ID / X402_QUANTITY / X402_LINK — order override
 *
 * Run: npm run x402:testnet
 */

import { randomBytes } from "node:crypto";
import { privateKeyToAccount } from "viem/accounts";
import { createStackFromEnv } from "../src/bootstrap.ts";
import { toWireRequirements } from "../src/adapters/payments/x402/facilitator-http.ts";
import type { PaymentRequirement } from "../src/core/types.ts";

/** EIP-712 domain name of USDC per chain id ("USDC" on testnet, "USD Coin" on mainnet). */
const USDC_DOMAIN_NAMES: Record<number, string> = { 8453: "USD Coin", 84532: "USDC" };

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`missing env ${name} — see docs/X402_TESTNET.md`);
    process.exit(1);
  }
  return value;
}

async function main(): Promise<void> {
  process.env.X402_FACILITATOR_URL ??= "https://x402.org/facilitator";
  const network = process.env.X402_NETWORK ?? "eip155:84532";
  const chainId = Number(network.split(":")[1]);
  if (!Number.isInteger(chainId)) throw new Error(`cannot parse chain id from ${network}`);

  const payer = privateKeyToAccount(required("X402_PRIVATE_KEY") as `0x${string}`);
  process.env.X402_PAYTO_ADDRESS ??= payer.address;
  const payTo = process.env.X402_PAYTO_ADDRESS;
  console.log(`payer:   ${payer.address}`);
  console.log(`payTo:   ${payTo}`);
  console.log(`network: ${network} via ${process.env.X402_FACILITATOR_URL}`);

  const { core } = await createStackFromEnv();

  // 1. quote the cheapest sensible order (service min quantity by default)
  const serviceId = process.env.X402_SERVICE_ID ?? "osmm_svc_tg_members_std";
  const service = core.getService(serviceId);
  const quantity = Number(process.env.X402_QUANTITY ?? service.minQuantity);
  const link = process.env.X402_LINK ?? "https://t.me/opensmm_testnet_probe";
  const quote = core.getQuote({ serviceId, quantity, link });
  console.log(`quote:   ${service.name} x${quantity} = ${quote.amount.value} ${quote.amount.currency}`);

  // 2. order → payment requirements (the "402")
  const { order } = await core.createOrder({
    quoteId: quote.quoteId,
    link,
    clientReference: `x402-testnet-${Date.now()}`,
  });
  const requirement = order.paymentRequirements?.find(
    (r: PaymentRequirement) => r.method === "x402",
  );
  if (!requirement) throw new Error("order carries no x402 payment requirement");
  console.log(`order:   ${order.orderId} — payment ${order.paymentStatus}`);

  // 3. sign EIP-3009 transferWithAuthorization
  const wire = toWireRequirements(requirement);
  const domainName = USDC_DOMAIN_NAMES[chainId] ?? "USDC";
  const now = Math.floor(Date.now() / 1000);
  const authorization = {
    from: payer.address,
    to: payTo as `0x${string}`,
    value: BigInt(wire.amount),
    validAfter: BigInt(now - 60),
    validBefore: BigInt(now + wire.maxTimeoutSeconds),
    nonce: `0x${randomBytes(32).toString("hex")}` as `0x${string}`,
  };
  const signature = await payer.signTypedData({
    domain: {
      name: domainName,
      version: "2",
      chainId,
      verifyingContract: wire.asset as `0x${string}`,
    },
    types: {
      TransferWithAuthorization: [
        { name: "from", type: "address" },
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" },
        { name: "validBefore", type: "uint256" },
        { name: "nonce", type: "bytes32" },
      ],
    },
    primaryType: "TransferWithAuthorization",
    message: {
      ...authorization,
      validAfter: authorization.validAfter,
      validBefore: authorization.validBefore,
    },
  });
  const paymentPayload = {
    x402Version: 2,
    accepted: wire,
    payload: {
      signature,
      authorization: {
        ...authorization,
        value: authorization.value.toString(),
        validAfter: authorization.validAfter.toString(),
        validBefore: authorization.validBefore.toString(),
      },
    },
  };

  // 4. settle through the facilitator
  const intent = await core.settlePayment(order.paymentIntentId!, {
    method: "x402",
    proof: paymentPayload,
  });
  console.log(`settle:  ${intent.status}${intent.txHash ? ` tx=${intent.txHash}` : ""}`);
  if (intent.status !== "SETTLED") {
    console.log("settlement pending — poll the intent later, never re-pay.");
    return;
  }

  // 5. execution starts against the (mock) provider
  for (let i = 0; i < 20; i++) {
    const current = await core.getOrder(order.orderId);
    if (current.executionStatus !== "NOT_STARTED") {
      console.log(`execution: ${current.executionStatus} (payment ${current.paymentStatus})`);
      break;
    }
  }
  const explorer = chainId === 84532 ? "https://sepolia.basescan.org" : "https://basescan.org";
  if (intent.txHash) console.log(`tx:      ${explorer}/tx/${intent.txHash}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
