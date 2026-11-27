/**
 * `pnpm exit-time-diagnostics --from YYYY-MM-DD --to YYYY-MM-DD [--step hour|minute] [--seeds N]`
 *
 * Tests explanations for where exit times differ from the model
 * (docs/research/exit-time.md), on the same public prices as
 * `pnpm exit-time-study`:
 *
 * 1. variance ratios by horizon (mean reversion or trend);
 * 2. medians of T / E[T] on surrogate paths that keep or remove volatility
 *    clustering, return autocorrelation and fat tails, over N seeds;
 * 3. the 7-day and 30-day σ estimators on the same opening dates;
 * 4. how well a trailing σ predicts the σ of the following 7 days.
 *
 * Prints aggregate statistics only. Side effects are injected into {@link main}.
 */

import type { GranularitySeconds } from '../adapters/coinbase/index.js';
import { exitSurvivalFromCentre, exitTimeQuantileFromCentre } from '../math/index.js';
import {
  calibration,
  crossPrice,
  observedQuantile,
  simulateCentredPositions,
} from '../research/exit-time.js';
import type { PositionOutcome, PriceSeries, SigmaEstimator } from '../research/exit-time.js';
import { forecastError, sigmaForecasts, varianceRatio } from '../research/structure.js';
import type { SigmaForecastRow } from '../research/structure.js';
import { gaussianWalk, shuffled, signFlipped } from '../research/surrogates.js';
import { closes, grid, LOG_HALF_WIDTHS, parseArgs, runIfScript } from './exit-time-study.js';
import type { Args, StudyDeps } from './exit-time-study.js';

const USAGE =
  'usage: pnpm exit-time-diagnostics --from YYYY-MM-DD --to YYYY-MM-DD [--step hour|minute] [--seeds N]';
const SECONDS_PER_DAY = 86_400;
const DAILY_30: SigmaEstimator = { kind: 'trailingDaily', days: 30 };
const INTRADAY_7: SigmaEstimator = { kind: 'trailingIntraday', days: 7 };

/** Horizons for variance ratios, as (label, number of steps). */
const HORIZONS: Record<Args['step'], readonly (readonly [string, number])[]> = {
  hour: [
    ['4 h', 4],
    ['1 d', 24],
    ['3 d', 72],
    ['7 d', 168],
    ['14 d', 336],
  ],
  minute: [
    ['5 min', 5],
    ['15 min', 15],
    ['1 h', 60],
    ['4 h', 240],
    ['1 d', 1440],
  ],
};

export function parseDiagnosticsArgs(argv: readonly string[]): (Args & { seeds: number }) | null {
  const rest = [...argv];
  let seeds = 20;
  const at = rest.indexOf('--seeds');
  if (at !== -1) {
    const value = rest[at + 1];
    if (value === undefined || !/^[1-9]\d{0,2}$/.test(value)) {
      return null;
    }
    seeds = Number(value);
    rest.splice(at, 2);
  }
  const args = parseArgs(rest);
  return args === null ? null : { ...args, seeds };
}

function medians(outcomes: readonly PositionOutcome[]): (number | null)[] {
  return LOG_HALF_WIDTHS.map((h) =>
    observedQuantile(
      outcomes.filter((o) => o.logHalfWidth === h),
      0.5,
      grid(),
      'discrete',
    ),
  );
}

function run(
  series: PriceSeries,
  sigma: SigmaEstimator,
  stepSeconds: number,
  sigmaFrom?: PriceSeries,
): PositionOutcome[] {
  return simulateCentredPositions(series, {
    logHalfWidths: LOG_HALF_WIDTHS,
    openEverySeconds: SECONDS_PER_DAY,
    sigma,
    stepSeconds,
    ...(sigmaFrom === undefined ? {} : { sigmaFrom }),
  });
}

const fixed = (x: number | null, digits = 2): string => (x === null ? 'n/a' : x.toFixed(digits));
const header = (first: string): string[] => [
  `| ${first} | ${LOG_HALF_WIDTHS.map((h) => `±${String(h * 100)} %`).join(' | ')} |`,
  `|---|${LOG_HALF_WIDTHS.map(() => '---:').join('|')}|`,
];

function netLogChange(series: PriceSeries): number {
  const first = series.prices[0];
  const last = series.prices[series.prices.length - 1];
  return first === undefined || last === undefined ? 0 : Math.log(last / first);
}

/** "median [lo–hi]" of values, with lo and hi at quantiles qLow and qHigh. */
function band(values: readonly number[], qLow: number, qHigh: number, digits = 2): string {
  const sorted = [...values].sort((a, b) => a - b);
  return `${fixed(quantile(sorted, 0.5), digits)} [${fixed(quantile(sorted, qLow), digits)}–${fixed(quantile(sorted, qHigh), digits)}]`;
}

/** The value at quantile q of sorted numbers (nearest rank). */
function quantile(sorted: readonly number[], q: number): number | null {
  if (sorted.length === 0) {
    return null;
  }
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? null;
}

