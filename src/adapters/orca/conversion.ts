/**
 * Conversions from Whirlpool on-chain representation to the continuous model.
 *
 * On chain, a Whirlpool prices token B per token A in base units, and token
 * A/B order is set by mint byte order — not by which token is the base. In the
 * WBTC/SOL pool, SOL is token A, so the native price is WBTC per SOL. Every
 * conversion here therefore takes an explicit {@link Orientation}; nothing
 * assumes "A is base".
 */

import { sqrtPriceToPrice, tickIndexToPrice } from '@orca-so/whirlpools-core';

import { createRange, quotePerBase, tokenAmounts } from '../../math/index.js';
import type { PriceRange, QuotePerBase, TokenAmounts } from '../../math/index.js';
import { AmbiguousQuoteError } from '../../positions/index.js';

/** Which of the pool's tokens is the base, plus both tokens' decimals. */
export interface Orientation {
  readonly baseIsA: boolean;
  readonly decimalsA: number;
  readonly decimalsB: number;
}

/**
 * Chooses the quote token: the first mint of `quotePreference` that is in the
 * pair. Throws {@link AmbiguousQuoteError} when neither mint is listed — a
 * guessed direction is exactly the plausible wrong number to avoid.
 *
 * @returns `true` when token A is the base (so token B is the quote).
 */
export function baseIsTokenA(
  mintA: string,
  mintB: string,
  quotePreference: readonly string[],
): boolean {
  for (const quote of quotePreference) {
    if (quote === mintB) {
      return true;
    }
    if (quote === mintA) {
      return false;
    }
  }
  throw new AmbiguousQuoteError(mintA, mintB);
}

/** Pool price from the Q64.64 `sqrtPrice`, as quote per base. */
export function priceFromSqrtPrice(sqrtPrice: bigint, o: Orientation): QuotePerBase {
  const bPerA = sqrtPriceToPrice(sqrtPrice, o.decimalsA, o.decimalsB);
  return quotePerBase(o.baseIsA ? bPerA : 1 / bPerA);
}

/**
 * Position range from its tick bounds, as quote per base. When the base is
 * token B the prices invert, so the upper tick gives the lower bound.
 */
export function rangeFromTicks(
  tickLowerIndex: number,
  tickUpperIndex: number,
  o: Orientation,
): PriceRange {
  const atLower = tickIndexToPrice(tickLowerIndex, o.decimalsA, o.decimalsB);
  const atUpper = tickIndexToPrice(tickUpperIndex, o.decimalsA, o.decimalsB);
  return o.baseIsA
    ? createRange(quotePerBase(atLower), quotePerBase(atUpper))
    : createRange(quotePerBase(1 / atUpper), quotePerBase(1 / atLower));
}

/**
 * On-chain liquidity relates base-unit amounts to base-unit prices; the model
 * works in token units and decimal prices. Converting both sides gives
 * `L_model = L_raw / √(10^decimalsA · 10^decimalsB)`, which is symmetric in A
 * and B, so it does not depend on the orientation.
 *
 * The result is an approximation (relative error ≤ 2⁻⁵³) for analysis only:
 * never use it to rebuild the on-chain integer or anything transaction-bound.
 */
export function toModelLiquidity(raw: bigint, decimalsA: number, decimalsB: number): number {
  return Number(raw) / Math.sqrt(10 ** decimalsA * 10 ** decimalsB);
}

/** Base-unit amounts of tokens A and B as token-unit amounts of base and quote. */
export function toTokenAmounts(rawA: bigint, rawB: bigint, o: Orientation): TokenAmounts {
  const a = Number(rawA) / 10 ** o.decimalsA;
  const b = Number(rawB) / 10 ** o.decimalsB;
  return o.baseIsA ? tokenAmounts(a, b) : tokenAmounts(b, a);
}
