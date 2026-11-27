import { describe, expect, it } from 'vitest';

import { exitSurvivalFromCentre } from '../../src/math/index.js';
import {
  calibration,
  crossPrice,
  observedQuantile,
  simulateCentredPositions,
} from '../../src/research/exit-time.js';
import type { PositionOutcome, PriceSeries, StudyOptions } from '../../src/research/exit-time.js';

const DAY = 86_400;
const HOUR = 3600;
const T0 = 20_000 * DAY;

describe('crossPrice', () => {
  it('divides base by quote and keeps only common times', () => {
    const btc = new Map([
      [1, 100],
      [2, 110],
      [3, 120],
    ]);
    const sol = new Map([
      [2, 2],
      [3, 4],
      [4, 5],
    ]);
    expect(crossPrice(btc, sol)).toEqual({
      timesSeconds: [2, 3],
      prices: [55, 30],
      droppedSamples: 2,
    });
  });

  it('rejects non-positive or non-finite prices', () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => crossPrice(new Map([[1, bad]]), new Map([[1, 1]]))).toThrow(RangeError);
      expect(() => crossPrice(new Map([[1, 1]]), new Map([[1, bad]]))).toThrow(RangeError);
    }
  });
});

describe('simulateCentredPositions', () => {
  // Daily closes 1, e^0.1, 1 at 00:00 UTC, then hourly samples after the third.
  const daily: PriceSeries = {
    timesSeconds: [
      T0,
      T0 + DAY,
      T0 + 2 * DAY,
      T0 + 2 * DAY + HOUR,
      T0 + 2 * DAY + 2 * HOUR,
      T0 + 2 * DAY + 3 * HOUR,
    ],
    prices: [1, Math.exp(0.1), 1, 1.001, 0.999, Math.exp(0.05)],
  };
  const options: StudyOptions = {
    logHalfWidths: [0.02, 1],
    openEverySeconds: DAY,
    sigma: { kind: 'trailingDaily', days: 2 },
    stepSeconds: HOUR,
  };

  it('opens only where σ has full history, and records exits and censoring', () => {
    const outcomes = simulateCentredPositions(daily, options);
    // Returns +0.1 and −0.1: sample σ = √0.02 per day.
    const sigma = Math.sqrt(0.02);
    expect(outcomes).toHaveLength(2);
    const [narrow, wide] = outcomes;
    expect(narrow?.openedAtSeconds).toBe(T0 + 2 * DAY);
    expect(narrow?.sigmaPerDay).toBeCloseTo(sigma, 12);
    expect(narrow?.expectedDays).toBeCloseTo(0.0004 / 0.02, 12);
    // e^0.05 is the first sample beyond ±2 %, three hours in.
    expect(narrow?.exitDays).toBeCloseTo(3 / 24, 12);
    expect(narrow?.observedDays).toBeCloseTo(3 / 24, 12);
    expect(wide?.logHalfWidth).toBe(1);
    expect(wide?.exitDays).toBeNull();
  });

  it('counts a sample exactly on a bound as an exit', () => {
    const series: PriceSeries = {
      timesSeconds: [...daily.timesSeconds.slice(0, 3), T0 + 2 * DAY + HOUR],
      prices: [1, Math.exp(0.1), 1, Math.exp(-0.5)],
    };
    const [outcome] = simulateCentredPositions(series, { ...options, logHalfWidths: [0.5] });
    expect(outcome?.exitDays).toBeCloseTo(1 / 24, 12);
  });

  it('scales intraday σ by √(samples per day)', () => {
    const timesSeconds = Array.from({ length: 26 }, (_, i) => T0 + i * HOUR);
    const prices = timesSeconds.map((_, i) => (i % 2 === 0 ? 1 : Math.exp(0.01)));
    const outcomes = simulateCentredPositions(
      { timesSeconds, prices },
      {
        logHalfWidths: [0.5],
        openEverySeconds: HOUR,
        sigma: { kind: 'trailingIntraday', days: 1 },
        stepSeconds: HOUR,
      },
    );
    // Opens at hour 24 (first with a full day behind it) and hour 25.
    expect(outcomes.map((o) => (o.openedAtSeconds - T0) / HOUR)).toEqual([24, 25]);
    // 24 alternating returns of ±0.01: sample σ = 0.01·√(24/23) per hour.
    expect(outcomes[0]?.sigmaPerDay).toBeCloseTo(0.01 * Math.sqrt(24 / 23) * Math.sqrt(24), 12);
  });

  it('can take σ from another series with the same times', () => {
    const calm: PriceSeries = {
      timesSeconds: daily.timesSeconds,
      prices: daily.prices.map((_, i) => (i === 1 ? Math.exp(0.05) : 1)),
    };
    const [own] = simulateCentredPositions(daily, options);
    const [borrowed] = simulateCentredPositions(daily, { ...options, sigmaFrom: calm });
    // Calm returns +0.05 and −0.05: σ = √0.005, half the actual √0.02.
    expect(borrowed?.sigmaPerDay).toBeCloseTo(Math.sqrt(0.005), 12);
    expect(borrowed?.exitDays).toBe(own?.exitDays);
    expect(() =>
      simulateCentredPositions(daily, {
        ...options,
        sigmaFrom: { timesSeconds: [1], prices: [1] },
      }),
    ).toThrow(RangeError);
    expect(() =>
      simulateCentredPositions(daily, {
        ...options,
        sigmaFrom: { timesSeconds: daily.timesSeconds.map((t) => t + 1), prices: daily.prices },
      }),
    ).toThrow(RangeError);
    expect(() =>
      simulateCentredPositions(daily, {
        ...options,
        sigmaFrom: { timesSeconds: daily.timesSeconds, prices: daily.prices.slice(1) },
      }),
    ).toThrow(/one price per time/);
  });

  it('returns nothing for an empty series', () => {
    expect(simulateCentredPositions({ timesSeconds: [], prices: [] }, options)).toEqual([]);
  });

  it('skips openings whose σ is zero', () => {
    const flat: PriceSeries = { timesSeconds: daily.timesSeconds.slice(0, 3), prices: [1, 1, 1] };
    expect(simulateCentredPositions(flat, options)).toEqual([]);
  });

  it('skips daily σ when a daily close is missing from the window', () => {
    const gap: PriceSeries = {
      timesSeconds: [T0, T0 + DAY / 2, T0 + 2 * DAY],
      prices: [1, 1.1, 1],
    };
    expect(simulateCentredPositions(gap, options)).toEqual([]);
  });

  it('rejects invalid options and series', () => {
    const bad: StudyOptions[] = [
      { ...options, logHalfWidths: [] },
      { ...options, logHalfWidths: [0] },
      { ...options, logHalfWidths: [Number.NaN] },
      { ...options, openEverySeconds: 0 },
      { ...options, stepSeconds: 1.5 },
      { ...options, sigma: { kind: 'trailingDaily', days: -1 } },
    ];
    for (const o of bad) {
      expect(() => simulateCentredPositions(daily, o)).toThrow(RangeError);
    }
    expect(() => simulateCentredPositions({ timesSeconds: [1, 2], prices: [1] }, options)).toThrow(
      RangeError,
    );
    expect(() =>
      simulateCentredPositions({ timesSeconds: [2, 2], prices: [1, 1] }, options),
    ).toThrow(RangeError);
  });
});

