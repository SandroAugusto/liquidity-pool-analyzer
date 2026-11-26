import { describe, expect, it } from 'vitest';

import {
  PriceOutOfRangeError,
  createRange,
  divergenceLossToEdgeFromCentre,
  geometricCentre,
} from '../../src/math/clmm.js';
import { quotePerBase } from '../../src/math/price.js';
import {
  breakevenVolatility,
  costPerRemount,
  expectedDaysToExitFrom,
  feeConstant,
  feeToCostRatio,
  logHalfWidth,
  remountCostPerDay,
} from '../../src/math/rebalance.js';

const p = quotePerBase;

/**
 * Synthetic ranges on an abstract pair, with round numbers chosen for the
 * tests. They do not describe any real position (AGENTS.md, "No private position
 * data"). σ, fee and swap inputs are arbitrary.
 */
const RANGE_A = createRange(p(90), p(100));
const RANGE_B = createRange(p(85), p(105));

/**
 * Expected values below were computed independently in Python from the
 * closed-form formulas, not by running this implementation.
 */
describe('logHalfWidth', () => {
  it('is ln(upper / lower) / 2', () => {
    expect(logHalfWidth(RANGE_A)).toBeCloseTo(0.0526803, 6);
  });

  it('does not overflow when upper / lower would', () => {
    const r = createRange(p(Number.MIN_VALUE), p(Number.MAX_VALUE));
    expect(Number.isFinite(logHalfWidth(r))).toBe(true);
  });
});

describe('expectedDaysToExitFrom', () => {
  it('equals hL² / σ² at the geometric centre', () => {
    const sigma = 0.015;
    const hL = logHalfWidth(RANGE_A);
    expect(expectedDaysToExitFrom(geometricCentre(RANGE_A), RANGE_A, sigma)).toBeCloseTo(
      (hL / sigma) ** 2,
      9,
    );
  });

  it('is shorter off-centre: 5.70 days at 97 against 6.94 at the centre (σ 2 %)', () => {
    expect(expectedDaysToExitFrom(p(97), RANGE_A, 0.02)).toBeCloseTo(5.7036, 3);
    expect(expectedDaysToExitFrom(geometricCentre(RANGE_A), RANGE_A, 0.02)).toBeCloseTo(6.938, 3);
  });

  it('gives 11.71 days at 96 with σ 1.5 %', () => {
    expect(expectedDaysToExitFrom(p(96), RANGE_A, 0.015)).toBeCloseTo(11.7093, 3);
  });

  it('matches a Monte Carlo of a driftless walk from the centre', () => {
    // Seeded LCG + Box–Muller, so the test is deterministic. Range ±10 % in log,
    // σ = 1 %/day, 0.01-day steps: E[T] = 0.1² / 0.01² = 100 days.
    let seed = 42;
    const uniform = (): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return (seed + 1) / 4294967297;
    };
    const normal = (): number =>
      Math.sqrt(-2 * Math.log(uniform())) * Math.cos(2 * Math.PI * uniform());
    const range = createRange(p(100 * Math.exp(-0.1)), p(100 * Math.exp(0.1)));
    const sigma = 0.01;
    const dt = 0.01;
    const paths = 2000;
    let total = 0;
    for (let i = 0; i < paths; i++) {
      let x = 0;
      let t = 0;
      while (Math.abs(x) < 0.1) {
        x += sigma * Math.sqrt(dt) * normal();
        t += dt;
      }
      total += t;
    }
    const expected = expectedDaysToExitFrom(p(100), range, sigma);
    expect(expected).toBeCloseTo(100, 9);
    // Discrete steps overshoot the boundary slightly late; 2000 paths give a
    // standard error of about 1.5 %.
    expect(total / paths / expected).toBeGreaterThan(0.95);
    expect(total / paths / expected).toBeLessThan(1.07);
  });

  it('is symmetric in log-price around the centre', () => {
    const c = geometricCentre(RANGE_B);
    const above = p(c * 1.02);
    const below = p((c * c) / above);
    expect(expectedDaysToExitFrom(above, RANGE_B, 0.0125)).toBeCloseTo(
      expectedDaysToExitFrom(below, RANGE_B, 0.0125),
      9,
    );
  });

  it('refuses a price at or outside a bound', () => {
    expect(() => expectedDaysToExitFrom(p(90), RANGE_A, 0.01)).toThrow(PriceOutOfRangeError);
    expect(() => expectedDaysToExitFrom(p(100), RANGE_A, 0.01)).toThrow(PriceOutOfRangeError);
    expect(() => expectedDaysToExitFrom(p(110), RANGE_A, 0.01)).toThrow(PriceOutOfRangeError);
  });

  it('refuses a non-positive or non-finite σ', () => {
    expect(() => expectedDaysToExitFrom(p(95), RANGE_A, 0)).toThrow(RangeError);
    expect(() => expectedDaysToExitFrom(p(95), RANGE_A, Number.NaN)).toThrow(RangeError);
  });
});

