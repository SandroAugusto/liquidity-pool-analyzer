import { describe, expect, it } from 'vitest';

import {
  DISCRETE_MONITORING_SHIFT,
  discretelyMonitoredHalfWidth,
  exitSurvivalFromCentre,
  exitTimeQuantileFromCentre,
} from '../../src/math/exit-time.js';

/**
 * Reference values computed independently in Python from the same series
 * (summed until terms < 1e-16), not by running this implementation.
 */
describe('exitSurvivalFromCentre', () => {
  it('matches independently computed values', () => {
    expect(exitSurvivalFromCentre(0.25)).toBeCloseTo(0.9089994761536339, 12);
    expect(exitSurvivalFromCentre(1)).toBeCloseTo(0.37077742979952394, 12);
    expect(exitSurvivalFromCentre(2)).toBeCloseTo(0.10797704444410905, 12);
  });

  it('is 1 at c = 0 and for very small c, and decreasing', () => {
    expect(exitSurvivalFromCentre(0)).toBe(1);
    expect(exitSurvivalFromCentre(1e-9)).toBe(1);
    let previous = 1;
    for (let c = 0.01; c < 10; c += 0.01) {
      const s = exitSurvivalFromCentre(c);
      expect(s).toBeLessThanOrEqual(previous);
      expect(s).toBeGreaterThanOrEqual(0);
      previous = s;
    }
  });

  it('integrates to 1: the mean of T / E[T] is 1', () => {
    // Trapezoid rule on [0, 20]; the tail beyond 20 is below 1e-10.
    const dc = 0.001;
    let area = 0;
    for (let c = 0; c < 20; c += dc) {
      area += ((exitSurvivalFromCentre(c) + exitSurvivalFromCentre(c + dc)) / 2) * dc;
    }
    expect(area).toBeCloseTo(1, 4);
  });

  it('matches a seeded Monte Carlo of a driftless walk', () => {
    let seed = 7;
    const uniform = (): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return (seed + 1) / 4294967297;
    };
    const normal = (): number =>
      Math.sqrt(-2 * Math.log(uniform())) * Math.cos(2 * Math.PI * uniform());
    // h = 1, σ = 1, dt = 1e-3: E[T] = 1, so T itself is c.
    const paths = 3000;
    let survivedPastOne = 0;
    for (let i = 0; i < paths; i++) {
      let x = 0;
      let t = 0;
      while (Math.abs(x) < 1 && t <= 1) {
        x += Math.sqrt(1e-3) * normal();
        t += 1e-3;
      }
      if (t > 1) {
        survivedPastOne++;
      }
    }
    // Standard error ≈ 0.009; discrete steps detect exits slightly late.
    expect(survivedPastOne / paths).toBeGreaterThan(0.35);
    expect(survivedPastOne / paths).toBeLessThan(0.41);
  });

  it('rejects negative or non-finite c', () => {
    for (const bad of [-0.1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => exitSurvivalFromCentre(bad)).toThrow(RangeError);
    }
  });
});

describe('exitTimeQuantileFromCentre', () => {
  it('gives the median 0.7575 (independently: 0.7574956765)', () => {
    expect(exitTimeQuantileFromCentre(0.5)).toBeCloseTo(0.7574956765, 8);
  });

  it('inverts the survival function', () => {
    for (const p of [0.05, 0.25, 0.9, 0.99]) {
      expect(1 - exitSurvivalFromCentre(exitTimeQuantileFromCentre(p))).toBeCloseTo(p, 9);
    }
  });

  it('rejects p outside (0, 1)', () => {
    for (const bad of [0, 1, -0.5, 2, Number.NaN]) {
      expect(() => exitTimeQuantileFromCentre(bad)).toThrow(RangeError);
    }
  });
});

describe('discretelyMonitoredHalfWidth', () => {
  it('uses the shift −ζ(1/2)/√(2π) = 0.5825971579 (independently computed)', () => {
    expect(DISCRETE_MONITORING_SHIFT).toBeCloseTo(0.5825971579390108, 12);
    expect(discretelyMonitoredHalfWidth(0.02, 0.03, 1 / 24)).toBeCloseTo(
      0.02 + 0.5825971579390108 * 0.03 * Math.sqrt(1 / 24),
      15,
    );
  });

  it('predicts the mean exit time of a walk observed every Δt (seeded Monte Carlo)', () => {
    let seed = 11;
    const uniform = (): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return (seed + 1) / 4294967297;
    };
    const normal = (): number =>
      Math.sqrt(-2 * Math.log(uniform())) * Math.cos(2 * Math.PI * uniform());
    // h = 1, σ = 1, Δt = 0.05: uncorrected E[T] = 1; corrected (1 + 0.5826·√0.05)² ≈ 1.2775.
    const dt = 0.05;
    const paths = 20_000;
    let total = 0;
    for (let i = 0; i < paths; i++) {
      let x = 0;
      let t = 0;
      while (Math.abs(x) < 1) {
        x += Math.sqrt(dt) * normal();
        t += dt;
      }
      total += t;
    }
    const corrected = discretelyMonitoredHalfWidth(1, 1, dt) ** 2;
    // Var(T) = 2/3 for h = σ = 1, so the standard error is well under the 0.03 tolerance.
    expect(total / paths).toBeGreaterThan(corrected - 0.03);
    expect(total / paths).toBeLessThan(corrected + 0.03);
    expect(total / paths).toBeGreaterThan(1.2);
  });

  it('rejects non-positive or non-finite inputs', () => {
    const bad: [number, number, number][] = [
      [0, 1, 1],
      [1, -1, 1],
      [1, 1, Number.NaN],
    ];
    for (const [h, sigma, step] of bad) {
      expect(() => discretelyMonitoredHalfWidth(h, sigma, step)).toThrow(RangeError);
    }
  });
});