function outcome(
  expectedDays: number,
  exitDays: number | null,
  observedDays: number,
  expectedDaysDiscrete = expectedDays,
): PositionOutcome {
  return {
    logHalfWidth: 0.02,
    openedAtSeconds: 0,
    sigmaPerDay: 1,
    expectedDays,
    expectedDaysDiscrete,
    exitDays,
    observedDays,
  };
}

describe('calibration', () => {
  const outcomes = [
    outcome(1, 0.2, 10), // exited by 0.25·E
    outcome(1, 0.9, 10), // exited by 1·E
    outcome(2, null, 1), // still open after 0.5·E; unknown beyond
    outcome(1, null, 10), // never exited in 10·E
    outcome(1, 0.1, 0.5), // exited early, but the data ended at 0.5·E
  ];

  it('counts only positions watched for c·E[T], exited or not', () => {
    const rows = calibration(outcomes, [0.25, 1, 2]);
    expect(rows.map((r) => [r.c, r.eligible, r.observedExited])).toEqual([
      [0.25, 5, 2 / 5], // every position was watched for 0.25·E
      // The last one exited, but was not watched for 1·E: counting it only
      // because it exited would select on the outcome.
      [1, 3, 2 / 3],
      [2, 3, 2 / 3],
    ]);
    expect(rows[1]?.modelExited).toBeCloseTo(1 - exitSurvivalFromCentre(1), 15);
  });

  it('measures against the discretely monitored E[T] when asked', () => {
    // Exit at 0.9 days: within 1·E for E = 1, not for E = 0.5.
    const one = [outcome(0.5, 0.9, 10, 1)];
    expect(calibration(one, [1])[0]?.observedExited).toBe(0);
    expect(calibration(one, [1], 'discrete')[0]?.observedExited).toBe(1);
    expect(observedQuantile(one, 0.5, [1, 2], 'discrete')).toBe(1);
    expect(observedQuantile(one, 0.5, [1, 2])).toBe(2);
  });

  it('reports null when no position is eligible', () => {
    expect(calibration([outcome(1, null, 0.1)], [1])[0]?.observedExited).toBeNull();
  });

  it('rejects non-positive c', () => {
    expect(() => calibration(outcomes, [0])).toThrow(RangeError);
    expect(() => calibration(outcomes, [Number.NaN])).toThrow(RangeError);
  });
});

describe('observedQuantile', () => {
  const outcomes = [
    outcome(1, 0.3, 10),
    outcome(1, 0.6, 10),
    outcome(1, 1.5, 10),
    outcome(1, null, 10),
  ];
  const grid = Array.from({ length: 300 }, (_, i) => (i + 1) / 100);

  it('returns the smallest grid point where the exited fraction reaches p', () => {
    expect(observedQuantile(outcomes, 0.5, grid)).toBeCloseTo(0.6, 12);
    expect(observedQuantile(outcomes, 0.25, grid)).toBeCloseTo(0.3, 12);
  });

  it('returns null when p is never reached', () => {
    expect(observedQuantile(outcomes, 0.9, grid)).toBeNull();
  });

  it('rejects p outside (0, 1)', () => {
    expect(() => observedQuantile(outcomes, 1, grid)).toThrow(RangeError);
  });
});
