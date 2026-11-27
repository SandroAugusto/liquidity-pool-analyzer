/**
 * Fees of synthetic positions from pool readings. Readings are synthetic; each
 * expectation is computed by hand or through `src/math`'s amounts, an
 * implementation independent of the closed form used here.
 */

import { describe, expect, it } from 'vitest';

import {
  amountsAtPrice,
  createPosition,
  createRange,
  quotePerBase,
  tokenAmounts,
  valueInQuote,
} from '../../src/math/index.js';
import type { PoolReading } from '../../src/positions/index.js';
import {
  FeeGrowthDecreasedError,
  ReadingMismatchError,
  centredValuePerLiquidity,
  feeReturnUntilExit,
  feesPerLiquidityBetween,
} from '../../src/research/fee-growth.js';

const BASE = { mint: 'base-mint', decimals: 8 };
const QUOTE = { mint: 'quote-mint', decimals: 9 };

function reading(
  slot: number,
  price: number,
  growthBase: number,
  growthQuote: number,
  over: Partial<PoolReading> = {},
): PoolReading {
  return {
    source: { protocol: 'orca-whirlpool', pool: 'pool' },
    pair: { base: BASE, quote: QUOTE },
    price: quotePerBase(price),
    liquidity: 1000,
    feeGrowthPerLiquidity: tokenAmounts(growthBase, growthQuote),
    feeRate: 0.0005,
    slot: BigInt(slot),
    ...over,
  };
}

describe('centredValuePerLiquidity', () => {
  it('is 2√P(1 − e^(−h/2)): 0.199003… at P = 100, h = 0.02 (by hand)', () => {
    expect(centredValuePerLiquidity(quotePerBase(100), 0.02)).toBeCloseTo(
      20 * (1 - Math.exp(-0.01)),
      13,
    );
    expect(centredValuePerLiquidity(quotePerBase(100), 0.02)).toBeCloseTo(0.199003325017, 12);
  });

  it.each([
    [846.2, 0.01],
    [846.2, 0.08],
    [0.0012, 0.04],
    [3.5e6, 0.5],
  ])('matches src/math amounts for P = %d, h = %d', (p, h) => {
    const price = quotePerBase(p);
    const range = createRange(quotePerBase(p * Math.exp(-h)), quotePerBase(p * Math.exp(h)));
    const viaMath = valueInQuote(amountsAtPrice(createPosition(1, range), price), price);
    expect(centredValuePerLiquidity(price, h) / viaMath).toBeCloseTo(1, 12);
  });

  it.each([0, -0.01, Number.NaN, Number.POSITIVE_INFINITY])('refuses half-width %d', (h) => {
    expect(() => centredValuePerLiquidity(quotePerBase(100), h)).toThrow(RangeError);
  });
});

describe('feesPerLiquidityBetween', () => {
  it('is the change in fee growth', () => {
    const fees = feesPerLiquidityBetween(reading(1, 100, 0.5, 2), reading(2, 101, 0.75, 2.5));
    expect(fees.base).toBeCloseTo(0.25, 15);
    expect(fees.quote).toBeCloseTo(0.5, 15);
  });

  it('allows no growth', () => {
    expect(feesPerLiquidityBetween(reading(1, 100, 1, 1), reading(2, 100, 1, 1))).toEqual({
      base: 0,
      quote: 0,
    });
  });

  it('refuses fee growth that went down, on either side', () => {
    expect(() => feesPerLiquidityBetween(reading(1, 100, 1, 1), reading(2, 100, 0.9, 1))).toThrow(
      FeeGrowthDecreasedError,
    );
    expect(() => feesPerLiquidityBetween(reading(1, 100, 1, 1), reading(2, 100, 1, 0.9))).toThrow(
      /decreased between slots 1 and 2/,
    );
  });

  it('refuses readings out of slot order or of the same slot', () => {
    expect(() => feesPerLiquidityBetween(reading(2, 100, 1, 1), reading(1, 100, 2, 2))).toThrow(
      ReadingMismatchError,
    );
    expect(() => feesPerLiquidityBetween(reading(2, 100, 1, 1), reading(2, 100, 2, 2))).toThrow(
      ReadingMismatchError,
    );
  });

  it('refuses readings of different pools or pairs', () => {
    const other = reading(2, 100, 2, 2, { source: { protocol: 'orca-whirlpool', pool: 'other' } });
    expect(() => feesPerLiquidityBetween(reading(1, 100, 1, 1), other)).toThrow(/different pools/);
    const flipped = reading(2, 100, 2, 2, { pair: { base: QUOTE, quote: BASE } });
    expect(() => feesPerLiquidityBetween(reading(1, 100, 1, 1), flipped)).toThrow(
      /base and quote differ/,
    );
  });
});

describe('feeReturnUntilExit', () => {
  const h = 0.02; // bounds 100·e^(∓0.02) = 98.0199 and 102.0201
  const value = 20 * (1 - Math.exp(-0.01));

  it('accumulates fees valued at each closing price until the series ends', () => {
    const series = [
      reading(1, 100, 0, 0),
      reading(2, 101, 0.001, 0.05), // 0.001·101 + 0.05 = 0.151
      reading(3, 99, 0.001, 0.15), // 0 · 99 + 0.1 = 0.1
    ];
    const result = feeReturnUntilExit(series, h);
    expect(result.intervals).toBe(2);
    expect(result.exited).toBe(false);
    expect(result.feeReturn).toBeCloseTo((0.151 + 0.1) / value, 12);
  });

  it('stops at the first reading beyond a bound and does not count that interval', () => {
    const series = [
      reading(1, 100, 0, 0),
      reading(2, 101, 0, 0.05),
      reading(3, 102.5, 0, 0.5),
      reading(4, 100, 0, 0.6),
    ];
    const result = feeReturnUntilExit(series, h);
    expect(result.intervals).toBe(1);
    expect(result.exited).toBe(true);
    expect(result.feeReturn).toBeCloseTo(0.05 / value, 12);
  });

  it('counts a reading exactly on a bound as an exit', () => {
    const lower = quotePerBase(100 * Math.exp(-h));
    const result = feeReturnUntilExit([reading(1, 100, 0, 0), reading(2, lower, 0, 0.05)], h);
    expect(result).toEqual({ feeReturn: 0, intervals: 0, exited: true });
  });

  it('is zero for a single reading and refuses an empty series', () => {
    expect(feeReturnUntilExit([reading(1, 100, 1, 1)], h)).toEqual({
      feeReturn: 0,
      intervals: 0,
      exited: false,
    });
    expect(() => feeReturnUntilExit([], h)).toThrow(RangeError);
  });

  it('refuses a series whose fee growth goes down', () => {
    expect(() => feeReturnUntilExit([reading(1, 100, 1, 1), reading(2, 100, 1, 0)], h)).toThrow(
      FeeGrowthDecreasedError,
    );
  });

  it('scales as 1/h for the same fees: a narrower range earns more per unit of value', () => {
    const series = [reading(1, 100, 0, 0), reading(2, 100, 0, 0.01)];
    const narrow = feeReturnUntilExit(series, 0.01).feeReturn;
    const wide = feeReturnUntilExit(series, 0.04).feeReturn;
    // value ≈ √P · h for small h, so the ratio is close to 4 (exactly (1−e^-0.02)/(1−e^-0.005)).
    expect(narrow / wide).toBeCloseTo((1 - Math.exp(-0.02)) / (1 - Math.exp(-0.005)), 12);
  });
});
