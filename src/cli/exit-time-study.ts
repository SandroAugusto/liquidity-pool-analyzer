/**
 * `pnpm exit-time-study --from YYYY-MM-DD --to YYYY-MM-DD [--step hour|minute]`
 *
 * Downloads public BTC-USD and SOL-USD candles from Coinbase, builds the SOL per
 * BTC price, opens synthetic centred positions once a day and compares their
 * exit times with the model (src/research/exit-time.ts, ADR-0005, ADR-0006).
 * Prints a Markdown report of aggregate statistics only. Raw prices are cached
 * under `.cache/` (gitignored) and never committed.
 *
 * Side effects (network, disk, output) are injected into {@link main}.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import { fetchCloses } from '../adapters/coinbase/index.js';
import type { GranularitySeconds, HttpGetJson } from '../adapters/coinbase/index.js';
import { exitTimeQuantileFromCentre } from '../math/index.js';
import {
  calibration,
  crossPrice,
  observedQuantile,
  simulateCentredPositions,
} from '../research/exit-time.js';
import type { PositionOutcome, SigmaEstimator } from '../research/exit-time.js';

const USAGE = 'usage: pnpm exit-time-study --from YYYY-MM-DD --to YYYY-MM-DD [--step hour|minute]';

export const LOG_HALF_WIDTHS = [0.01, 0.02, 0.04, 0.08] as const;
export const CALIBRATION_CS = [0.25, 0.5, 1, 2] as const;
const SECONDS_PER_DAY = 86_400;

export interface StudyDeps {
  readonly get: HttpGetJson;
  readonly readCache: (key: string) => Promise<string | null>;
  readonly writeCache: (key: string, contents: string) => Promise<void>;
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
}

interface Args {
  readonly fromSeconds: number;
  readonly toSeconds: number;
  readonly step: 'hour' | 'minute';
}

function parseDay(value: string | undefined): number | null {
  if (value === undefined || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return null;
  }
  const ms = Date.parse(`${value}T00:00:00Z`);
  return Number.isNaN(ms) ? null : ms / 1000;
}

export function parseArgs(argv: readonly string[]): Args | null {
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (key === undefined || value === undefined || !key.startsWith('--') || values.has(key)) {
      return null;
    }
    values.set(key, value);
  }
  for (const key of values.keys()) {
    if (!['--from', '--to', '--step'].includes(key)) {
      return null;
    }
  }
  const fromSeconds = parseDay(values.get('--from'));
  const toSeconds = parseDay(values.get('--to'));
  const step = values.get('--step') ?? 'hour';
  if (fromSeconds === null || toSeconds === null || toSeconds <= fromSeconds) {
    return null;
  }
  if (step !== 'hour' && step !== 'minute') {
    return null;
  }
  return { fromSeconds, toSeconds, step };
}

async function closes(
  product: string,
  granularitySeconds: GranularitySeconds,
  args: Args,
  deps: StudyDeps,
): Promise<Map<number, number>> {
  const key = `coinbase-${product}-${String(granularitySeconds)}-${String(args.fromSeconds)}-${String(args.toSeconds)}.json`;
  const cached = await deps.readCache(key);
  if (cached !== null) {
    return new Map(JSON.parse(cached) as [number, number][]);
  }
  const fetched = await fetchCloses(
    { product, granularitySeconds, startSeconds: args.fromSeconds, endSeconds: args.toSeconds },
    deps.get,
  );
  await deps.writeCache(key, JSON.stringify([...fetched]));
  return fetched;
}

const pct = (x: number | null): string => (x === null ? 'n/a' : `${(x * 100).toFixed(1)} %`);
const fixed = (x: number | null, digits = 2): string => (x === null ? 'n/a' : x.toFixed(digits));

function grid(): number[] {
  return Array.from({ length: 1000 }, (_, i) => (i + 1) / 100);
}

export function formatSection(title: string, outcomes: readonly PositionOutcome[]): string {
  const modelMedian = exitTimeQuantileFromCentre(0.5);
  const lines = [
    `### ${title}`,
    '',
    `| Log half-width | Positions | Still open at end | Observed median of T / E[T] (model ${modelMedian.toFixed(3)}) | Same, E[T] corrected for checks at closes only | ${CALIBRATION_CS.map((c) => `Exited by ${String(c)}·E[T]: observed / model (positions watched that long)`).join(' | ')} |`,
    `|---|---:|---:|---:|---:|${CALIBRATION_CS.map(() => '---:').join('|')}|`,
  ];
  for (const h of LOG_HALF_WIDTHS) {
    const subset = outcomes.filter((o) => o.logHalfWidth === h);
    const open = subset.filter((o) => o.exitDays === null).length;
    const median = observedQuantile(subset, 0.5, grid());
    const medianDiscrete = observedQuantile(subset, 0.5, grid(), 'discrete');
    const cells = calibration(subset, CALIBRATION_CS).map(
      (r) => `${pct(r.observedExited)} / ${pct(r.modelExited)} (n ${String(r.eligible)})`,
    );
    lines.push(
      `| ±${String(h * 100)} % | ${String(subset.length)} | ${String(open)} | ${fixed(median)} | ${fixed(medianDiscrete)} | ${cells.join(' | ')} |`,
    );
  }
  lines.push('');
  return lines.join('\n');
}

/** Runs the study; returns the process exit code. */
export async function main(argv: readonly string[], deps: StudyDeps): Promise<number> {
  const args = parseArgs(argv);
  if (args === null) {
    deps.err(`${USAGE}\n`);
    return 2;
  }
  const granularitySeconds: GranularitySeconds = args.step === 'hour' ? 3600 : 60;
  const btc = await closes('BTC-USD', granularitySeconds, args, deps);
  const sol = await closes('SOL-USD', granularitySeconds, args, deps);
  const series = crossPrice(btc, sol);

  const estimators: [string, SigmaEstimator][] = [
    ['σ from the 30 daily closes before opening', { kind: 'trailingDaily', days: 30 }],
    ['σ from the 7 days of samples before opening', { kind: 'trailingIntraday', days: 7 }],
  ];
  const sections = estimators.map(([title, sigma]) =>
    formatSection(
      title,
      simulateCentredPositions(series, {
        logHalfWidths: LOG_HALF_WIDTHS,
        openEverySeconds: SECONDS_PER_DAY,
        sigma,
        stepSeconds: granularitySeconds,
      }),
    ),
  );
  const gridTimes = (args.toSeconds - args.fromSeconds) / granularitySeconds;
  const missingBoth = gridTimes - series.prices.length - series.droppedSamples;
  const day = (s: number): string => new Date(s * 1000).toISOString().slice(0, 10);
  deps.out(
    [
      `## SOL per BTC, ${args.step} closes, ${day(args.fromSeconds)} to ${day(args.toSeconds)}`,
      '',
      `Source: Coinbase Exchange public candles, BTC-USD / SOL-USD. ${String(series.prices.length)} samples; ${String(series.droppedSamples)} times dropped because one product had no candle, and ${String(missingBoth)} with no candle for either.`,
      '',
      ...sections,
    ].join('\n'),
  );
  return 0;
}

/* c8 ignore start -- process wiring; everything it calls is tested through main() */
const CACHE_DIR = '.cache';

async function getJson(url: string): Promise<unknown> {
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(url, {
      headers: { 'User-Agent': 'liquidity-pool-analyzer research' },
    });
    if (response.ok) {
      return await response.json();
    }
    if (attempt >= 5 || (response.status !== 429 && response.status < 500)) {
      throw new Error(`GET ${url} failed: ${String(response.status)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2), {
    get: getJson,
    readCache: async (key) => {
      try {
        return await readFile(`${CACHE_DIR}/${key}`, 'utf8');
      } catch {
        return null;
      }
    },
    writeCache: async (key, contents) => {
      await mkdir(CACHE_DIR, { recursive: true });
      await writeFile(`${CACHE_DIR}/${key}`, contents);
    },
    out: (text) => process.stdout.write(text),
    err: (text) => process.stderr.write(text),
  }).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      process.stderr.write(`${String(error)}\n`);
      process.exitCode = 1;
    },
  );
}
/* c8 ignore stop */
