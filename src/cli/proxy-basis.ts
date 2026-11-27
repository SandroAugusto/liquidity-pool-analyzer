/**
 * `pnpm proxy-basis <snapshots.jsonl> [more.jsonl …]`
 *
 * Compares each Orca WBTC/SOL pool's price in the fee snapshots (ADR-0007) with
 * the Coinbase BTC-USD / SOL-USD cross price the exit-time study uses
 * (ADR-0006), on minute closes. Prints a Markdown report of aggregates per
 * pool (src/research/proxy-basis.ts). The snapshots are public protocol
 * accounts, read from the `data/fee-growth` branch, for example:
 *
 * ```sh
 * git fetch origin data/fee-growth
 * git show origin/data/fee-growth:fee-growth/2026-11.jsonl > .cache/fee-2026-11.jsonl
 * pnpm proxy-basis .cache/fee-2026-11.jsonl
 * ```
 *
 * Side effects (files, network, cache, output) are injected into {@link main}.
 */

import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import { crossPrice } from '../research/exit-time.js';
import { parseSnapshotLines } from '../research/fee-snapshots.js';
import type { PoolSnapshot } from '../research/fee-snapshots.js';
import { matchBasis, summarizeBasis } from '../research/proxy-basis.js';
import type { BasisSummary } from '../research/proxy-basis.js';
import { closes, processDeps } from './exit-time-study.js';
import type { StudyDeps } from './exit-time-study.js';

const USAGE = 'usage: pnpm proxy-basis <snapshots.jsonl> [more.jsonl …]';
const STEP_SECONDS = 60;

export interface ProxyDeps extends StudyDeps {
  readonly readText: (path: string) => Promise<string>;
}

/** Basis points of a log ratio, for display only. */
const bp = (x: number | null): string => (x === null ? 'n/a' : (x * 10_000).toFixed(1));

export function formatTable(summaries: readonly BasisSummary[]): string {
  const lines = [
    '| Pool | Fee | Snapshots | Median liquidity | Median basis (bp) | 5th–95th pct (bp) | Max abs (bp) | Intervals | RMS basis change (bp) | RMS reference return (bp) |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|',
  ];
  for (const x of summaries) {
    lines.push(
      `| \`${x.pool}\` | ${(x.feeRate * 100).toFixed(2)} % | ${String(x.observations)} | ${x.medianLiquidity.toPrecision(3)} | ${bp(x.medianLogBasis)} | ${bp(x.p05LogBasis)} to ${bp(x.p95LogBasis)} | ${bp(x.maxAbsLogBasis)} | ${String(x.intervals)} | ${bp(x.rmsBasisChange)} | ${bp(x.rmsReferenceReturn)} |`,
    );
  }
  return lines.join('\n');
}

/** Runs the comparison; returns the process exit code. */
export async function main(argv: readonly string[], deps: ProxyDeps): Promise<number> {
  if (argv.length === 0 || argv.some((a) => a.startsWith('-'))) {
    deps.err(`${USAGE}\n`);
    return 2;
  }
  const snapshots: PoolSnapshot[] = [];
  for (const path of argv) {
    snapshots.push(...parseSnapshotLines(await deps.readText(path)));
  }
  if (snapshots.length === 0) {
    deps.err('No snapshots in the given files.\n');
    return 1;
  }
  const times = snapshots.map((x) => x.observedAt.getTime() / 1000);
  const bucket = (t: number): number => Math.floor(t / STEP_SECONDS) * STEP_SECONDS;
  // matchBasis uses the bucket that closes at or before each snapshot.
  const args = {
    fromSeconds: bucket(Math.min(...times)) - STEP_SECONDS,
    toSeconds: bucket(Math.max(...times)),
    step: 'minute' as const,
  };
  const btc = await closes('BTC-USD', STEP_SECONDS, args, deps);
  const sol = await closes('SOL-USD', STEP_SECONDS, args, deps);
  const reference = crossPrice(btc, sol);
  const match = matchBasis(snapshots, reference, STEP_SECONDS);
  const summaries = summarizeBasis(match.observations);
  const iso = (t: number): string => new Date(t * 1000).toISOString().slice(0, 16);
  deps.out(
    [
      `## Orca pool price vs. Coinbase cross price, ${iso(Math.min(...times))}Z to ${iso(Math.max(...times))}Z`,
      '',
      `${String(snapshots.length)} snapshots; ${String(match.skippedNoLiquidity)} skipped for a pool with no active liquidity (its price is stale), ${String(match.skippedNoReference)} with no Coinbase minute close for both products.`,
      '',
      'Basis is ln(pool price / Coinbase BTC-USD ÷ SOL-USD close of the last minute that ended before the snapshot), in basis points. A constant basis does not change exit times; the RMS change between consecutive snapshots of a pool does, and is shown next to the reference’s own RMS log return over the same intervals. The minute lag adds noise of about σ · √60 s to both.',
      '',
      formatTable(summaries),
      '',
    ].join('\n'),
  );
  return 0;
}

/* c8 ignore start -- process wiring; everything it calls is tested through main() */
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2), {
    ...processDeps(),
    readText: (path) => readFile(path, 'utf8'),
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
