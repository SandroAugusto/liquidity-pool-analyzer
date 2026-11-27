/**
 * Out-of-sample forecasts of time in range (docs/research/exit-time.md,
 * "Forecasting time in range"). A forecast gives quantiles of T for a new
 * position: q_p · E[T], where E[T] = h_eff² / σ² for some σ known at opening
 * and q_p is either the model's quantile of T / E[T] or one measured on
 * earlier positions, optionally within a volatility regime.
 *
 * Training uses only positions opened before the split minus an embargo, so
 * no training path overlaps the test period; tests use positions opened from
 * the split on. Coverage is measured at fixed horizons: a test position counts
 * for a predicted quantile only if it was watched that long.
 */

import { discretelyMonitoredHalfWidth, exitTimeQuantileFromCentre } from '../math/index.js';
import { observedQuantile } from './exit-time.js';
import type { PositionOutcome } from './exit-time.js';
import { seededUniform } from './surrogates.js';

const SECONDS_PER_DAY = 86_400;

/** One synthetic position with both σ estimates known at opening. */
export interface ForecastCase {
  readonly logHalfWidth: number;
  readonly openedAtSeconds: number;
  readonly exitDays: number | null;
  readonly observedDays: number;
  /** σ per day from the 30 daily closes before opening. */
  readonly sigmaDaily30: number;
  /** σ per day from the samples of the 7 days before opening. */
  readonly sigmaIntraday7: number;
}

/**
 * Joins the outcomes of the same positions simulated with the two σ
 * estimators (exits do not depend on σ; only E[T] does). Positions missing
 * from either run are dropped.
 */
export function forecastCases(
  daily30: readonly PositionOutcome[],
  intraday7: readonly PositionOutcome[],
): ForecastCase[] {
  const key = (o: PositionOutcome): string =>
    `${String(o.openedAtSeconds)}|${String(o.logHalfWidth)}`;
  const short = new Map(intraday7.map((o) => [key(o), o.sigmaPerDay]));
  const cases: ForecastCase[] = [];
  for (const o of daily30) {
    const sigmaIntraday7 = short.get(key(o));
    if (sigmaIntraday7 !== undefined) {
      cases.push({
        logHalfWidth: o.logHalfWidth,
        openedAtSeconds: o.openedAtSeconds,
        exitDays: o.exitDays,
        observedDays: o.observedDays,
        sigmaDaily30: o.sigmaPerDay,
        sigmaIntraday7,
      });
    }
  }
  return cases;
}

/** Which σ goes into E[T]. */
export type SigmaChoice = 'daily30' | 'blend';

export function sigmaOf(c: ForecastCase, choice: SigmaChoice): number {
  return choice === 'daily30' ? c.sigmaDaily30 : Math.sqrt(c.sigmaDaily30 * c.sigmaIntraday7);
}

/** E[T] in days, widened for checks every `stepSeconds`. */
export function expectedDays(c: ForecastCase, choice: SigmaChoice, stepSeconds: number): number {
  const sigma = sigmaOf(c, choice);
  const h = discretelyMonitoredHalfWidth(c.logHalfWidth, sigma, stepSeconds / SECONDS_PER_DAY);
  return (h * h) / (sigma * sigma);
}

/** The short-to-long σ ratio at opening: above 1 after volatility rose. */
export const regimeRatio = (c: ForecastCase): number => c.sigmaIntraday7 / c.sigmaDaily30;

export interface Method {
  readonly name: string;
  readonly sigma: SigmaChoice;
  /** 'model': quantiles of the driftless-walk distribution; 'empirical': measured on training cases. */
  readonly quantiles: 'model' | 'empirical';
  /** Measure empirical quantiles separately in each regime tercile. */
  readonly byRegime: boolean;
}

export const METHODS: readonly Method[] = [
  { name: 'Model, 30-day σ', sigma: 'daily30', quantiles: 'model', byRegime: false },
  { name: 'Empirical, 30-day σ', sigma: 'daily30', quantiles: 'empirical', byRegime: false },
  {
    name: 'Empirical by regime, 30-day σ',
    sigma: 'daily30',
    quantiles: 'empirical',
    byRegime: true,
  },
  { name: 'Empirical, blended σ', sigma: 'blend', quantiles: 'empirical', byRegime: false },
];

export const PROBABILITIES = [0.1, 0.5, 0.9] as const;

/** c from 0.005 to 10 in steps of 0.005. */
const GRID = Array.from({ length: 2000 }, (_, i) => (i + 1) / 200);

function asOutcomes(
  cases: readonly ForecastCase[],
  choice: SigmaChoice,
  stepSeconds: number,
): PositionOutcome[] {
  return cases.map((c) => {
    const e = expectedDays(c, choice, stepSeconds);
    return {
      logHalfWidth: c.logHalfWidth,
      openedAtSeconds: c.openedAtSeconds,
      sigmaPerDay: sigmaOf(c, choice),
      expectedDays: e,
      expectedDaysDiscrete: e,
      exitDays: c.exitDays,
      observedDays: c.observedDays,
    };
  });
}

