import { describe, expect, it } from 'vitest';

import {
  InsufficientDataError,
  NumericOverflowError,
  amortisedDivergenceCostPerDay,
  dailyVolatility,
  expectedDaysToExit,
  halfWidthForHorizon,
  logReturns,
  mean,
  standardDeviation,
} from '../../src/math/volatility.js';

/**
 * Daily closes, 2026-09-18 → 2026-10-17 (30 points), public market data.
 * SOL from CoinCodex, BTC from Coinranking; sampling cut-offs
 * differ slightly between the two sources, which inflates σ marginally.
 */
const SOL_USD = [
  112.67, 111.03, 111.16, 118.53, 118.44, 114.94, 117.06, 122.02, 121.4, 122.1, 118.9, 119.08,
  118.05, 118.41, 118.66, 119.65, 121.51, 120.7, 120.89, 116.25, 109.73, 109.25, 110.1, 111.27,
  105.66, 106.76, 104.08, 105.4, 104.32, 103.34,
] as const;

const BTC_USD = [
  80912.68, 81281.4, 81177.45, 86601.59, 86184.33, 84398.89, 84410.59, 84071.5, 84457.8, 84482.31,
  83533.65, 83655.06, 83595.17, 84870.02, 84526.69, 84751.24, 86507.2, 85795.89, 85570.58, 83316.62,
  81732.26, 82626.81, 82988.24, 83751.24, 81853.36, 83166.43, 81648.17, 82233.51, 81604.74,
  81483.75,
] as const;

const SOL_PER_WBTC = BTC_USD.map((btc, i) => {
  const sol = SOL_USD[i];
  if (sol === undefined) {
    throw new Error('fixture length mismatch');
  }
  return btc / sol;
});

describe('logReturns', () => {
  it('computes ln(p[i+1]/p[i])', () => {
    expect(logReturns([1, Math.E, Math.E ** 2])).toEqual([1, 1]);
  });

  it('requires at least two prices', () => {
    expect(() => logReturns([1])).toThrow(InsufficientDataError);
    expect(() => logReturns([])).toThrow(InsufficientDataError);
  });

  it('rejects non-positive prices', () => {
    expect(() => logReturns([1, 0])).toThrow(RangeError);
    expect(() => logReturns([1, -2])).toThrow(RangeError);
  });

  it('stays finite for extreme but finite magnitudes (review #1, P1)', () => {
    // log(1e300 / 1e-300) overflows the quotient to Infinity; log(a) - log(b) does not.
    const [r] = logReturns([1e-300, 1e300]);
    expect(r).toBeDefined();
    expect(Number.isFinite(r)).toBe(true);
    expect(r).toBeCloseTo(600 * Math.LN10, 6);
  });
});

describe('mean and standardDeviation', () => {
  const sample = [2, 4, 4, 4, 5, 5, 7, 9];

  it('computes the population standard deviation (divide by n)', () => {
    expect(mean(sample)).toBe(5);
    expect(standardDeviation(sample, 'population')).toBe(2);
  });

  it('computes the sample standard deviation (divide by n − 1)', () => {
    expect(standardDeviation(sample, 'sample')).toBeCloseTo(2.138, 3);
  });

  it('is zero for a constant series under either estimator', () => {
    expect(standardDeviation([3, 3, 3], 'population')).toBe(0);
    expect(standardDeviation([3, 3, 3], 'sample')).toBe(0);
  });

  it('rejects non-finite elements instead of returning NaN (review #1, P1)', () => {
    expect(() => mean([1, Number.NaN])).toThrow(RangeError);
    expect(() => mean([1, Number.POSITIVE_INFINITY])).toThrow(RangeError);
    expect(() => standardDeviation([1, Number.NaN], 'population')).toThrow(RangeError);
    expect(() => standardDeviation([1, Number.POSITIVE_INFINITY], 'sample')).toThrow(RangeError);
  });

  it('does not overflow the mean for large finite inputs (review #1, P2)', () => {
    expect(mean([1e308, 1e308])).toBe(1e308);
    expect(mean([Number.MAX_VALUE, Number.MAX_VALUE, Number.MAX_VALUE])).toBe(Number.MAX_VALUE);
  });

  it('is exactly zero for a constant series at the top of the double range', () => {
    expect(standardDeviation([1e308, 1e308], 'population')).toBe(0);
  });

  it('throws rather than returning a non-finite standard deviation', () => {
    expect(() => standardDeviation([-1e308, 1e308], 'population')).toThrow(NumericOverflowError);
  });

  it('rejects empty input, and a single point for the sample estimator', () => {
    expect(() => mean([])).toThrow(InsufficientDataError);
    expect(() => standardDeviation([], 'population')).toThrow(InsufficientDataError);
    expect(() => standardDeviation([1], 'sample')).toThrow(InsufficientDataError);
    expect(standardDeviation([1], 'population')).toBe(0);
  });
});

describe('dailyVolatility on the real SOL/WBTC series', () => {
  it('is ≈1.48 %/day with the sample estimator', () => {
    // The population figure is 1.46 %. The sample estimator is √(29/28) ≈ 1.8 %
    // higher, far inside the model's own uncertainty, but the two must not be
    // mixed silently.
    expect(dailyVolatility(SOL_PER_WBTC) * 100).toBeCloseTo(1.48, 2);
    expect(standardDeviation(logReturns(SOL_PER_WBTC), 'population') * 100).toBeCloseTo(1.46, 2);
  });

  it('is lower than the volatility of either leg in USD', () => {
    const ratio = dailyVolatility(SOL_PER_WBTC);
    expect(ratio).toBeLessThan(dailyVolatility([...SOL_USD]));
    expect(ratio).toBeLessThan(dailyVolatility([...BTC_USD]));
  });
});

describe('expectedDaysToExit and halfWidthForHorizon', () => {
  it('give ≈ 7.5 days for ±4 % at σ = 1.46 %', () => {
    expect(expectedDaysToExit(0.04, 0.0146)).toBeCloseTo(7.506, 3);
  });

  it('are inverses of each other', () => {
    const sigma = 0.0146;
    const days = 25;
    const hw = halfWidthForHorizon(days, sigma);
    expect(hw).toBeCloseTo(0.073, 3);
    expect(expectedDaysToExit(hw, sigma)).toBeCloseTo(days, 9);
  });

  it('reject non-positive inputs', () => {
    expect(() => expectedDaysToExit(0, 0.01)).toThrow(RangeError);
    expect(() => expectedDaysToExit(0.05, 0)).toThrow(RangeError);
    expect(() => halfWidthForHorizon(-1, 0.01)).toThrow(RangeError);
    expect(() => halfWidthForHorizon(10, Number.NaN)).toThrow(RangeError);
  });
});

describe('amortisedDivergenceCostPerDay', () => {
  it('spreads the per-exit loss over the expected cycle: 1.2 % / 8 d = 0.15 %/d', () => {
    expect(amortisedDivergenceCostPerDay(-0.012, 8) * 100).toBeCloseTo(0.15, 2);
  });

  it('is sign-agnostic on the loss and positive on output', () => {
    expect(amortisedDivergenceCostPerDay(0.012, 6)).toBeCloseTo(
      amortisedDivergenceCostPerDay(-0.012, 6),
      12,
    );
  });

  it('rejects a non-positive horizon or a non-finite loss', () => {
    expect(() => amortisedDivergenceCostPerDay(0.01, 0)).toThrow(RangeError);
    expect(() => amortisedDivergenceCostPerDay(Number.NaN, 5)).toThrow(RangeError);
  });
});
