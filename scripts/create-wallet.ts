/**
 * Generates the gateway's x402 receiving wallet (EVM, works on Base mainnet & Sepolia)
 * and appends it to .env. The private key NEVER leaves this file and is never printed.
 * Run once: node scripts/create-wallet.ts
 */

import { appendFileSync, chmodSync, existsSync, readFileSync } from "node:fs";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const ENV_PATH = new URL("../.env", import.meta.url).pathname;

if (existsSync(ENV_PATH) && readFileSync(ENV_PATH, "utf8").includes("X402_PRIVATE_KEY=")) {
  console.error(".env already contains X402_PRIVATE_KEY — refusing to overwrite an existing wallet.");
  process.exit(1);
}

const privateKey = generatePrivateKey();
const account = privateKeyToAccount(privateKey);

appendFileSync(
  ENV_PATH,
  [
    "",
    "# x402 payment rail (USDC on Base). Testnet first: eip155:84532 = Base Sepolia.",
    `X402_NETWORK=eip155:84532`,
    `X402_PAYTO_ADDRESS=${account.address}`,
    `X402_PRIVATE_KEY=${privateKey}`,
    "",
  ].join("\n"),
  { mode: 0o600 },
);
// `mode` only applies when the file is created; an existing .env (the common
// case — provider keys live there) keeps its old permissions otherwise.
chmodSync(ENV_PATH, 0o600);

console.log(`x402 receiving address (safe to share): ${account.address}`);
console.log(`Network: eip155:84532 (Base Sepolia testnet)`);
console.log(`Private key written to .env (chmod 600, gitignored). Back it up securely.`);
console.log(
  `Next: fund the address with Base Sepolia testnet USDC (faucet.circle.com) — no ETH needed, the facilitator sponsors gas.`,
);
