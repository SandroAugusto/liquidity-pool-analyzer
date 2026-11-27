import { describe, expect, it } from 'vitest';

import type { PriceSeries } from '../../src/research/exit-time.js';
import {
  gaussianWalk,
  seededUniform,
  shuffled,
  signFlipped,
} from '../../src/research/surrogates.js';

const returnsOf = (s: PriceSeries): number[] =>
  s.prices.slice(1).map((p, i) => Math.log(p / (s.prices[i] ?? 1)));

function walk(n: number): PriceSeries {
  const uniform = seededUniform(99);
  const prices = [100];
  for (let i = 1; i < n; i++) {
    prices.push(
      (prices[i - 1] ?? 100) * Math.exp((uniform() - 0.5) * 0.02 * (i % 50 < 10 ? 5 : 1)),
    );
  }
  return { timesSeconds: prices.map((_, i) => i * 3600), prices };
}

describe('seededUniform', () => {
  it('is deterministic per seed and stays in [0, 1)', () => {
    const a = seededUniform(1);
    const b = seededUniform(1);
    const c = seededUniform(2);
    const xs = Array.from({ length: 1000 }, () => a());
    expect(xs).toEqual(Array.from({ length: 1000 }, () => b()));
    expect(xs).not.toEqual(Array.from({ length: 1000 }, () => c()));
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...xs)).toBeLessThan(1);
    // Mean of 1000 uniforms: standard error ≈ 0.009.
    expect(xs.reduce((s, x) => s + x, 0) / xs.length).toBeCloseTo(0.5, 1);
  });

  it('rejects a non-integer seed', () => {
    expect(() => seededUniform(1.5)).toThrow(RangeError);
  });
});

describe('surrogates', () => {
  const series = walk(2000);
  const original = returnsOf(series);

  it('sign flipping keeps each return size in place and the first price and times', () => {
    const s = signFlipped(series, 3);
    const r = returnsOf(s);
    expect(s.timesSeconds).toEqual(series.timesSeconds);
    expect(s.prices[0]).toBe(100);
    r.forEach((x, i) => {
      expect(Math.abs(x)).toBeCloseTo(Math.abs(original[i] ?? 0), 12);
    });
    const flips = r.filter((x, i) => Math.sign(x) !== Math.sign(original[i] ?? 0)).length;
    // Binomial(1999, 1/2): standard deviation ≈ 22.
    expect(flips).toBeGreaterThan(900);
    expect(flips).toBeLessThan(1100);
  });

  it('shuffling keeps the set of returns and changes their order', () => {
    const r = returnsOf(shuffled(series, 3));
    const sorted = (xs: number[]): number[] => [...xs].sort((a, b) => a - b);
    const expected = sorted(original);
    sorted(r).forEach((x, i) => {
      expect(x).toBeCloseTo(expected[i] ?? 0, 12);
    });
    expect(r).not.toEqual(original);
  });

  it('the Gaussian walk has the input standard deviation per step', () => {
    const r = returnsOf(gaussianWalk(series, 3));
    const sd = (xs: number[]): number => {
      const m = xs.reduce((a, x) => a + x, 0) / xs.length;
      return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / xs.length);
    };
    // Standard error of a standard deviation from 1999 normals ≈ 1.6 %.
    expect(sd(r) / sd(original)).toBeGreaterThan(0.95);
    expect(sd(r) / sd(original)).toBeLessThan(1.05);
  });

  it('is deterministic for a seed', () => {
    expect(shuffled(series, 5)).toEqual(shuffled(series, 5));
    expect(signFlipped(series, 5)).toEqual(signFlipped(series, 5));
    expect(gaussianWalk(series, 5)).toEqual(gaussianWalk(series, 5));
  });

  it('handles empty and one-sample series, and rejects mismatched lengths', () => {
    const empty: PriceSeries = { timesSeconds: [], prices: [] };
    const one: PriceSeries = { timesSeconds: [0], prices: [7] };
    for (const make of [signFlipped, shuffled, gaussianWalk]) {
      expect(make(empty, 1)).toEqual(empty);
      expect(make(one, 1)).toEqual(one);
      expect(() => make({ timesSeconds: [0, 1], prices: [1] }, 1)).toThrow(RangeError);
    }
    const two: PriceSeries = { timesSeconds: [0, 1], prices: [1, 2] };
    expect(gaussianWalk(two, 1).prices).toHaveLength(2);
  });
});
