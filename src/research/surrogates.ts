/**
 * Surrogate price paths for separating explanations of exit-time results
 * (docs/research/exit-time.md). Each keeps the times and the first price of
 * the input and rebuilds the path from altered log returns:
 *
 * - `signFlipped`: every return keeps its size and gets a random sign. Keeps
 *   volatility clustering (when large moves happen); removes autocorrelation
 *   of returns (mean reversion, trends) and drift.
 * - `shuffled`: the same returns in random order. Keeps their distribution
 *   (fat tails); removes clustering, autocorrelation and drift.
 * - `gaussianWalk`: independent normal returns with the input's per-step
 *   standard deviation. Removes everything but the scale: the model's world.
 *
 * Returns are taken between consecutive samples, so the few that span a gap in
 * the data move as single steps (unlike `varianceRatio`, which never bridges a
 * gap). Deterministic for a given seed. Prices are quote per base, as in the
 * input.
 */

import { logReturns, standardDeviation } from '../math/index.js';
import type { PriceSeries } from './exit-time.js';
import { at } from './at.js';

/** Mulberry32: a small seeded generator, uniform on [0, 1). Not for cryptography. */
export function seededUniform(seed: number): () => number {
  if (!Number.isInteger(seed)) {
    throw new RangeError(`seed must be an integer, got ${String(seed)}`);
  }
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function rebuild(series: PriceSeries, returns: readonly number[]): PriceSeries {
  const first = series.prices[0];
  if (first === undefined) {
    return { timesSeconds: [], prices: [] };
  }
  const prices = [first];
  let log = Math.log(first);
  for (const r of returns) {
    log += r;
    prices.push(Math.exp(log));
  }
  return { timesSeconds: [...series.timesSeconds], prices };
}

function returnsOf(series: PriceSeries): number[] {
  if (series.timesSeconds.length !== series.prices.length) {
    throw new RangeError('timesSeconds and prices must have the same length');
  }
  return series.prices.length < 2 ? [] : logReturns(series.prices);
}

export function signFlipped(series: PriceSeries, seed: number): PriceSeries {
  const uniform = seededUniform(seed);
  return rebuild(
    series,
    returnsOf(series).map((r) => (uniform() < 0.5 ? -r : r)),
  );
}

export function shuffled(series: PriceSeries, seed: number): PriceSeries {
  const uniform = seededUniform(seed);
  const returns = returnsOf(series);
  // Fisher–Yates.
  for (let i = returns.length - 1; i > 0; i--) {
    const j = Math.floor(uniform() * (i + 1));
    const a = at(returns, i);
    returns[i] = at(returns, j);
    returns[j] = a;
  }
  return rebuild(series, returns);
}

export function gaussianWalk(series: PriceSeries, seed: number): PriceSeries {
  const uniform = seededUniform(seed);
  const returns = returnsOf(series);
  if (returns.length < 2) {
    return rebuild(series, returns);
  }
  const sd = standardDeviation(returns, 'population');
  return rebuild(
    series,
    returns.map(() => {
      // Box–Muller; 1 − u keeps the logarithm finite.
      const u = 1 - uniform();
      return sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * uniform());
    }),
  );
}
