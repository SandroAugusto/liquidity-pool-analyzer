import { describe, expect, it } from 'vitest';

import { discretelyMonitoredHalfWidth, exitTimeQuantileFromCentre } from '../../src/math/index.js';
import type { PositionOutcome } from '../../src/research/exit-time.js';
import {
  blockResample,
  calibrationError,
  coverage,
  expectedDays,
  fit,
  forecastCases,
  METHODS,
  regimeCuts,
  regimeOf,
  sigmaOf,
  splitCases,
} from '../../src/research/forecast.js';
import type { ForecastCase, Method } from '../../src/research/forecast.js';

const DAY = 86_400;
const HOUR = 3600;

function outcome(
  openedDay: number,
  h: number,
  sigma: number,
  exitDays: number | null,
): PositionOutcome {
  return {
    logHalfWidth: h,
    openedAtSeconds: openedDay * DAY,
    sigmaPerDay: sigma,
    expectedDays: (h * h) / (sigma * sigma),
    expectedDaysDiscrete: (h * h) / (sigma * sigma),
    exitDays,
    observedDays: 100,
  };
}

function kase(day: number, exitDays: number | null, regime = 1, observedDays = 100): ForecastCase {
  return {
    logHalfWidth: 0.02,
    openedAtSeconds: day * DAY,
    exitDays,
    observedDays,
    sigmaDaily30: 0.02,
    sigmaIntraday7: 0.02 * regime,
  };
}

const [MODEL, EMPIRICAL, BY_REGIME, BLENDED] = METHODS as [Method, Method, Method, Method];

describe('forecastCases', () => {
  it('joins the two σ runs on opening time and width, dropping unmatched positions', () => {
    const cases = forecastCases(
      [outcome(1, 0.02, 0.03, 0.5), outcome(2, 0.02, 0.03, null), outcome(1, 0.04, 0.03, 2)],
      [outcome(1, 0.02, 0.06, 0.5), outcome(1, 0.04, 0.015, 2)],
    );
    expect(cases).toEqual([
      {
        logHalfWidth: 0.02,
        openedAtSeconds: DAY,
        exitDays: 0.5,
        observedDays: 100,
        sigmaDaily30: 0.03,
        sigmaIntraday7: 0.06,
      },
      {
        logHalfWidth: 0.04,
        openedAtSeconds: DAY,
        exitDays: 2,
        observedDays: 100,
        sigmaDaily30: 0.03,
        sigmaIntraday7: 0.015,
      },
    ]);
  });
});

describe('σ and E[T]', () => {
  const c: ForecastCase = { ...kase(0, 1), sigmaDaily30: 0.01, sigmaIntraday7: 0.04 };

  it('blends σ as a geometric mean', () => {
    expect(sigmaOf(c, 'daily30')).toBe(0.01);
    expect(sigmaOf(c, 'blend')).toBeCloseTo(0.02, 15);
  });

  it('uses the discretely monitored half-width', () => {
    const h = discretelyMonitoredHalfWidth(0.02, 0.02, 1 / 24);
    expect(expectedDays(c, 'blend', HOUR)).toBeCloseTo((h * h) / 0.0004, 12);
  });
});

describe('regimes', () => {
  it('cuts terciles of the 7-day to 30-day σ ratio on the training cases', () => {
    const train = [0.5, 0.8, 0.9, 1.0, 1.1, 1.3].map((r, i) => kase(i, 1, r));
    const [low, high] = regimeCuts(train);
    expect(low).toBeCloseTo(0.9, 12);
    expect(high).toBeCloseTo(1.1, 12);
    expect(regimeOf(kase(0, 1, 0.85), [0.9, 1.1])).toBe(0);
    expect(regimeOf(kase(0, 1, 0.9), [0.9, 1.1])).toBe(1);
    expect(regimeOf(kase(0, 1, 1.2), [0.9, 1.1])).toBe(2);
  });

  it('needs at least three training cases', () => {
    expect(() => regimeCuts([kase(0, 1), kase(1, 1)])).toThrow(RangeError);
  });
});

