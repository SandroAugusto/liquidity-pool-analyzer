import { describe, expect, it } from 'vitest';

import type { PriceSeries } from '../../src/research/exit-time.js';
import { forecastError, sigmaForecasts, varianceRatio } from '../../src/research/structure.js';
import type { SigmaForecastRow } from '../../src/research/structure.js';
import { gaussianWalk } from '../../src/research/surrogates.js';

const HOUR = 3600;
const DAY = 86_400;

function fromReturns(returns: readonly number[], start = 0): PriceSeries {
  const prices = [1];
  for (const r of returns) {
    prices.push((prices[prices.length - 1] ?? 1) * Math.exp(r));
  }
  return { timesSeconds: prices.map((_, i) => start + i * HOUR), prices };
}

describe('varianceRatio', () => {
  it('is 0 at k = 2 when every move reverses', () => {
    const alternating = fromReturns(
      Array.from({ length: 200 }, (_, i) => (i % 2 === 0 ? 0.01 : -0.01)),
    );
    expect(varianceRatio(alternating, HOUR, 2)).toBeCloseTo(0, 12);
  });

  it('is close to 1 for a Gaussian walk', () => {
    const base = fromReturns(
      Array.from({ length: 20_000 }, (_, i) => (i % 2 === 0 ? 0.01 : -0.01)),
    );
    const walk = gaussianWalk(base, 4);
    expect(varianceRatio(walk, HOUR, 24)).toBeGreaterThan(0.85);
    expect(varianceRatio(walk, HOUR, 24)).toBeLessThan(1.15);
  });

  it('never bridges a gap', () => {
    // One-step returns of ±0.01 except across a missing sample, which would
    // otherwise create a two-step return of 0.
    const full = fromReturns(Array.from({ length: 9 }, (_, i) => (i % 2 === 0 ? 0.01 : -0.01)));
    const gapped: PriceSeries = {
      timesSeconds: full.timesSeconds.filter((_, i) => i !== 5),
      prices: full.prices.filter((_, i) => i !== 5),
    };
    // Two-step returns: pairs (0,2) (1,3) (2,4) (5→ missing) (6,8): all 0.
    expect(varianceRatio(gapped, HOUR, 2)).toBeCloseTo(0, 12);
  });

  it('rejects invalid steps, horizons and flat series', () => {
    const s = fromReturns([0.01, -0.01, 0.02]);
    expect(() => varianceRatio(s, 0, 2)).toThrow(RangeError);
    expect(() => varianceRatio(s, HOUR, 1)).toThrow(RangeError);
    expect(() => varianceRatio(s, HOUR, 2.5)).toThrow(RangeError);
    expect(() => varianceRatio(fromReturns([0, 0, 0]), HOUR, 2)).toThrow(RangeError);
  });
});

describe('sigmaForecasts', () => {
  // 10 days of ±1 % hourly moves, then 3 days of ±2 %, starting at midnight.
  const returns = Array.from(
    { length: 13 * 24 },
    (_, i) => (i % 2 === 0 ? 1 : -1) * (i < 10 * 24 ? 0.01 : 0.02),
  );
  const series = fromReturns(returns, 100 * DAY);
  const rows = sigmaForecasts(series, {
    stepSeconds: HOUR,
    shortDays: 2,
    longDays: 7,
    aheadDays: 3,
  });

  it('uses only whole days with full windows on both sides', () => {
    expect(rows.map((r) => (r.atSeconds - 100 * DAY) / DAY)).toEqual([7, 8, 9, 10]);
  });

  it('measures the jump in σ', () => {
    const atTen = rows.find((r) => r.atSeconds === 110 * DAY);
    // Alternating ±a over n returns: sample σ = a·√(n / (n − 1)) per hour.
    expect(atTen?.trailingShort).toBeCloseTo(0.01 * Math.sqrt(48 / 47) * Math.sqrt(24), 12);
    expect(atTen?.trailingLong).toBeCloseTo(0.01 * Math.sqrt(168 / 167) * Math.sqrt(24), 12);
    expect(atTen?.realisedAhead).toBeCloseTo(0.02 * Math.sqrt(72 / 71) * Math.sqrt(24), 12);
  });

  it('skips windows with too many gaps', () => {
    const holed: PriceSeries = {
      timesSeconds: series.timesSeconds.filter((_, i) => i < 200 || i > 230),
      prices: series.prices.filter((_, i) => i < 200 || i > 230),
    };
    const kept = sigmaForecasts(holed, {
      stepSeconds: HOUR,
      shortDays: 2,
      longDays: 7,
      aheadDays: 3,
    });
    expect(kept.length).toBeLessThan(rows.length);
  });

  it('rejects non-positive or non-integer options', () => {
    expect(() =>
      sigmaForecasts(series, { stepSeconds: HOUR, shortDays: 0, longDays: 7, aheadDays: 3 }),
    ).toThrow(RangeError);
    expect(() =>
      sigmaForecasts(series, { stepSeconds: 1.5, shortDays: 2, longDays: 7, aheadDays: 3 }),
    ).toThrow(RangeError);
  });
});

describe('forecastError', () => {
  const row = (forecast: number, realised: number): SigmaForecastRow => ({
    atSeconds: 0,
    trailingShort: forecast,
    trailingLong: forecast,
    realisedAhead: realised,
  });

  it('gives the median and root mean square of ln(forecast / realised)', () => {
    const odd = [row(2, 1), row(1, 1), row(1, 2)];
    expect(forecastError(odd, (r) => r.trailingShort)).toEqual({
      count: 3,
      medianLogError: 0,
      rmsLogError: Math.sqrt((2 * Math.LN2 ** 2) / 3),
    });
    const even = [row(2, 1), row(4, 1)];
    expect(forecastError(even, (r) => r.trailingShort)?.medianLogError).toBeCloseTo(
      1.5 * Math.LN2,
      12,
    );
  });

  it('is null for no rows', () => {
    expect(forecastError([], (r) => r.trailingShort)).toBeNull();
  });
});
