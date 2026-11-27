/**
 * `pnpm exit-time-forecast --from YYYY-MM-DD --to YYYY-MM-DD --split YYYY-MM-DD [--boot N]`
 *
 * Out-of-sample test of forecasts of time in range (src/research/forecast.ts):
 * the model's quantiles against quantiles measured on earlier positions, with
 * and without volatility regimes, with the 30-day or a blended σ. Runs both
 * directions (train before the split and test after, then the reverse), with a
 * 30-day embargo before the split. Prints aggregates only.
 */

import type { GranularitySeconds } from '../adapters/coinbase/index.js';
import { crossPrice, simulateCentredPositions } from '../research/exit-time.js';
import type { PriceSeries, SigmaEstimator } from '../research/exit-time.js';
import {
  blockResample,
  calibrationError,
  coverage,
  fit,
  forecastCases,
  METHODS,
  PROBABILITIES,
  regimeCuts,
  splitCases,
} from '../research/forecast.js';
import type { ForecastCase } from '../research/forecast.js';
import { closes, LOG_HALF_WIDTHS, parseArgs, runIfScript } from './exit-time-study.js';
import type { Args, StudyDeps } from './exit-time-study.js';

const USAGE =
  'usage: pnpm exit-time-forecast --from YYYY-MM-DD --to YYYY-MM-DD --split YYYY-MM-DD [--step hour|minute] [--boot N]';
const SECONDS_PER_DAY = 86_400;
const EMBARGO_DAYS = 30;
const BLOCK_DAYS = 30;

function take(argv: string[], flag: string): string | null | undefined {
  const at = argv.indexOf(flag);
  if (at === -1) {
    return undefined;
  }
  const value = argv[at + 1];
  argv.splice(at, 2);
  return value ?? null;
}

export function parseForecastArgs(
  argv: readonly string[],
): (Args & { splitSeconds: number; boot: number }) | null {
  const rest = [...argv];
  const split = take(rest, '--split');
  const boot = take(rest, '--boot');
  if (split === undefined || split === null || !/^\d{4}-\d{2}-\d{2}$/.test(split)) {
    return null;
  }
  if (boot === null || (boot !== undefined && !/^[1-9]\d{0,3}$/.test(boot))) {
    return null;
  }
  const splitSeconds = Date.parse(`${split}T00:00:00Z`) / 1000;
  const args = parseArgs(rest);
  if (
    args === null ||
    Number.isNaN(splitSeconds) ||
    splitSeconds <= args.fromSeconds ||
    splitSeconds >= args.toSeconds
  ) {
    return null;
  }
  return { ...args, splitSeconds, boot: boot === undefined ? 200 : Number(boot) };
}

const fixed = (x: number | null, digits = 2): string => (x === null ? 'n/a' : x.toFixed(digits));

function quantile(sorted: readonly number[], q: number): number | null {
  return sorted.length === 0
    ? null
    : (sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? null);
}