describe('fit and coverage', () => {
  // E[T] at 2 % with σ = 2 % per day, hourly checks: one number for all cases.
  const e = expectedDays(kase(0, 1), 'daily30', HOUR);
  // Training exits at 0.2, 0.4, …, 2.0 times E[T].
  const train = Array.from({ length: 10 }, (_, i) => kase(i, ((i + 1) / 5) * e));

  it('uses the model quantiles for the model method', () => {
    expect(fit(MODEL, train, HOUR)(kase(0, 1), 0.5)).toBeCloseTo(
      exitTimeQuantileFromCentre(0.5),
      12,
    );
  });

  it('measures empirical quantiles of T / E[T] on the training cases', () => {
    // Half the cases have exited by 1.0 · E[T] (exits at 0.2 … 1.0).
    expect(fit(EMPIRICAL, train, HOUR)(kase(0, 1), 0.5)).toBeCloseTo(1, 12);
  });

  it('counts a test case for a quantile only if it was watched that long', () => {
    const f = fit(EMPIRICAL, train, HOUR);
    const test = [
      kase(20, 0.5 * e),
      kase(21, 1.5 * e),
      kase(22, null, 1, 0.5 * e),
      kase(23, 0.3 * e, 1, 0.8 * e),
    ];
    // Predicted median 1.0 · E[T]: the first exited by then, the second did not.
    // The third and fourth were watched less than 1.0 · E[T] and do not count,
    // even though the fourth exited: counting it would select on the outcome.
    expect(coverage(test, f, EMPIRICAL, 0.5, HOUR)).toEqual({ covered: 0.5, eligible: 2 });
  });

  it('scores the mean distance from target coverage across regimes and percentiles', () => {
    const f = fit(MODEL, train, HOUR);
    // Every test case exits immediately: coverage 1 at every percentile.
    const test = [kase(30, 0.001 * e, 0.5), kase(31, 0.001 * e, 1), kase(32, 0.001 * e, 2)];
    expect(calibrationError(test, f, MODEL, [0.9, 1.1], HOUR)).toBeCloseTo(
      (0.9 + 0.5 + 0.1) / 3,
      12,
    );
    expect(calibrationError([], f, MODEL, [0.9, 1.1], HOUR)).toBeNull();
  });

  it('measures quantiles within each regime when asked', () => {
    const mixed = [
      ...Array.from({ length: 6 }, (_, i) => kase(i, 0.2 * e, 0.5)),
      ...Array.from({ length: 6 }, (_, i) => kase(10 + i, 2 * e, 1)),
      ...Array.from({ length: 6 }, (_, i) => kase(20 + i, 4 * e, 2)),
    ];
    const f = fit(BY_REGIME, mixed, HOUR);
    expect(f(kase(0, 1, 0.5), 0.5)).toBeCloseTo(0.2, 12);
    expect(f(kase(0, 1, 2), 0.5)).toBeCloseTo(4, 12);
    // No training case of this width: no forecast.
    expect(f({ ...kase(0, 1), logHalfWidth: 0.08 }, 0.5)).toBeNull();
  });

  it('puts the blended σ into E[T]', () => {
    const f = fit(BLENDED, train, HOUR);
    const c = { ...kase(40, null), sigmaIntraday7: 0.08 };
    // A forecast is a multiple of the blended E[T], which is shorter here.
    expect(expectedDays(c, 'blend', HOUR)).toBeLessThan(expectedDays(c, 'daily30', HOUR));
    expect(f(c, 0.5)).not.toBeNull();
  });
});

describe('splitCases', () => {
  const cases = [0, 10, 50, 59, 60, 80].map((d) => kase(d, 1));

  it('keeps an embargo before the split, in both directions', () => {
    const forward = splitCases(cases, 60 * DAY, 10, false);
    expect(forward.train.map((c) => c.openedAtSeconds / DAY)).toEqual([0, 10]);
    expect(forward.test.map((c) => c.openedAtSeconds / DAY)).toEqual([60, 80]);
    const reverse = splitCases(cases, 60 * DAY, 10, true);
    expect(reverse.train.map((c) => c.openedAtSeconds / DAY)).toEqual([60, 80]);
    expect(reverse.test.map((c) => c.openedAtSeconds / DAY)).toEqual([0, 10]);
  });
});

describe('blockResample', () => {
  const test = Array.from({ length: 90 }, (_, d) => kase(d, 1));

  it('draws whole blocks, as many as there are, deterministically', () => {
    const a = blockResample(test, 30, 7);
    expect(a).toEqual(blockResample(test, 30, 7));
    expect(a).toHaveLength(90);
    const blocks = a.map((c) => Math.floor(c.openedAtSeconds / (30 * DAY)));
    for (let i = 0; i < 90; i += 30) {
      expect(new Set(blocks.slice(i, i + 30)).size).toBe(1);
    }
  });

  it('returns nothing for no cases', () => {
    expect(blockResample([], 30, 1)).toEqual([]);
  });
});
