/**
 * Diagnostics of a price path's structure that bear on exit times
 * (docs/research/exit-time.md): how variance scales with the horizon, and how
 * well a trailing volatility predicts the volatility that follows.
 */

import { standardDeviation } from '../math/index.js';
import type { PriceSeries } from './exit-time.js';
import { at } from './at.js';

const SECONDS_PER_DAY = 86_400;

/** Log return from each sample to the sample exactly `spanSeconds` later, where both exist. */
function returnsOverSpan(series: PriceSeries, spanSeconds: number): number[] {
  const index = new Map<number, number>();
  series.timesSeconds.forEach((t, i) => index.set(t, i));
  const out: number[] = [];
  series.timesSeconds.forEach((t, i) => {
    const j = index.get(t + spanSeconds);
    if (j !== undefined) {
      out.push(Math.log(at(series.prices, j) / at(series.prices, i)));
    }
  });
  return out;
}

/**
 * Variance ratio VR(k) = Var(k-step returns) / (k · Var(1-step returns)), with
 * overlapping k-step returns, each measured only between samples that are
 * exactly k steps apart (gaps are skipped, never bridged). 1 for a random walk;
 * below 1 when moves partly reverse (mean reversion), above 1 when they
 * persist (trends).
 */
export function varianceRatio(series: PriceSeries, stepSeconds: number, k: number): number {
  if (!Number.isInteger(stepSeconds) || stepSeconds <= 0) {
    throw new RangeError(`stepSeconds must be a positive integer, got ${String(stepSeconds)}`);
  }
  if (!Number.isInteger(k) || k < 2) {
    throw new RangeError(`k must be an integer ≥ 2, got ${String(k)}`);
  }
  const one = returnsOverSpan(series, stepSeconds);
  const many = returnsOverSpan(series, k * stepSeconds);
  const v1 = standardDeviation(one, 'population') ** 2;
  if (!(v1 > 0)) {
    throw new RangeError('one-step returns have zero variance');
  }
  return standardDeviation(many, 'population') ** 2 / (k * v1);
}

/** σ per day from the one-step returns between `fromSeconds` and `toSeconds`, inclusive. */
function sigmaBetween(
  series: PriceSeries,
  index: ReadonlyMap<number, number>,
  stepSeconds: number,
  fromSeconds: number,
  toSeconds: number,
): number | null {
  const returns: number[] = [];
  for (let t = fromSeconds; t + stepSeconds <= toSeconds; t += stepSeconds) {
    const i = index.get(t);
    const j = index.get(t + stepSeconds);
    if (i !== undefined && j !== undefined) {
      returns.push(Math.log(at(series.prices, j) / at(series.prices, i)));
    }
  }
  const expected = (toSeconds - fromSeconds) / stepSeconds;
  // Require 90 % of the returns; a window with many gaps is not comparable.
  if (returns.length < Math.max(2, 0.9 * expected)) {
    return null;
  }
  return standardDeviation(returns, 'sample') * Math.sqrt(SECONDS_PER_DAY / stepSeconds);
}

export interface SigmaForecastRow {
  readonly atSeconds: number;
  /** σ per day from the `shortDays` before `atSeconds`. */
  readonly trailingShort: number;
  /** σ per day from the `longDays` before `atSeconds`. */
  readonly trailingLong: number;
  /** σ per day realised over the `aheadDays` after `atSeconds`. */
  readonly realisedAhead: number;
}

export interface SigmaForecastOptions {
  readonly stepSeconds: number;
  readonly shortDays: number;
  readonly longDays: number;
  readonly aheadDays: number;
}

/**
 * At every whole day with full windows, the trailing σ over a short and a long
 * window and the σ realised over the days that follow, all from the same
 * one-step returns (so no scaling difference between them). Comparing them
 * measures how much a trailing window lags or overshoots.
 */
export function sigmaForecasts(
  series: PriceSeries,
  options: SigmaForecastOptions,
): SigmaForecastRow[] {
  for (const [name, value] of Object.entries(options)) {
    if (!Number.isInteger(value) || value <= 0) {
      throw new RangeError(`${name} must be a positive integer, got ${String(value)}`);
    }
  }
  const index = new Map<number, number>();
  series.timesSeconds.forEach((t, i) => index.set(t, i));
  const rows: SigmaForecastRow[] = [];
  for (const t of series.timesSeconds) {
    if (t % SECONDS_PER_DAY !== 0) {
      continue;
    }
    const s = options.stepSeconds;
    const trailingShort = sigmaBetween(
      series,
      index,
      s,
      t - options.shortDays * SECONDS_PER_DAY,
      t,
    );
    const trailingLong = sigmaBetween(series, index, s, t - options.longDays * SECONDS_PER_DAY, t);
    const realisedAhead = sigmaBetween(
      series,
      index,
      s,
      t,
      t + options.aheadDays * SECONDS_PER_DAY,
    );
    if (trailingShort !== null && trailingLong !== null && realisedAhead !== null) {
      rows.push({ atSeconds: t, trailingShort, trailingLong, realisedAhead });
    }
  }
  return rows;
}

export interface ForecastError {
  readonly count: number;
  /** Median of ln(forecast / realised): > 0 means the forecast was too high. */
  readonly medianLogError: number;
  /** Root mean square of ln(forecast / realised). */
  readonly rmsLogError: number;
}

/** Summarises ln(forecast / realised) for one forecast over a set of rows; null if empty. */
export function forecastError(
  rows: readonly SigmaForecastRow[],
  forecast: (row: SigmaForecastRow) => number,
): ForecastError | null {
  if (rows.length === 0) {
    return null;
  }
  const errors = rows.map((r) => Math.log(forecast(r) / r.realisedAhead)).sort((a, b) => a - b);
  const mid = Math.floor(errors.length / 2);
  const medianLogError =
    errors.length % 2 === 1 ? at(errors, mid) : (at(errors, mid - 1) + at(errors, mid)) / 2;
  const rmsLogError = Math.sqrt(errors.reduce((a, e) => a + e * e, 0) / errors.length);
  return { count: rows.length, medianLogError, rmsLogError };
}
