import { describe, expect, it } from 'vitest';

import {
  EmptyDepositError,
  InvalidAmountError,
  InvalidLiquidityError,
  InvalidRangeError,
  PriceOutOfRangeError,
  amountsAtPrice,
  createPosition,
  createRange,
  distanceToBounds,
  divergenceLoss,
  divergenceLossToEdgeFromCentre,
  geometricCentre,
  liquidityFromBase,
  liquidityFromQuote,
  rangeAround,
  tokenAmounts,
  valueInQuote,
} from '../../src/math/clmm.js';
import { NumericOverflowError } from '../../src/math/errors.js';
import { InvalidPriceError, quotePerBase } from '../../src/math/price.js';

/**
 * Synthetic positions on an abstract pair, with round numbers chosen for the
 * tests. They do not describe any real position (AGENTS.md, "No private
 * position data"). Expected values were computed independently in Python
 * from the closed-form formulas, not by running this implementation.
 *
 *   - narrow: range [90, 100], opened at 97 with 1000 quote
 *   - at 95: 718.07608 quote + 7.17584833 base
 */
const NARROW = {
  range: createRange(quotePerBase(90), quotePerBase(100)),
  entryPrice: quotePerBase(97),
  entryQuote: 1000,
  impliedBase: 4.23898148,
  observed: { price: quotePerBase(95), quote: 718.07608, base: 7.17584833 },
} as const;

/** Synthetic wide position, opened at the geometric centre of [85, 105]. */
const WIDE = {
  range: createRange(quotePerBase(85), quotePerBase(105)),
  entryPrice: quotePerBase(94.4722),
  entryQuote: 1000,
  entryBase: 10.585162,
} as const;

// ---------------------------------------------------------------------------
// Constructors: every rejection path lives here
// ---------------------------------------------------------------------------

describe('quotePerBase', () => {
  it('accepts positive finite values and is transparent at runtime', () => {
    expect(quotePerBase(97)).toBe(97);
    expect(quotePerBase(1e-9)).toBe(1e-9);
  });

  it('rejects zero, negatives and non-finite values', () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(() => quotePerBase(bad)).toThrow(InvalidPriceError);
    }
  });
});

describe('createRange', () => {
  it('rejects an inverted or degenerate range', () => {
    expect(() => createRange(quotePerBase(9), quotePerBase(4))).toThrow(InvalidRangeError);
    expect(() => createRange(quotePerBase(5), quotePerBase(5))).toThrow(InvalidRangeError);
  });

  it('returns a frozen object', () => {
    expect(Object.isFrozen(NARROW.range)).toBe(true);
  });
});

describe('createPosition', () => {
  it('rejects negative or non-finite liquidity', () => {
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => createPosition(bad, NARROW.range)).toThrow(InvalidLiquidityError);
    }
  });

  it('accepts zero liquidity (a closed or empty position)', () => {
    const { base, quote } = amountsAtPrice(createPosition(0, NARROW.range), NARROW.entryPrice);
    expect(base).toBe(0);
    expect(quote).toBe(0);
  });
});

describe('tokenAmounts', () => {
  it('rejects negative or non-finite balances', () => {
    expect(() => tokenAmounts(-1, 0)).toThrow(InvalidAmountError);
    expect(() => tokenAmounts(0, -1)).toThrow(InvalidAmountError);
    expect(() => tokenAmounts(Number.NaN, 1)).toThrow(InvalidAmountError);
    expect(() => tokenAmounts(1, Number.POSITIVE_INFINITY)).toThrow(InvalidAmountError);
  });

  it('accepts a zero balance on either side', () => {
    expect(valueInQuote(tokenAmounts(0, 5), quotePerBase(10))).toBe(5);
    expect(valueInQuote(tokenAmounts(2, 0), quotePerBase(10))).toBe(20);
  });
});