/** Regime terciles of the training cases: [lower cut, upper cut]. */
export function regimeCuts(train: readonly ForecastCase[]): readonly [number, number] {
  const sorted = train.map(regimeRatio).sort((a, b) => a - b);
  if (sorted.length < 3) {
    throw new RangeError('need at least 3 training cases for regime terciles');
  }
  const at = (q: number): number => sorted[Math.floor(q * sorted.length)] ?? Number.NaN;
  return [at(1 / 3), at(2 / 3)];
}

export function regimeOf(c: ForecastCase, cuts: readonly [number, number]): 0 | 1 | 2 {
  const r = regimeRatio(c);
  return r < cuts[0] ? 0 : r < cuts[1] ? 1 : 2;
}

/** A fitted method: the quantile of T / E[T] to use for a case and a probability. */
export type Fitted = (c: ForecastCase, p: number) => number | null;

export function fit(method: Method, train: readonly ForecastCase[], stepSeconds: number): Fitted {
  if (method.quantiles === 'model') {
    return (_c, p) => exitTimeQuantileFromCentre(p);
  }
  const cuts = method.byRegime ? regimeCuts(train) : null;
  const group = (c: ForecastCase): string =>
    `${String(c.logHalfWidth)}|${cuts === null ? '' : String(regimeOf(c, cuts))}`;
  const cache = new Map<string, number | null>();
  return (c, p) => {
    const k = `${group(c)}|${String(p)}`;
    if (!cache.has(k)) {
      const members = train.filter((t) => group(t) === group(c));
      cache.set(
        k,
        members.length === 0
          ? null
          : observedQuantile(asOutcomes(members, method.sigma, stepSeconds), p, GRID, 'discrete'),
      );
    }
    return cache.get(k) ?? null;
  };
}

export interface Coverage {
  /** Fraction of eligible test cases that exited by the predicted quantile; null if none were eligible. */
  readonly covered: number | null;
  readonly eligible: number;
}

/** How often test cases exited by the predicted p-quantile of T (target: p). */
export function coverage(
  test: readonly ForecastCase[],
  fitted: Fitted,
  method: Method,
  p: number,
  stepSeconds: number,
): Coverage {
  let eligible = 0;
  let exited = 0;
  for (const c of test) {
    const q = fitted(c, p);
    if (q === null) {
      continue;
    }
    const horizon = q * expectedDays(c, method.sigma, stepSeconds);
    if (c.observedDays >= horizon) {
      eligible++;
      if (c.exitDays !== null && c.exitDays <= horizon) {
        exited++;
      }
    }
  }
  return { covered: eligible === 0 ? null : exited / eligible, eligible };
}

/**
 * Mean over regime terciles (cut on the training cases) and over
 * PROBABILITIES of |coverage − p|: how far the forecast is from calibrated
 * within each regime. Null if no cell had eligible cases.
 */
export function calibrationError(
  test: readonly ForecastCase[],
  fitted: Fitted,
  method: Method,
  cuts: readonly [number, number],
  stepSeconds: number,
): number | null {
  let total = 0;
  let cells = 0;
  for (const regime of [0, 1, 2] as const) {
    const subset = test.filter((c) => regimeOf(c, cuts) === regime);
    for (const p of PROBABILITIES) {
      const { covered } = coverage(subset, fitted, method, p, stepSeconds);
      if (covered !== null) {
        total += Math.abs(covered - p);
        cells++;
      }
    }
  }
  return cells === 0 ? null : total / cells;
}

/** Splits cases into training (opened before split − embargo) and test (opened from split on). */
export function splitCases(
  cases: readonly ForecastCase[],
  splitSeconds: number,
  embargoDays: number,
  reverse: boolean,
): { train: ForecastCase[]; test: ForecastCase[] } {
  const early = cases.filter(
    (c) => c.openedAtSeconds < splitSeconds - embargoDays * SECONDS_PER_DAY,
  );
  const late = cases.filter((c) => c.openedAtSeconds >= splitSeconds);
  return reverse ? { train: late, test: early } : { train: early, test: late };
}

/**
 * Resamples test cases in blocks of `blockDays` consecutive opening days
 * (seeded), keeping positions opened close together in the same block so
 * their overlap is preserved.
 */
export function blockResample(
  test: readonly ForecastCase[],
  blockDays: number,
  seed: number,
): ForecastCase[] {
  const blocks = new Map<number, ForecastCase[]>();
  for (const c of test) {
    const b = Math.floor(c.openedAtSeconds / (blockDays * SECONDS_PER_DAY));
    const list = blocks.get(b) ?? [];
    list.push(c);
    blocks.set(b, list);
  }
  const all = [...blocks.values()];
  const uniform = seededUniform(seed);
  const out: ForecastCase[] = [];
  all.forEach(() => {
    out.push(...(all[Math.floor(uniform() * all.length)] ?? []));
  });
  return out;
}