describe('costPerRemount', () => {
  it('is the divergence loss to the edge plus the swap', () => {
    const loss = Math.abs(divergenceLossToEdgeFromCentre(RANGE_A));
    expect(loss).toBeCloseTo(0.01334042, 7);
    expect(costPerRemount(RANGE_A, 0.0005)).toBeCloseTo(loss + 0.0005, 12);
  });

  it('refuses a negative or non-finite swap cost', () => {
    expect(() => costPerRemount(RANGE_A, -0.0001)).toThrow(RangeError);
    expect(() => costPerRemount(RANGE_A, Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });
});

describe('remountCostPerDay and feeToCostRatio', () => {
  const inputsA = { range: RANGE_A, sigmaPerDay: 0.015, swapCostPerRemount: 0.0005 };

  it('gives 0.112 %/day at σ 1.5 % with a 0.05 % swap', () => {
    expect(remountCostPerDay(inputsA) * 100).toBeCloseTo(0.11221, 4);
  });

  it('gives a fee/cost ratio of 2.67 at 0.3 %/day of fees', () => {
    expect(feeToCostRatio(0.003, inputsA)).toBeCloseTo(2.6735, 3);
  });

  it('is zero with no fees', () => {
    expect(feeToCostRatio(0, inputsA)).toBe(0);
  });

  it('refuses a negative fee rate', () => {
    expect(() => feeToCostRatio(-0.001, inputsA)).toThrow(RangeError);
  });
});

describe('feeConstant', () => {
  it('is fee · hL / σ', () => {
    expect(feeConstant(0.003, RANGE_A, 0.015)).toBeCloseTo(0.0105361, 6);
  });

  it('is comparable across widths: a wide range earning less per day', () => {
    const wide = createRange(p(80), p(125));
    expect(feeConstant(0.0006, wide, 0.02)).toBeCloseTo(0.0066943, 6);
  });
});

describe('breakevenVolatility', () => {
  it('is ≈ 4k for any realistic width when the swap is free', () => {
    const k = 0.005;
    for (const halfWidth of [0.005, 0.04, 0.08, 0.15, 0.3]) {
      const range = createRange(p(1000 / (1 + halfWidth)), p(1000 * (1 + halfWidth)));
      const ratio = breakevenVolatility(k, range, 0) / (4 * k);
      expect(ratio).toBeGreaterThan(0.94);
      expect(ratio).toBeLessThan(1.01);
    }
  });

  it('is 3.81 % for k = 0.01 and a 0.05 % swap', () => {
    expect(breakevenVolatility(0.01, RANGE_A, 0.0005) * 100).toBeCloseTo(3.8063, 3);
  });

  it('is lowered by the swap cost, and more so for narrower ranges', () => {
    const k = 0.005;
    const narrow = createRange(p(1000 / 1.01), p(1000 * 1.01));
    const wide = RANGE_B;
    const drop = (r: typeof narrow): number =>
      1 - breakevenVolatility(k, r, 0.0004) / breakevenVolatility(k, r, 0);
    expect(drop(narrow)).toBeGreaterThan(drop(wide));
    expect(drop(wide)).toBeGreaterThan(0);
  });

  it('agrees with feeToCostRatio: the ratio is σ* / σ', () => {
    const k = 0.01;
    const sigma = 0.015;
    const range = RANGE_B;
    const feeRate = (k * sigma) / logHalfWidth(range);
    const ratio = feeToCostRatio(feeRate, {
      range,
      sigmaPerDay: sigma,
      swapCostPerRemount: 0.0004,
    });
    expect(ratio).toBeCloseTo(breakevenVolatility(k, range, 0.0004) / sigma, 9);
  });

  it('refuses a negative k', () => {
    expect(() => breakevenVolatility(-0.001, RANGE_A, 0)).toThrow(RangeError);
  });
});