function surrogateSection(series: PriceSeries, stepSeconds: number, seeds: number): string {
  const lines = [
    '### Median T / E[T] on surrogate paths',
    '',
    `E[T] corrected for checks at closes; σ from the 30 daily closes before opening, re-estimated on each path ("own σ"), or for sign-randomised paths, which keep the actual sizes of moves in place, also taken from the actual prices on the same date ("actual σ"). Model ${exitTimeQuantileFromCentre(0.5).toFixed(3)}. For surrogates: median over ${String(seeds)} seeds, with the 10th–90th percentile of the seeds in brackets (nearest rank). Brackets measure the method's noise, not uncertainty about the market.`,
    '',
    ...header('Path'),
    `| Actual prices | ${medians(run(series, DAILY_30, stepSeconds))
      .map((m) => fixed(m))
      .join(' | ')} |`,
  ];
  const kinds: [string, (s: PriceSeries, seed: number) => PriceSeries][] = [
    ['Signs randomised (keeps clustering)', signFlipped],
    ['Returns shuffled (keeps fat tails only)', shuffled],
    ['Gaussian walk (the model)', gaussianWalk],
  ];
  for (const [label, make] of kinds) {
    // Borrowing the actual σ only makes sense where the path keeps the actual
    // sizes of moves in place; shuffled and Gaussian paths move their volatility.
    const conventions =
      make === signFlipped
        ? ([
            ['own σ', false],
            ['actual σ', true],
          ] as const)
        : ([['own σ', false]] as const);
    for (const [convention, useActual] of conventions) {
      const perWidth: number[][] = LOG_HALF_WIDTHS.map(() => []);
      for (let seed = 1; seed <= seeds; seed++) {
        const path = make(series, seed);
        medians(run(path, DAILY_30, stepSeconds, useActual ? series : undefined)).forEach(
          (m, w) => {
            if (m !== null) {
              perWidth[w]?.push(m);
            }
          },
        );
      }
      lines.push(
        `| ${label}, ${convention} | ${perWidth.map((v) => band(v, 0.1, 0.9)).join(' | ')} |`,
      );
    }
  }
  lines.push('');
  return lines.join('\n');
}

function tailSection(series: PriceSeries, stepSeconds: number, seeds: number): string {
  const widest = LOG_HALF_WIDTHS[LOG_HALF_WIDTHS.length - 1] ?? 0;
  const tails = (outcomes: readonly PositionOutcome[]): [number | null, number | null] => {
    const [early, late] = calibration(
      outcomes.filter((o) => o.logHalfWidth === widest),
      [0.25, 2],
      'discrete',
    );
    const stillIn = late?.observedExited;
    return [
      early?.observedExited ?? null,
      stillIn === null || stillIn === undefined ? null : 1 - stillIn,
    ];
  };
  const pct = (x: number | null): string => (x === null ? 'n/a' : `${(x * 100).toFixed(1)} %`);
  const [actualEarly, actualLate] = tails(run(series, DAILY_30, stepSeconds));
  const lines = [
    `### Tails at ±${String(widest * 100)} %`,
    '',
    `Share exited by 0.25 · E[T] and share still in range at 2 · E[T], E[T] corrected for checks at closes (model ${pct(1 - exitSurvivalFromCentre(0.25))} and ${pct(exitSurvivalFromCentre(2))}). Surrogates: median [10th–90th percentile] over ${String(seeds)} seeds, own σ.`,
    '',
    '| Path | Exited by 0.25 · E[T] | Still in range at 2 · E[T] |',
    '|---|---:|---:|',
    `| Actual prices | ${pct(actualEarly)} | ${pct(actualLate)} |`,
  ];
  const kinds: [string, (s: PriceSeries, seed: number) => PriceSeries][] = [
    ['Signs randomised', signFlipped],
    ['Returns shuffled', shuffled],
    ['Gaussian walk', gaussianWalk],
  ];
  for (const [label, make] of kinds) {
    const early: number[] = [];
    const late: number[] = [];
    for (let seed = 1; seed <= seeds; seed++) {
      const [e, l] = tails(run(make(series, seed), DAILY_30, stepSeconds));
      if (e !== null) early.push(e * 100);
      if (l !== null) late.push(l * 100);
    }
    lines.push(`| ${label} | ${band(early, 0.1, 0.9, 1)} % | ${band(late, 0.1, 0.9, 1)} % |`);
  }
  lines.push('');
  return lines.join('\n');
}

function pairedSection(series: PriceSeries, stepSeconds: number): string {
  const long = run(series, DAILY_30, stepSeconds);
  const short = run(series, INTRADAY_7, stepSeconds);
  const common = new Set(long.map((o) => o.openedAtSeconds));
  const shortCommon = short.filter((o) => common.has(o.openedAtSeconds));
  const opens = new Set(shortCommon.map((o) => o.openedAtSeconds)).size;
  return [
    `### 7-day and 30-day σ on the same ${String(opens)} opening dates`,
    '',
    'Median T / E[T], E[T] corrected for checks at closes.',
    '',
    ...header('σ estimator'),
    `| 30 daily closes | ${medians(
      long.filter(
        (o) => opens > 0 && shortCommon.some((s) => s.openedAtSeconds === o.openedAtSeconds),
      ),
    )
      .map((m) => fixed(m))
      .join(' | ')} |`,
    `| 7 days of samples | ${medians(shortCommon)
      .map((m) => fixed(m))
      .join(' | ')} |`,
    '',
  ].join('\n');
}