describe('rangeAround', () => {
  it('builds a multiplicatively symmetric range', () => {
    const range = rangeAround(quotePerBase(1000), 0.05);
    expect(range.lower).toBeCloseTo(952.38, 2);
    expect(range.upper).toBeCloseTo(1050, 9);
    expect(geometricCentre(range)).toBeCloseTo(1000, 6);
  });

  it('never returns a range that fails validation, even at numerical extremes', () => {
    expect(() => rangeAround(quotePerBase(1e308), 10)).toThrow(InvalidPriceError);
    expect(() => rangeAround(quotePerBase(Number.MIN_VALUE), 1)).toThrow(InvalidPriceError);
  });

  it('rejects a non-positive half-width', () => {
    expect(() => rangeAround(quotePerBase(100), 0)).toThrow(RangeError);
    expect(() => rangeAround(quotePerBase(100), Number.NaN)).toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------------
// Calculations
// ---------------------------------------------------------------------------

describe('geometricCentre', () => {
  it('is the square root of the product of the bounds', () => {
    expect(geometricCentre(createRange(quotePerBase(4), quotePerBase(9)))).toBe(6);
  });

  it('does not overflow for a valid range with huge bounds (review #6, P2)', () => {
    const range = createRange(quotePerBase(1e200), quotePerBase(4e200));
    expect(geometricCentre(range)).toBeCloseTo(2e200, -195);
  });
});

describe('distanceToBounds', () => {
  it('gives the relative distance from the price to each bound', () => {
    // Same convention as the Orca UI: negative to the lower bound.
    const d = distanceToBounds(quotePerBase(96), NARROW.range);
    expect(d.toLower * 100).toBeCloseTo(-6.25, 4);
    expect(d.toUpper * 100).toBeCloseTo(4.1667, 4);
  });
});

describe('liquidity recovery and amounts at price', () => {
  const liquidity = liquidityFromQuote(NARROW.entryQuote, NARROW.entryPrice, NARROW.range);
  const position = createPosition(liquidity, NARROW.range);

  it('implies the base deposit from the quote deposit', () => {
    const { base } = amountsAtPrice(position, NARROW.entryPrice);
    // Full precision matters: a UI rounded to 4 dp is not a valid hold baseline.
    expect(base).toBeCloseTo(NARROW.impliedBase, 8);
  });

  it('gives the holdings at another in-range price', () => {
    const { quote, base } = amountsAtPrice(position, NARROW.observed.price);
    expect(quote).toBeCloseTo(NARROW.observed.quote, 4);
    expect(base).toBeCloseTo(NARROW.observed.base, 8);
  });

  it('recovers the same liquidity from either token', () => {
    const { base } = amountsAtPrice(position, NARROW.entryPrice);
    const fromBase = liquidityFromBase(base, NARROW.entryPrice, NARROW.range);
    expect(fromBase).toBeCloseTo(liquidity, 8);
  });

  it('is 100 % quote at or above the upper bound', () => {
    for (const price of [NARROW.range.upper, quotePerBase(NARROW.range.upper * 1.5)]) {
      const { base, quote } = amountsAtPrice(position, price);
      expect(base).toBeCloseTo(0, 12);
      expect(quote).toBeGreaterThan(NARROW.entryQuote);
    }
  });

  it('is 100 % base at or below the lower bound', () => {
    for (const price of [NARROW.range.lower, quotePerBase(NARROW.range.lower * 0.5)]) {
      const { base, quote } = amountsAtPrice(position, price);
      expect(quote).toBeCloseTo(0, 12);
      expect(base).toBeGreaterThan(NARROW.impliedBase);
    }
  });

  it('refuses to infer liquidity from a price on or outside the bounds', () => {
    expect(() => liquidityFromQuote(1, NARROW.range.lower, NARROW.range)).toThrow(
      PriceOutOfRangeError,
    );
    expect(() => liquidityFromBase(1, NARROW.range.upper, NARROW.range)).toThrow(
      PriceOutOfRangeError,
    );
  });

  it('refuses to return non-finite liquidity from valid inputs (review #6, P2)', () => {
    const range = createRange(quotePerBase(1), quotePerBase(9));
    // A huge deposit with the price a hair inside a bound makes the
    // denominator tiny and the quotient overflow.
    expect(() => liquidityFromQuote(1e308, quotePerBase(1.0001), range)).toThrow(
      NumericOverflowError,
    );
    expect(() => liquidityFromBase(1e308, quotePerBase(8.9999), range)).toThrow(
      NumericOverflowError,
    );
    // The reviewer's example overflows only for the base leg (denominator 1/2 − 1/3);
    // for the quote leg the denominator is exactly 1 and the result is finite.
    expect(liquidityFromQuote(1e308, quotePerBase(4), range)).toBe(1e308);
    expect(() => liquidityFromBase(1e308, quotePerBase(4), range)).toThrow(NumericOverflowError);
  });

  it('rejects non-positive deposits', () => {
    expect(() => liquidityFromQuote(0, NARROW.entryPrice, NARROW.range)).toThrow(
      InvalidAmountError,
    );
    expect(() => liquidityFromBase(-1, NARROW.entryPrice, NARROW.range)).toThrow(
      InvalidAmountError,
    );
  });
});

describe('a position opened at the geometric centre', () => {
  it('has near-equal value on each side at entry', () => {
    const liquidity = liquidityFromQuote(WIDE.entryQuote, WIDE.entryPrice, WIDE.range);
    const { base, quote } = amountsAtPrice(createPosition(liquidity, WIDE.range), WIDE.entryPrice);
    expect(base).toBeCloseTo(WIDE.entryBase, 5);
    expect((base * WIDE.entryPrice) / quote).toBeCloseTo(1, 1);
  });
});

describe('valueInQuote', () => {
  it('prices the base leg at the given price', () => {
    expect(valueInQuote(tokenAmounts(2, 5), quotePerBase(10))).toBe(25);
  });
});

describe('divergenceLoss', () => {
  const liquidity = liquidityFromQuote(NARROW.entryQuote, NARROW.entryPrice, NARROW.range);
  const position = createPosition(liquidity, NARROW.range);
  const deposit = amountsAtPrice(position, NARROW.entryPrice);

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
      expect(divergenceLoss(position, deposit, quotePerBase(price)) * 100).toBeCloseTo(pct, 2);
    }
  });

  it('is never positive', () => {
    for (let price = 60; price <= 140; price += 0.7) {
      expect(divergenceLoss(position, deposit, quotePerBase(price))).toBeLessThanOrEqual(1e-12);
    }
  });

  it('keeps growing (more negative) once out of range', () => {
    const atLower = divergenceLoss(position, deposit, NARROW.range.lower);
    const belowLower = divergenceLoss(position, deposit, quotePerBase(NARROW.range.lower * 0.9));
    expect(belowLower).toBeLessThan(atLower);
  });

  it('refuses to compute against an empty deposit', () => {
    const empty = createPosition(0, NARROW.range);
    expect(() => divergenceLoss(empty, tokenAmounts(0, 0), NARROW.entryPrice)).toThrow(
      EmptyDepositError,
    );
  });
});

describe('divergenceLossToEdgeFromCentre', () => {
  it('is -1.3340 % for the narrow range', () => {
    expect(divergenceLossToEdgeFromCentre(NARROW.range) * 100).toBeCloseTo(-1.334, 4);
  });

  it('is identical at both bounds by construction', () => {
    const range = rangeAround(quotePerBase(100), 0.05);
    const centre = geometricCentre(range);
    const position = createPosition(1, range);
    const deposit = amountsAtPrice(position, centre);
    const atLower = divergenceLoss(position, deposit, range.lower);
    const atUpper = divergenceLoss(position, deposit, range.upper);
    expect(atLower).toBeCloseTo(atUpper, 12);
    expect(divergenceLossToEdgeFromCentre(range)).toBeCloseTo(atUpper, 12);
  });

  it('grows roughly linearly with the half-width for narrow ranges', () => {
    // Full-range divergence loss grows with h², but concentration amplifies
    // it by ~1/h, so the loss to the edge of a narrow range grows ~linearly.
    const narrow = Math.abs(divergenceLossToEdgeFromCentre(rangeAround(quotePerBase(100), 0.02)));
    const wide = Math.abs(divergenceLossToEdgeFromCentre(rangeAround(quotePerBase(100), 0.04)));
    expect(wide / narrow).toBeGreaterThan(1.9);
    expect(wide / narrow).toBeLessThan(2.1);
  });
});

// ---------------------------------------------------------------------------
// Type-level guarantees
// ---------------------------------------------------------------------------

describe('type-level guarantees', () => {
  it('does not accept a raw number where a price is expected', () => {
    // @ts-expect-error — a bare number is not a QuotePerBase
    expect(() => amountsAtPrice(createPosition(1, NARROW.range), 97)).not.toThrow();
  });

  it('does not accept an object literal where a validated range is expected', () => {
    // @ts-expect-error — only createRange can produce a PriceRange
    expect(() => createPosition(1, { lower: 1, upper: 2 })).not.toThrow();
  });

  it('does not accept an object literal where validated amounts are expected', () => {
    // @ts-expect-error — only tokenAmounts can produce a TokenAmounts
    expect(() => valueInQuote({ base: 1, quote: 1 }, quotePerBase(10))).not.toThrow();
  });
});
