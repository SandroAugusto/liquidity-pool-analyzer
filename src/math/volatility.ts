/**
 * Volatility estimation and range-sizing heuristics for a price ratio.
 *
 * The model is a driftless random walk in log-price with constant daily
 * volatility σ. Both assumptions are known to be violated in practice (ratios
 * trend; volatility clusters) and the estimates here are **planning numbers**,
 * not forecasts. See docs/adr/0002-continuous-model.md.
 */

export class InsufficientDataError extends Error {
  constructor(required: number, received: number) {
    super(`Need at least ${String(required)} data points, received ${String(received)}`);
    this.name = 'InsufficientDataError';
  }
}

function assertPositiveFinite(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive finite number, got ${String(value)}`);
  }
}

/** Log returns ln(p[i+1] / p[i]) of a strictly positive price series. */
export function logReturns(prices: readonly number[]): number[] {
  if (prices.length < 2) {
    throw new InsufficientDataError(2, prices.length);
  }
  const returns: number[] = [];
  for (let i = 1; i < prices.length; i += 1) {
    const prev = prices[i - 1];
    const curr = prices[i];
    if (prev === undefined || curr === undefined) {
      // Unreachable given the loop bounds; satisfies noUncheckedIndexedAccess.
      throw new InsufficientDataError(2, prices.length);
    }
    assertPositiveFinite(prev, `prices[${String(i - 1)}]`);
    assertPositiveFinite(curr, `prices[${String(i)}]`);
    returns.push(Math.log(curr / prev));
  }
  return returns;
}

export function mean(values: readonly number[]): number {
  if (values.length === 0) {
    throw new InsufficientDataError(1, 0);
  }
  let sum = 0;
  for (const v of values) {
    sum += v;
  }
  return sum / values.length;
}

/**
 * Which standard-deviation estimator to use.
 *
 * - `'sample'`: divide by n − 1. Unbiased for the variance of the process the
 *   data was drawn from. Use when the series is a sample of an ongoing process —
 *   which is always the case for market returns.
 * - `'population'`: divide by n. Describes exactly the data at hand.
 *
 * There is no default on purpose: libraries disagree (NumPy defaults to
 * population, pandas and R to sample) and a silent default is exactly the kind of
 * plausible-wrong-number this project exists to avoid.
 */
export type StdDevEstimator = 'sample' | 'population';

/** Standard deviation with an explicit estimator. See {@link StdDevEstimator}. */
export function standardDeviation(values: readonly number[], estimator: StdDevEstimator): number {
  const minimum = estimator === 'sample' ? 2 : 1;
  if (values.length < minimum) {
    throw new InsufficientDataError(minimum, values.length);
  }
  const mu = mean(values);
  let sumSq = 0;
  for (const v of values) {
    sumSq += (v - mu) ** 2;
  }
  const divisor = estimator === 'sample' ? values.length - 1 : values.length;
  return Math.sqrt(sumSq / divisor);
}

/**
 * Daily volatility (σ) of a price series sampled once per day, using the
 * **sample** estimator: the series is a draw from an ongoing process.
 */
export function dailyVolatility(dailyPrices: readonly number[]): number {
  return standardDeviation(logReturns(dailyPrices), 'sample');
}

/**
 * Expected number of days for a driftless random walk with daily volatility
 * `sigma` to first exit a symmetric band of relative half-width `halfWidth`,
 * starting from the centre: E[T] = halfWidth² / sigma².
 */
export function expectedDaysToExit(halfWidth: number, sigma: number): number {
  assertPositiveFinite(halfWidth, 'halfWidth');
  assertPositiveFinite(sigma, 'sigma');
  return (halfWidth / sigma) ** 2;
}

/**
 * Inverse of {@link expectedDaysToExit}: the relative half-width that gives an
 * expected time-in-range of `days` for a walk with daily volatility `sigma`.
 */
export function halfWidthForHorizon(days: number, sigma: number): number {
  assertPositiveFinite(days, 'days');
  assertPositiveFinite(sigma, 'sigma');
  return sigma * Math.sqrt(days);
}

/**
 * Per-day cost of a "re-centre on exit" strategy: the divergence loss paid on
 * each exit, amortised over the expected time between exits.
 *
 * Returns a positive fraction per day. Compare against realised fee yield per
 * day; the strategy is expected to beat holding when fees exceed this number.
 */
export function amortisedDivergenceCostPerDay(
  divergenceLossAtEdge: number,
  expectedDays: number,
): number {
  if (!Number.isFinite(divergenceLossAtEdge)) {
    throw new RangeError(
      `divergenceLossAtEdge must be finite, got ${String(divergenceLossAtEdge)}`,
    );
  }
  assertPositiveFinite(expectedDays, 'expectedDays');
  return Math.abs(divergenceLossAtEdge) / expectedDays;
}
