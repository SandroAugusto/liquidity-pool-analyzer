/**
 * Exit-time study on public prices with synthetic positions (ADR-0005,
 * acceptance criterion 2; method in docs/research/exit-time.md).
 *
 * A synthetic position is opened at the geometric centre of a range of log
 * half-width hL at regular times. It "exits" at the first sample at or beyond a
 * bound. Its exit time is compared with the model's expected exit time
 * E[T] = hL² / σ², for a σ that is known when the position opens. Under the
 * model, T / E[T] has the same distribution for every width and σ, so the
 * observed fraction of exits by c · E[T] can be compared with
 * 1 − S(c) (`exitSurvivalFromCentre`).
 *
 * No private data: positions are synthetic, prices are public (AGENTS.md).
 */

import {
  discretelyMonitoredHalfWidth,
  exitSurvivalFromCentre,
  logReturns,
  standardDeviation,
} from '../math/index.js';

/** A price series sampled at a fixed step. Prices are quote per base, > 0. */
export interface PriceSeries {
  /** Epoch seconds, strictly increasing. */
  readonly timesSeconds: readonly number[];
  /** Quote per base (e.g. SOL per WBTC). Same length as `timesSeconds`. */
  readonly prices: readonly number[];
}

export interface AlignedSeries extends PriceSeries {
  /** Sample times dropped because one of the two inputs had no value. */
  readonly droppedSamples: number;
}

/**
 * The price of `base` in units of `quote`, from two prices in a common
 * currency: quotePerBase = baseInCommon / quoteInCommon. For BTC-USD and
 * SOL-USD this is SOL per BTC. Only times present in both inputs are kept;
 * nothing is filled in.
 */
export function crossPrice(
  baseInCommon: ReadonlyMap<number, number>,
  quoteInCommon: ReadonlyMap<number, number>,
): AlignedSeries {
  const times = [...new Set([...baseInCommon.keys(), ...quoteInCommon.keys()])].sort(
    (a, b) => a - b,
  );
  const timesSeconds: number[] = [];
  const prices: number[] = [];
  let droppedSamples = 0;
  for (const t of times) {
    const base = baseInCommon.get(t);
    const quote = quoteInCommon.get(t);
    if (base === undefined || quote === undefined) {
      droppedSamples++;
      continue;
    }
    if (!(base > 0) || !(quote > 0) || !Number.isFinite(base) || !Number.isFinite(quote)) {
      throw new RangeError(`prices must be positive and finite at ${String(t)}`);
    }
    timesSeconds.push(t);
    prices.push(base / quote);
  }
  return { timesSeconds, prices, droppedSamples };
}

export type SigmaEstimator =
  /**
   * σ per day from `days` one-day returns: the `days + 1` samples whose time is a
   * multiple of a day (candles starting at 00:00 UTC), up to and including opening.
   */
  | { readonly kind: 'trailingDaily'; readonly days: number }
  /** σ per day from samples in the last `days` before opening, scaled by √(samples per day). */
  | { readonly kind: 'trailingIntraday'; readonly days: number };

export interface StudyOptions {
  /** Log half-widths hL = ln(upper / lower) / 2, e.g. 0.02. */
  readonly logHalfWidths: readonly number[];
  /** Open a position at every sample whose time is a multiple of this, in seconds. */
  readonly openEverySeconds: number;
  readonly sigma: SigmaEstimator;
  /** Sampling step of the series, in seconds (3600 for hourly). */
  readonly stepSeconds: number;
}

export interface PositionOutcome {
  readonly logHalfWidth: number;
  readonly openedAtSeconds: number;
  readonly sigmaPerDay: number;
  /** hL² / σ², in days: the model for a continuously watched price. */
  readonly expectedDays: number;
  /**
   * The same with hL widened for checks only at each sample
   * (`discretelyMonitoredHalfWidth`): the model for exits seen at sample closes.
   */
  readonly expectedDaysDiscrete: number;
  /** Days to the first sample at or beyond a bound; null if the data ended first. */
  readonly exitDays: number | null;
  /** Days of data after opening (the observation window). */
  readonly observedDays: number;
}

const SECONDS_PER_DAY = 86_400;

/** Indexed read that fails loudly instead of yielding undefined; callers stay in range. */
function at(values: readonly number[], index: number): number {
  const value = values[index];
  if (value === undefined) {
    throw new RangeError(`index ${String(index)} out of range`);
  }
  return value;
}

function sigmaAt(series: PriceSeries, index: number, options: StudyOptions): number | null {
  const { timesSeconds, prices } = series;
  const openedAt = at(timesSeconds, index);
  const from = openedAt - options.sigma.days * SECONDS_PER_DAY;
  if (at(timesSeconds, 0) > from) {
    return null;
  }
  const window: number[] = [];
  for (let j = index; j >= 0 && at(timesSeconds, j) >= from; j--) {
    const t = at(timesSeconds, j);
    if (options.sigma.kind === 'trailingDaily' && t % SECONDS_PER_DAY !== 0) {
      continue;
    }
    window.push(at(prices, j));
  }
  window.reverse();
  // Daily: every close in the window must be present (days + 1 closes give
  // `days` one-day returns); a missing close would silently turn two days into
  // one "daily" return. Intraday: gaps are rare (crossPrice reports them) and
  // only lengthen one return.
  const enough =
    options.sigma.kind === 'trailingDaily'
      ? window.length === options.sigma.days + 1
      : window.length >= 3;
  if (!enough) {
    return null;
  }
  const returns = logReturns(window);
  const perSample = standardDeviation(returns, 'sample');
  if (options.sigma.kind === 'trailingDaily') {
    return perSample;
  }
  return perSample * Math.sqrt(SECONDS_PER_DAY / options.stepSeconds);
}

