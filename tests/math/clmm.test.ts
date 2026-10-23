import { describe, expect, it } from 'vitest';

import {
  InvalidRangeError,
  PriceOutOfRangeError,
  amountsAtPrice,
  distanceToBounds,
  divergenceLoss,
  divergenceLossToEdgeFromCentre,
  geometricCentre,
  liquidityFromBase,
  liquidityFromQuote,
  rangeAround,
  valueInQuote,
} from '../../src/math/clmm.js';
import type { Position, PriceRange, TokenAmounts } from '../../src/math/clmm.js';

/**
 * Synthetic positions on an abstract pair, with round numbers chosen for the
 * tests. They do not describe any real position. Expected values were computed
 * independently in Python from the closed-form formulas.
 *
 *   - narrow: range [90, 100], opened at 97 with 1000 quote
 *   - at 95: 718.07608 quote + 7.17584833 base
 */
const NARROW = {
  range: { lower: 90, upper: 100 } satisfies PriceRange,
  entryPrice: 97,
  entryQuote: 1000,
  observed: { price: 95, quote: 718.0761, base: 7.1758 },
} as const;

/** Synthetic wide position, opened at the geometric centre of [85, 105]. */
const WIDE = {
  range: { lower: 85, upper: 105 } satisfies PriceRange,
  entryPrice: 94.4722,
  entryQuote: 1000,
  entryBase: 10.5852,
} as const;

describe('rangeAround', () => {
  it('builds a multiplicatively symmetric range', () => {
    const range = rangeAround(1000, 0.05);
    expect(range.lower).toBeCloseTo(952.38, 2);
    expect(range.upper).toBeCloseTo(1050, 2);
    expect(geometricCentre(range)).toBeCloseTo(1000, 6);
  });

  it('rejects non-positive inputs', () => {
    expect(() => rangeAround(0, 0.05)).toThrow(RangeError);
    expect(() => rangeAround(100, 0)).toThrow(RangeError);
    expect(() => rangeAround(100, Number.NaN)).toThrow(RangeError);
  });
});

describe('geometricCentre', () => {
  it('is the square root of the product of the bounds', () => {
    expect(geometricCentre({ lower: 4, upper: 9 })).toBe(6);
  });

  it('rejects an inverted or degenerate range', () => {
    expect(() => geometricCentre({ lower: 9, upper: 4 })).toThrow(InvalidRangeError);
    expect(() => geometricCentre({ lower: 5, upper: 5 })).toThrow(InvalidRangeError);
    expect(() => geometricCentre({ lower: 0, upper: 5 })).toThrow(InvalidRangeError);
  });
});

describe('distanceToBounds', () => {
  it('gives the relative distance from the price to each bound', () => {
    const d = distanceToBounds(96, NARROW.range);
    expect(d.toLower * 100).toBeCloseTo(-6.25, 1);
    expect(d.toUpper * 100).toBeCloseTo(4.17, 1);
  });
});

