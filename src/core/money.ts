/** Decimal-string money math on integer micro-units (1e-6). No floats anywhere. */

import type { Money, RateBasis } from "./types.ts";

const SCALE = 1_000_000n;

export function parseDecimal(value: string): bigint {
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!m) throw new Error(`invalid decimal: ${value}`);
  const [, sign, intPart, fracPart = ""] = m;
  const frac = (fracPart + "000000").slice(0, 6);
  const units = BigInt(intPart) * SCALE + BigInt(frac);
  return sign === "-" ? -units : units;
}

export function formatDecimal(units: bigint): string {
  const neg = units < 0n;
  const abs = neg ? -units : units;
  const intPart = abs / SCALE;
  const fracPart = (abs % SCALE).toString().padStart(6, "0");
  return `${neg ? "-" : ""}${intPart}.${fracPart}`;
}

/** total = rate * quantity / basisDivisor, rounded half-up to micro units. */
export function quoteAmount(rate: Money, rateBasis: RateBasis, quantity: number): Money {
  if (!Number.isInteger(quantity) || quantity < 1) {
    throw new Error(`invalid quantity: ${quantity}`);
  }
  const rateUnits = parseDecimal(rate.value);
  const divisor = rateBasis === "PER_1000" ? 1000n : 1n;
  const numerator = rateUnits * BigInt(quantity);
  const total = (numerator + divisor / 2n) / divisor;
  return { value: formatDecimal(total), currency: rate.currency };
}
