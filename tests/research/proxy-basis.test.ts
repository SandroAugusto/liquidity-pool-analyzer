/**
 * Basis between the reference cross price and pool prices. Pool addresses are
 * public protocol accounts; prices and liquidity are synthetic. Expected values
 * were computed separately (Python `math.log` / `math.sqrt`), not with this
 * module.
 */

import { describe, expect, it } from 'vitest';

import { quotePerBase, tokenAmounts } from '../../src/math/index.js';
import type { PoolSnapshot } from '../../src/research/fee-snapshots.js';
import { matchBasis, nearestRank, summarizeBasis } from '../../src/research/proxy-basis.js';
import type { BasisObservation } from '../../src/research/proxy-basis.js';

const DEEP = 'B5EwJVDuAauzUEEdwvbuXzbFFgEYnUqqS37TUM1c4PQA';
const THIN = '3JeYSHtmYsfCjSq4FT6P2wRDuoQDasw1SyPTL8xVGMfA';

function snapshot(
  pool: string,
  observedAt: string,
  price: number,
  liquidity: number,
): PoolSnapshot {
  return {
    observedAt: new Date(observedAt),
    reading: {
      source: { protocol: 'orca-whirlpool', pool },
      pair: {
        base: { mint: '3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh', decimals: 8 },
        quote: { mint: 'So11111111111111111111111111111111111111112', decimals: 9 },
      },
      price: quotePerBase(price),
      liquidity,
      feeGrowthPerLiquidity: tokenAmounts(0, 0),
      feeRate: 0.0005,
      slot: 1n,
    },
  };
}

const s = (iso: string): number => Date.parse(iso) / 1000;

describe('matchBasis', () => {
  // Bucket starting 18:09 closes at 18:10, before an observation at 18:10:18;
  // the bucket starting 18:10 closes after it and must not be used.
  const reference = {
    timesSeconds: [s('2026-11-27T18:09:00Z'), s('2026-11-27T18:10:00Z')],
    prices: [832.84, 999],
  };

  it('uses the last close at or before the snapshot', () => {
    const { observations } = matchBasis(
      [snapshot(DEEP, '2026-11-27T18:10:18.801Z', 833.41, 7848)],
      reference,
      60,
    );
    expect(observations).toHaveLength(1);
    const [o] = observations;
    expect(o?.referencePrice).toBe(832.84);
    expect(o?.referenceAtSeconds).toBe(s('2026-11-27T18:10:00Z'));
    expect(o?.logBasis).toBeCloseTo(0.0006841710694485142, 15);
  });

  it('skips pools with no active liquidity and times with no reference', () => {
    const result = matchBasis(
      [
        snapshot(THIN, '2026-11-27T18:10:18Z', 461.04, 0),
        snapshot(DEEP, '2026-11-27T19:10:18Z', 833, 1),
      ],
      reference,
      60,
    );
    expect(result).toEqual({ observations: [], skippedNoLiquidity: 1, skippedNoReference: 1 });
  });

  it('refuses a bad step or a malformed reference', () => {
    expect(() => matchBasis([], reference, 0)).toThrow(RangeError);
    expect(() => matchBasis([], reference, 1.5)).toThrow(RangeError);
    expect(() => matchBasis([], { timesSeconds: [0], prices: [] }, 60)).toThrow(RangeError);
  });
});

function obs(
  pool: string,
  t: number,
  logBasis: number,
  referencePrice: number,
  liquidity: number,
): BasisObservation {
  return {
    pool,
    feeRate: 0.0005,
    liquidity,
    observedAtSeconds: t,
    referenceAtSeconds: t,
    poolPrice: referencePrice * Math.exp(logBasis),
    referencePrice,
    logBasis,
  };
}

describe('summarizeBasis', () => {
  it('summarises levels and changes per pool, deepest first', () => {
    const summaries = summarizeBasis([
      obs(THIN, 0, 0.02, 100, 1),
      // Out of order and with a repeated time: sorted, and counted once.
      obs(DEEP, 7200, -0.002, 99, 900),
      obs(DEEP, 0, 0.001, 100, 1000),
      obs(DEEP, 3600, 0.003, 101, 1100),
      obs(DEEP, 3600, 0.003, 101, 1100),
    ]);
    expect(summaries.map((x) => x.pool)).toEqual([DEEP, THIN]);
    const [deep, thin] = summaries;
    expect(deep?.observations).toBe(3);
    expect(deep?.medianLiquidity).toBe(1000);
    expect(deep?.medianLogBasis).toBe(0.001);
    expect(deep?.p05LogBasis).toBe(-0.002);
    expect(deep?.p95LogBasis).toBe(0.003);
    expect(deep?.maxAbsLogBasis).toBe(0.003);
    expect(deep?.intervals).toBe(2);
    // √(((0.003 − 0.001)² + (−0.002 − 0.003)²) / 2)
    expect(deep?.rmsBasisChange).toBeCloseTo(0.003807886552931954, 15);
    // √((ln(101/100)² + ln(99/101)²) / 2)
    expect(deep?.rmsReferenceReturn).toBeCloseTo(0.015796134856330968, 15);
    expect(thin?.intervals).toBe(0);
    expect(thin?.rmsBasisChange).toBeNull();
    expect(thin?.rmsReferenceReturn).toBeNull();
  });

  it('returns nothing for no observations', () => {
    expect(summarizeBasis([])).toEqual([]);
  });
});

describe('nearestRank', () => {
  const tenValues = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  it('picks the nearest-rank quantile', () => {
    expect(nearestRank(tenValues, 0)).toBe(1);
    expect(nearestRank(tenValues, 0.05)).toBe(1);
    expect(nearestRank(tenValues, 0.5)).toBe(5);
    expect(nearestRank(tenValues, 0.95)).toBe(10);
    expect(nearestRank(tenValues, 1)).toBe(10);
  });
  it('refuses an empty array or p outside [0, 1]', () => {
    expect(() => nearestRank([], 0.5)).toThrow(RangeError);
    expect(() => nearestRank(tenValues, 1.1)).toThrow(RangeError);
    expect(() => nearestRank(tenValues, Number.NaN)).toThrow(RangeError);
  });
});
