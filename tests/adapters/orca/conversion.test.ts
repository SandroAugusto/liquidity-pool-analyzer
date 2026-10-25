import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  baseIsTokenA,
  toModelLiquidity,
  toTokenAmounts,
} from '../../../src/adapters/orca/conversion.js';
import {
  amountsAtPrice,
  createPosition,
  createRange,
  quotePerBase,
} from '../../../src/math/index.js';
import { AmbiguousQuoteError } from '../../../src/positions/index.js';

describe('baseIsTokenA', () => {
  const prefs = ['USDC', 'SOL'];

  it('makes the preferred quote token the quote, whichever side it is on', () => {
    expect(baseIsTokenA('WBTC', 'SOL', prefs)).toBe(true);
    expect(baseIsTokenA('SOL', 'WBTC', prefs)).toBe(false);
  });

  it('follows preference order when both tokens are quote candidates', () => {
    expect(baseIsTokenA('SOL', 'USDC', prefs)).toBe(true);
    expect(baseIsTokenA('USDC', 'SOL', prefs)).toBe(false);
  });

  it('refuses to guess when neither token is listed', () => {
    expect(() => baseIsTokenA('BONK', 'WBTC', prefs)).toThrow(AmbiguousQuoteError);
  });
});

describe('toTokenAmounts', () => {
  it('scales by each token’s decimals and orients to base/quote', () => {
    const o = { decimalsA: 9, decimalsB: 8 };
    expect(toTokenAmounts(5_000_000_000n, 200_000n, { ...o, baseIsA: false })).toMatchObject({
      base: 0.002,
      quote: 5,
    });
    expect(toTokenAmounts(5_000_000_000n, 200_000n, { ...o, baseIsA: true })).toMatchObject({
      base: 5,
      quote: 0.002,
    });
  });
});

/**
 * #5 criterion 9: the liquidity conversion, checked without the SDK. The
 * on-chain formula works in base units and base-unit prices (token B per
 * token A); the model works in token units and quote-per-base decimal prices.
 * Two independent formulas, compared for both orientations.
 */
describe('toModelLiquidity', () => {
  function onChainAmounts(L: number, pRaw: number, loRaw: number, hiRaw: number) {
    const p = Math.min(Math.max(pRaw, loRaw), hiRaw);
    return {
      a: L * (1 / Math.sqrt(p) - 1 / Math.sqrt(hiRaw)),
      b: L * (Math.sqrt(p) - Math.sqrt(loRaw)),
    };
  }

  it('makes model amounts equal on-chain amounts, in both orientations', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 12 }),
        fc.integer({ min: 0, max: 12 }),
        fc.double({ min: 1e6, max: 1e18, noNaN: true }), // raw liquidity
        fc.double({ min: -4, max: 4, noNaN: true }), // log10 of the decimal price (B per A)
        fc.double({ min: 0.8, max: 0.999, noNaN: true }),
        fc.double({ min: 1.001, max: 1.2, noNaN: true }),
        (decA, decB, Lraw, logP, loFactor, hiFactor) => {
          const pBperA = 10 ** logP;
          const [lo, hi] = [pBperA * loFactor, pBperA * hiFactor];
          const toRaw = 10 ** (decB - decA); // decimal price → base-unit price
          const raw = onChainAmounts(Lraw, pBperA * toRaw, lo * toRaw, hi * toRaw);
          const L = toModelLiquidity(BigInt(Math.round(Lraw)), decA, decB);
          const rel = (x: number, y: number): number => Math.abs(x - y) / Math.abs(y);

          // Base = A: price as B per A.
          const asA = amountsAtPrice(
            createPosition(L, createRange(quotePerBase(lo), quotePerBase(hi))),
            quotePerBase(pBperA),
          );
          expect(rel(asA.base, raw.a / 10 ** decA)).toBeLessThan(1e-6);
          expect(rel(asA.quote, raw.b / 10 ** decB)).toBeLessThan(1e-6);

          // Base = B: price as A per B, bounds swap.
          const asB = amountsAtPrice(
            createPosition(L, createRange(quotePerBase(1 / hi), quotePerBase(1 / lo))),
            quotePerBase(1 / pBperA),
          );
          expect(rel(asB.base, raw.b / 10 ** decB)).toBeLessThan(1e-6);
          expect(rel(asB.quote, raw.a / 10 ** decA)).toBeLessThan(1e-6);
        },
      ),
      { numRuns: 500 },
    );
  });
});