function varianceSection(
  series: PriceSeries,
  step: Args['step'],
  stepSeconds: number,
  seeds: number,
): string {
  const horizons = HORIZONS[step];
  const nulls: number[][] = horizons.map(() => []);
  for (let seed = 1; seed <= seeds; seed++) {
    const path = signFlipped(series, seed);
    horizons.forEach(([, k], h) => nulls[h]?.push(varianceRatio(path, stepSeconds, k)));
  }
  return [
    `### Variance ratio by horizon (one step = 1 ${step})`,
    '',
    `1 for a random walk; below 1 when moves partly reverse. The second row is the same statistic on ${String(seeds)} sign-randomised paths (no reversal, same clustering): median [5th–95th percentile, nearest rank]. An actual value inside that range is not distinguishable from no reversal.`,
    '',
    `| Path | ${horizons.map(([label]) => label).join(' | ')} |`,
    `|---|${horizons.map(() => '---:').join('|')}|`,
    `| Actual prices | ${horizons.map(([, k]) => varianceRatio(series, stepSeconds, k).toFixed(2)).join(' | ')} |`,
    `| Signs randomised | ${nulls.map((v) => band(v, 0.05, 0.95)).join(' | ')} |`,
    '',
    `Net log change over the period (drift, which randomising signs removes): ${netLogChange(series).toFixed(2)}.`,
    '',
  ].join('\n');
}

function forecastSection(series: PriceSeries, stepSeconds: number): string {
  const rows = sigmaForecasts(series, { stepSeconds, shortDays: 7, longDays: 30, aheadDays: 7 });
  const forecasts: [string, (r: SigmaForecastRow) => number][] = [
    ['Trailing 7 days', (r): number => r.trailingShort],
    ['Trailing 30 days', (r): number => r.trailingLong],
    ['Geometric mean of both', (r): number => Math.sqrt(r.trailingShort * r.trailingLong)],
  ];
  const regimes: [string, (r: SigmaForecastRow) => boolean][] = [
    ['All days', (): boolean => true],
    [
      'After a rise (7-day σ > 1.25 × 30-day)',
      (r): boolean => r.trailingShort > 1.25 * r.trailingLong,
    ],
    [
      'After a fall (7-day σ < 0.8 × 30-day)',
      (r): boolean => r.trailingShort < 0.8 * r.trailingLong,
    ],
  ];
  const lines = [
    '### Trailing σ against the σ of the next 7 days',
    '',
    'All σ from the same one-step returns. Cells: median ln(forecast / realised) (> 0: too high), then root mean square, then days.',
    '',
    `| Days | ${forecasts.map(([label]) => label).join(' | ')} |`,
    `|---|${forecasts.map(() => '---:').join('|')}|`,
  ];
  for (const [label, keep] of regimes) {
    const subset = rows.filter(keep);
    const cells = forecasts.map(([, f]) => {
      const e = forecastError(subset, f);
      return e === null
        ? 'n/a'
        : `${e.medianLogError.toFixed(2)}, ${e.rmsLogError.toFixed(2)} (n ${String(e.count)})`;
    });
    lines.push(`| ${label} | ${cells.join(' | ')} |`);
  }
  lines.push('');
  return lines.join('\n');
}

/** Runs the diagnostics; returns the process exit code. */
export async function main(argv: readonly string[], deps: StudyDeps): Promise<number> {
  const args = parseDiagnosticsArgs(argv);
  if (args === null) {
    deps.err(`${USAGE}\n`);
    return 2;
  }
  const stepSeconds: GranularitySeconds = args.step === 'hour' ? 3600 : 60;
  const series = crossPrice(
    await closes('BTC-USD', stepSeconds, args, deps),
    await closes('SOL-USD', stepSeconds, args, deps),
  );
  const day = (s: number): string => new Date(s * 1000).toISOString().slice(0, 10);
  deps.out(
    [
      `## Diagnostics: SOL per BTC, ${args.step} closes, ${day(args.fromSeconds)} to ${day(args.toSeconds)}`,
      '',
      varianceSection(series, args.step, stepSeconds, args.seeds),
      surrogateSection(series, stepSeconds, args.seeds),
      tailSection(series, stepSeconds, args.seeds),
      pairedSection(series, stepSeconds),
      forecastSection(series, stepSeconds),
    ].join('\n'),
  );
  return 0;
}

/* c8 ignore next -- process wiring, as in exit-time-study.ts */
runIfScript(import.meta.url, main);