describe('liquidity recovery and amounts at price', () => {
  const liquidity = liquidityFromQuote(NARROW.entryQuote, NARROW.entryPrice, NARROW.range);
  const position: Position = { liquidity, range: NARROW.range };

  it('implies the base deposit from the quote deposit', () => {
    const { base } = amountsAtPrice(position, NARROW.entryPrice);
    expect(base).toBeCloseTo(4.239, 2);
    // Full precision matters: a UI rounded to 4 dp is not a valid hold baseline.
    expect(base).toBeCloseTo(4.238981, 6);
  });

  it('gives the holdings at another in-range price', () => {
    const { quote, base } = amountsAtPrice(position, NARROW.observed.price);
    expect(quote).toBeCloseTo(NARROW.observed.quote, 3);
    expect(base).toBeCloseTo(NARROW.observed.base, 4);
  });

  it('recovers the same liquidity from either token', () => {
    const { base } = amountsAtPrice(position, NARROW.entryPrice);
    const fromBase = liquidityFromBase(base, NARROW.entryPrice, NARROW.range);
    expect(fromBase).toBeCloseTo(liquidity, 8);
  });

  it('is 100 % quote at or above the upper bound', () => {
    for (const price of [NARROW.range.upper, NARROW.range.upper * 1.5]) {
      const { base, quote } = amountsAtPrice(position, price);
      expect(base).toBeCloseTo(0, 12);
      expect(quote).toBeGreaterThan(NARROW.entryQuote);
    }
  });

  it('is 100 % base at or below the lower bound', () => {
    for (const price of [NARROW.range.lower, NARROW.range.lower * 0.5]) {
      const { base, quote } = amountsAtPrice(position, price);
      expect(quote).toBeCloseTo(0, 12);
      expect(base).toBeGreaterThan(4.239);
    }
  });

  it('refuses to infer liquidity from an out-of-range price', () => {
    expect(() => liquidityFromQuote(1, NARROW.range.lower, NARROW.range)).toThrow(
      PriceOutOfRangeError,
    );
    expect(() => liquidityFromBase(1, NARROW.range.upper, NARROW.range)).toThrow(
      PriceOutOfRangeError,
    );
  });

  it('rejects non-positive deposits', () => {
    expect(() => liquidityFromQuote(0, NARROW.entryPrice, NARROW.range)).toThrow(RangeError);
    expect(() => liquidityFromBase(-1, NARROW.entryPrice, NARROW.range)).toThrow(RangeError);
  });

  it('rejects non-positive prices', () => {
    expect(() => amountsAtPrice(position, 0)).toThrow(RangeError);
    expect(() => amountsAtPrice(position, Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });
});

describe('a position opened at the geometric centre', () => {
  it('has near-equal value on each side at entry', () => {
    const liquidity = liquidityFromQuote(WIDE.entryQuote, WIDE.entryPrice, WIDE.range);
    const { base, quote } = amountsAtPrice({ liquidity, range: WIDE.range }, WIDE.entryPrice);
    expect(base).toBeCloseTo(WIDE.entryBase, 4);
    const baseValue = base * WIDE.entryPrice;
    expect(baseValue / quote).toBeCloseTo(1, 1);
  });
});

describe('divergenceLoss', () => {
  const liquidity = liquidityFromQuote(NARROW.entryQuote, NARROW.entryPrice, NARROW.range);
  const position: Position = { liquidity, range: NARROW.range };
  const deposit: TokenAmounts = amountsAtPrice(position, NARROW.entryPrice);

  it('is zero at the entry price', () => {
    expect(divergenceLoss(position, deposit, NARROW.entryPrice)).toBeCloseTo(0, 12);
  });

  it('matches an independently computed table for the narrow position', () => {
    // Values in % of hold, measured in quote, with the full-precision implied
    // base deposit as the hold baseline.
    const expected: readonly (readonly [number, number])[] = [
      [100, -0.45],
      [99, -0.2016],
      [95, -0.2083],
      [93, -0.8471],
      [91.5, -1.6218],
      [90, -2.6607],
    ];
    for (const [price, pct] of expected) {
      expect(divergenceLoss(position, deposit, price) * 100).toBeCloseTo(pct, 2);
    }
  });

  it('is never positive', () => {
    for (let price = 60; price <= 140; price += 0.7) {
      expect(divergenceLoss(position, deposit, price)).toBeLessThanOrEqual(1e-12);
    }
  });

  it('keeps growing (more negative) once out of range', () => {
    const atLower = divergenceLoss(position, deposit, NARROW.range.lower);
    const belowLower = divergenceLoss(position, deposit, NARROW.range.lower * 0.9);
    expect(belowLower).toBeLessThan(atLower);
  });
});

describe('divergenceLossToEdgeFromCentre', () => {
  it('is -1.334 % for the narrow range', () => {
    expect(divergenceLossToEdgeFromCentre(NARROW.range) * 100).toBeCloseTo(-1.334, 3);
  });

  it('is identical at both bounds by construction', () => {
    const range = rangeAround(100, 0.05);
    const centre = geometricCentre(range);
    const position: Position = { liquidity: 1, range };
    const deposit = amountsAtPrice(position, centre);
    const atLower = divergenceLoss(position, deposit, range.lower);
    const atUpper = divergenceLoss(position, deposit, range.upper);
    expect(atLower).toBeCloseTo(atUpper, 12);
    expect(divergenceLossToEdgeFromCentre(range)).toBeCloseTo(atUpper, 12);
  });

  it('grows roughly linearly with the half-width for narrow ranges', () => {
    // Full-range divergence loss grows with h², but concentration amplifies
    // it by ~1/h, so the loss to the edge of a narrow range grows ~linearly.
    const narrow = Math.abs(divergenceLossToEdgeFromCentre(rangeAround(100, 0.02)));
    const wide = Math.abs(divergenceLossToEdgeFromCentre(rangeAround(100, 0.04)));
    expect(wide / narrow).toBeGreaterThan(1.9);
    expect(wide / narrow).toBeLessThan(2.1);
  });
});

describe('valueInQuote', () => {
  it('prices the base leg at the given price', () => {
    expect(valueInQuote({ base: 2, quote: 5 }, 10)).toBe(25);
  });
});