function validateOptions(options: StudyOptions): void {
  if (options.logHalfWidths.length === 0) {
    throw new RangeError('at least one half-width is required');
  }
  for (const h of options.logHalfWidths) {
    if (!Number.isFinite(h) || h <= 0) {
      throw new RangeError(`log half-width must be positive and finite, got ${String(h)}`);
    }
  }
  for (const [name, value] of [
    ['openEverySeconds', options.openEverySeconds],
    ['stepSeconds', options.stepSeconds],
    ['sigma.days', options.sigma.days],
  ] as const) {
    if (!Number.isInteger(value) || value <= 0) {
      throw new RangeError(`${name} must be a positive integer, got ${String(value)}`);
    }
  }
}

/**
 * Opens a centred synthetic position of every width at every opening time with
 * enough history for σ, and follows it until the first sample at or beyond a
 * bound. Each position is followed on its own, but positions opened close together
 * share the same prices and are not statistically independent.
 */
export function simulateCentredPositions(
  series: PriceSeries,
  options: StudyOptions,
): PositionOutcome[] {
  validateOptions(options);
  const { timesSeconds, prices } = series;
  if (timesSeconds.length !== prices.length) {
    throw new RangeError('timesSeconds and prices must have the same length');
  }
  for (let i = 1; i < timesSeconds.length; i++) {
    if (at(timesSeconds, i) <= at(timesSeconds, i - 1)) {
      throw new RangeError('timesSeconds must be strictly increasing');
    }
  }
  if (timesSeconds.length === 0) {
    return [];
  }
  const lastTime = at(timesSeconds, timesSeconds.length - 1);
  const outcomes: PositionOutcome[] = [];
  for (let i = 0; i < timesSeconds.length; i++) {
    const openedAt = at(timesSeconds, i);
    if (openedAt % options.openEverySeconds !== 0) {
      continue;
    }
    const sigmaPerDay = sigmaAt(series, i, options);
    if (sigmaPerDay === null || !(sigmaPerDay > 0)) {
      continue;
    }
    const centre = at(prices, i);
    for (const h of options.logHalfWidths) {
      const lower = centre * Math.exp(-h);
      const upper = centre * Math.exp(h);
      let exitDays: number | null = null;
      for (let j = i + 1; j < prices.length; j++) {
        const p = at(prices, j);
        if (p <= lower || p >= upper) {
          exitDays = (at(timesSeconds, j) - openedAt) / SECONDS_PER_DAY;
          break;
        }
      }
      outcomes.push({
        logHalfWidth: h,
        openedAtSeconds: openedAt,
        sigmaPerDay,
        expectedDays: (h * h) / (sigmaPerDay * sigmaPerDay),
        expectedDaysDiscrete:
          discretelyMonitoredHalfWidth(h, sigmaPerDay, options.stepSeconds / SECONDS_PER_DAY) ** 2 /
          (sigmaPerDay * sigmaPerDay),
        exitDays,
        observedDays: (lastTime - openedAt) / SECONDS_PER_DAY,
      });
    }
  }
  return outcomes;
}

export interface CalibrationRow {
  /** Time in units of E[T]. */
  readonly c: number;
  /** Model probability of having exited by c · E[T]: 1 − S(c). */
  readonly modelExited: number;
  /** Observed fraction exited by c · E[T], among positions observed that long; null if none were. */
  readonly observedExited: number | null;
  /** Positions watched for at least c · E[T]. */
  readonly eligible: number;
}

/** Which expected exit time T is measured against. */
export type ModelTime = 'continuous' | 'discrete';

/**
 * Calibration at fixed horizons: for each c, only positions watched for at
 * least c · E[T] are counted, whether or not they exited, so their status at
 * c · E[T] is known. Counting early exits of positions watched for less would
 * select on the outcome and overstate the fraction exited.
 */
export function calibration(
  outcomes: readonly PositionOutcome[],
  cs: readonly number[],
  model: ModelTime = 'continuous',
): CalibrationRow[] {
  return cs.map((c) => {
    if (!Number.isFinite(c) || c <= 0) {
      throw new RangeError(`c must be positive and finite, got ${String(c)}`);
    }
    let eligible = 0;
    let exited = 0;
    for (const o of outcomes) {
      const horizon = c * (model === 'continuous' ? o.expectedDays : o.expectedDaysDiscrete);
      const exitedBy = o.exitDays !== null && o.exitDays <= horizon;
      if (o.observedDays >= horizon) {
        eligible++;
        if (exitedBy) {
          exited++;
        }
      }
    }
    return {
      c,
      modelExited: 1 - exitSurvivalFromCentre(c),
      observedExited: eligible === 0 ? null : exited / eligible,
      eligible,
    };
  });
}

/**
 * The smallest c on `grid` (ascending) at which the observed fraction exited
 * reaches `p`: the empirical p-quantile of T / E[T], censoring-aware. Null if it
 * is never reached on the grid.
 */
export function observedQuantile(
  outcomes: readonly PositionOutcome[],
  p: number,
  grid: readonly number[],
  model: ModelTime = 'continuous',
): number | null {
  if (!Number.isFinite(p) || p <= 0 || p >= 1) {
    throw new RangeError(`p must be in (0, 1), got ${String(p)}`);
  }
  for (const row of calibration(outcomes, grid, model)) {
    if (row.observedExited !== null && row.observedExited >= p) {
      return row.c;
    }
  }
  return null;
}