function directionSection(
  title: string,
  train: readonly ForecastCase[],
  test: readonly ForecastCase[],
  stepSeconds: number,
  boot: number,
): string {
  const cuts = regimeCuts(train);
  const fitted = METHODS.map((m) => fit(m, train, stepSeconds));
  const widths = LOG_HALF_WIDTHS.map((h) => `±${String(h * 100)} %`);
  const lines = [
    `### ${title}`,
    '',
    `${String(new Set(train.map((c) => c.openedAtSeconds)).size)} training and ${String(new Set(test.map((c) => c.openedAtSeconds)).size)} test opening days. Regime terciles of 7-day σ / 30-day σ, cut on the training days: below ${cuts[0].toFixed(2)}, ${cuts[0].toFixed(2)}–${cuts[1].toFixed(2)}, above ${cuts[1].toFixed(2)}.`,
    '',
    `Mean |coverage − target| over the three regimes and the 10th, 50th and 90th percentiles (0 is calibrated). In brackets: 10th–90th percentile of the difference from the baseline (${METHODS[1]?.name ?? ''}) over ${String(boot)} paired block-bootstrap resamples of the test days (${String(BLOCK_DAYS)}-day blocks); a bracket entirely below 0 means better than the baseline on these resamples.`,
    '',
    `| Method | ${widths.join(' | ')} |`,
    `|---|${widths.map(() => '---:').join('|')}|`,
  ];
  // Paired bootstrap: every method is scored on the same resamples, and the
  // band is for its difference from the baseline, which cancels most of the
  // upward bias that resampling gives a mean of absolute errors.
  const baseline = 1;
  const resamples = LOG_HALF_WIDTHS.map((h) => {
    const subset = test.filter((c) => c.logHalfWidth === h);
    return Array.from({ length: boot }, (_, k) => blockResample(subset, BLOCK_DAYS, k + 1));
  });
  const scores = METHODS.map((m, i) =>
    LOG_HALF_WIDTHS.map((h, w) => {
      const f = fitted[i];
      const subset = test.filter((c) => c.logHalfWidth === h);
      return {
        point: f === undefined ? null : calibrationError(subset, f, m, cuts, stepSeconds),
        boot: (resamples[w] ?? []).map((r) =>
          f === undefined ? null : calibrationError(r, f, m, cuts, stepSeconds),
        ),
      };
    }),
  );
  METHODS.forEach((m, i) => {
    const cells = LOG_HALF_WIDTHS.map((_, w) => {
      const own = scores[i]?.[w];
      const base = scores[baseline]?.[w];
      if (own === undefined || base === undefined) {
        return 'n/a';
      }
      if (i === baseline) {
        return `${fixed(own.point, 3)} (baseline)`;
      }
      const diffs: number[] = [];
      own.boot.forEach((e, k) => {
        const b = base.boot[k];
        if (e !== null && b !== null && b !== undefined) {
          diffs.push(e - b);
        }
      });
      diffs.sort((a, b) => a - b);
      const signed = (x: number | null): string =>
        x === null ? 'n/a' : `${x >= 0 ? '+' : ''}${x.toFixed(3)}`;
      return `${fixed(own.point, 3)} [${signed(quantile(diffs, 0.1))} to ${signed(quantile(diffs, 0.9))}]`;
    });
    lines.push(`| ${m.name} | ${cells.join(' | ')} |`);
  });
  lines.push(
    '',
    `Coverage of the predicted 10th / 50th / 90th percentiles of T, all regimes together (targets ${PROBABILITIES.join(' / ')}).`,
    '',
    `| Method | ${widths.join(' | ')} |`,
    `|---|${widths.map(() => '---:').join('|')}|`,
  );
  METHODS.forEach((m, i) => {
    const f = fitted[i];
    if (f === undefined) {
      return;
    }
    const cells = LOG_HALF_WIDTHS.map((h) => {
      const subset = test.filter((c) => c.logHalfWidth === h);
      return PROBABILITIES.map((p) => fixed(coverage(subset, f, m, p, stepSeconds).covered)).join(
        ' / ',
      );
    });
    lines.push(`| ${m.name} | ${cells.join(' | ')} |`);
  });
  lines.push('');
  return lines.join('\n');
}

export async function main(argv: readonly string[], deps: StudyDeps): Promise<number> {
  const args = parseForecastArgs(argv);
  if (args === null) {
    deps.err(`${USAGE}\n`);
    return 2;
  }
  const stepSeconds: GranularitySeconds = args.step === 'hour' ? 3600 : 60;
  const series: PriceSeries = crossPrice(
    await closes('BTC-USD', stepSeconds, args, deps),
    await closes('SOL-USD', stepSeconds, args, deps),
  );
  const run = (sigma: SigmaEstimator): ReturnType<typeof simulateCentredPositions> =>
    simulateCentredPositions(series, {
      logHalfWidths: LOG_HALF_WIDTHS,
      openEverySeconds: SECONDS_PER_DAY,
      sigma,
      stepSeconds,
    });
  const cases = forecastCases(
    run({ kind: 'trailingDaily', days: 30 }),
    run({ kind: 'trailingIntraday', days: 7 }),
  );
  const day = (s: number): string => new Date(s * 1000).toISOString().slice(0, 10);
  const sections: string[] = [];
  for (const [title, reverse] of [
    [
      `Train on positions opened before ${day(args.splitSeconds - EMBARGO_DAYS * SECONDS_PER_DAY)}, test from ${day(args.splitSeconds)}`,
      false,
    ],
    [
      `Train on positions opened from ${day(args.splitSeconds)}, test before ${day(args.splitSeconds - EMBARGO_DAYS * SECONDS_PER_DAY)}`,
      true,
    ],
  ] as const) {
    const { train, test } = splitCases(cases, args.splitSeconds, EMBARGO_DAYS, reverse);
    if (train.length < 3 || test.length === 0) {
      sections.push(`### ${title}\n\nNot enough positions on one side of the split.\n`);
      continue;
    }
    sections.push(directionSection(title, train, test, stepSeconds, args.boot));
  }
  deps.out(
    [
      `## Forecasting time in range: SOL per BTC, ${args.step} closes, ${day(args.fromSeconds)} to ${day(args.toSeconds)}`,
      '',
      ...sections,
    ].join('\n'),
  );
  return 0;
}

/* c8 ignore next -- process wiring, as in exit-time-study.ts */
runIfScript(import.meta.url, main);
