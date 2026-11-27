/**
 * Is the Coinbase cross price a fair stand-in for an Orca pool's price?
 *
 * The exit-time study (docs/research/exit-time.md, ADR-0006) builds SOL per BTC
 * from Coinbase BTC-USD / SOL-USD candles. A position lives in a pool, whose
 * price is WBTC in SOL on chain, moved by swaps and arbitrage. This module
 * compares the two on the project's own fee snapshots (ADR-0007).
 *
 * Two different questions, kept apart:
 *
 * - **Level** (`logBasis`): ln(pool price / reference price). A constant offset
 *   does not change exit times, since a position is centred on its own pool's
 *   price.
 * - **Changes** (`basisChange`): how much the basis moves between two snapshots
 *   of the same pool. This is what the reference misses about the pool's path,
 *   and what can make exit times on the reference differ from exit times on the
 *   pool. It is compared with the reference's own log return over the same
 *   interval.
 *
 * Prices are quote per base throughout (SOL per WBTC). Basis values are natural
 * log ratios, plain numbers: 0.001 is about 0.1 %.
 *
 * A basis only means something when both prices quote the same pair the same
 * way round. The reference carries no pair of its own, so the caller states
 * which pair it prices ({@link ReferencePair}) and every snapshot is checked
 * against it: a pool of another pair, or the same pair reversed, is refused
 * rather than compared.
 */

import { quotePerBase } from '../math/index.js';
import type { QuotePerBase } from '../math/index.js';
import { at } from './at.js';
import type { PriceSeries } from './exit-time.js';
import type { PoolSnapshot } from './fee-snapshots.js';

/** The pair the reference prices, as token mints: the reference is `quoteMint` per `baseMint`. */
export interface ReferencePair {
  readonly baseMint: string;
  readonly quoteMint: string;
}

/** A snapshot of a pool whose pair, or whose price direction, is not the reference's. */
export class PairMismatchError extends RangeError {
  constructor(pool: string, found: ReferencePair, expected: ReferencePair) {
    const reversed = found.baseMint === expected.quoteMint && found.quoteMint === expected.baseMint;
    super(
      `Pool ${pool} ${reversed ? 'quotes the pair in reverse' : 'is of another pair'}: ` +
        `base ${found.baseMint}, quote ${found.quoteMint}; the reference is ` +
        `base ${expected.baseMint}, quote ${expected.quoteMint}`,
    );
    this.name = 'PairMismatchError';
  }
}

/**
 * Throws {@link PairMismatchError} unless every snapshot is of `pair`, with the
 * same base and quote. Nothing is normalised: a reversed reading is refused,
 * not inverted.
 */
export function assertSnapshotsOfPair(
  snapshots: readonly PoolSnapshot[],
  pair: ReferencePair,
): void {
  for (const { reading } of snapshots) {
    const found = { baseMint: reading.pair.base.mint, quoteMint: reading.pair.quote.mint };
    if (found.baseMint !== pair.baseMint || found.quoteMint !== pair.quoteMint) {
      throw new PairMismatchError(reading.source.pool, found, pair);
    }
  }
}

/** One snapshot of one pool matched with the reference. */
export interface BasisObservation {
  readonly pool: string;
  /** Pool fee as a fraction. */
  readonly feeRate: number;
  /** Active liquidity at the snapshot, model units. */
  readonly liquidity: number;
  /** When the snapshot was observed, epoch seconds. */
  readonly observedAtSeconds: number;
  /** Time of the reference close used, epoch seconds; at or before `observedAtSeconds`. */
  readonly referenceAtSeconds: number;
  /** Pool price, quote per base. */
  readonly poolPrice: QuotePerBase;
  /** Reference price, quote per base. */
  readonly referencePrice: QuotePerBase;
  /** ln(pool price / reference price). */
  readonly logBasis: number;
}

export interface BasisMatch {
  readonly observations: readonly BasisObservation[];
  /**
   * Snapshots of pools with no active liquidity. Their price is the last one a
   * swap left behind, possibly long ago, so it says nothing about the market.
   */
  readonly skippedNoLiquidity: number;
  /** Snapshots with no reference close at the matching time. */
  readonly skippedNoReference: number;
}

/**
 * Matches every snapshot with the reference close of the last complete bucket
 * before it. A bucket that starts at `b` closes at `b + stepSeconds`, so the
 * reference price used is the one at ⌊t / step⌋ · step: never after the
 * snapshot, and at most one step before it. That lag adds noise of about
 * σ · √step to every observation, which the report states.
 *
 * `reference.timesSeconds` are bucket starts, as from the Coinbase adapter.
 * `reference.prices` are quote per base of `referencePair`; each one is
 * validated here ({@link quotePerBase}), so a zero, negative or non-finite
 * price throws instead of becoming an infinite or `NaN` basis. Every snapshot
 * must be of `referencePair` ({@link assertSnapshotsOfPair}).
 */
export function matchBasis(
  snapshots: readonly PoolSnapshot[],
  reference: PriceSeries,
  stepSeconds: number,
  referencePair: ReferencePair,
): BasisMatch {
  if (!Number.isInteger(stepSeconds) || stepSeconds <= 0) {
    throw new RangeError(`stepSeconds must be a positive integer, got ${String(stepSeconds)}`);
  }
  if (reference.timesSeconds.length !== reference.prices.length) {
    throw new RangeError('reference times and prices must have the same length');
  }
  assertSnapshotsOfPair(snapshots, referencePair);
  const byBucketStart = new Map<number, QuotePerBase>();
  reference.timesSeconds.forEach((t, i) => {
    byBucketStart.set(t, quotePerBase(at(reference.prices, i)));
  });
  const observations: BasisObservation[] = [];
  let skippedNoLiquidity = 0;
  let skippedNoReference = 0;
  for (const { observedAt, reading } of snapshots) {
    if (!(reading.liquidity > 0)) {
      skippedNoLiquidity++;
      continue;
    }
    const observedAtSeconds = observedAt.getTime() / 1000;
    const referenceAtSeconds = Math.floor(observedAtSeconds / stepSeconds) * stepSeconds;
    const referencePrice = byBucketStart.get(referenceAtSeconds - stepSeconds);
    if (referencePrice === undefined) {
      skippedNoReference++;
      continue;
    }
    observations.push({
      pool: reading.source.pool,
      feeRate: reading.feeRate,
      liquidity: reading.liquidity,
      observedAtSeconds,
      referenceAtSeconds,
      poolPrice: reading.price,
      referencePrice,
      logBasis: Math.log(reading.price / referencePrice),
    });
  }
  return { observations, skippedNoLiquidity, skippedNoReference };
}

/** Summary of one pool. Quantiles are nearest-rank. */
export interface BasisSummary {
  readonly pool: string;
  readonly feeRate: number;
  readonly observations: number;
  readonly medianLiquidity: number;
  readonly medianLogBasis: number;
  readonly p05LogBasis: number;
  readonly p95LogBasis: number;
  readonly maxAbsLogBasis: number;
  /** Pairs of consecutive observations of this pool. */
  readonly intervals: number;
  /** Root mean square of the change in log basis between consecutive observations; null without intervals. */
  readonly rmsBasisChange: number | null;
  /** Root mean square of the reference's log return over the same intervals; null without intervals. */
  readonly rmsReferenceReturn: number | null;
}

/** The nearest-rank p-quantile of a non-empty ascending array. */
export function nearestRank(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) {
    throw new RangeError('nearestRank needs at least one value');
  }
  if (!(p >= 0 && p <= 1)) {
    throw new RangeError(`p must be in [0, 1], got ${String(p)}`);
  }
  return at(sorted, Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1)));
}

const rms = (values: readonly number[]): number | null =>
  values.length === 0 ? null : Math.sqrt(values.reduce((s, v) => s + v * v, 0) / values.length);

/**
 * One summary per pool, deepest pool (highest median liquidity) first. Each
 * pool's observations are put in time order; a repeated time counts once.
 */
export function summarizeBasis(observations: readonly BasisObservation[]): BasisSummary[] {
  const byPool = new Map<string, BasisObservation[]>();
  for (const o of observations) {
    const list = byPool.get(o.pool) ?? [];
    list.push(o);
    byPool.set(o.pool, list);
  }
  const summaries: BasisSummary[] = [];
  for (const [pool, raw] of byPool) {
    const seen = new Set<number>();
    const list = [...raw]
      .sort((a, b) => a.observedAtSeconds - b.observedAtSeconds)
      .filter((o) => {
        if (seen.has(o.observedAtSeconds)) return false;
        seen.add(o.observedAtSeconds);
        return true;
      });
    const bases = list.map((o) => o.logBasis).sort((a, b) => a - b);
    const liquidity = list.map((o) => o.liquidity).sort((a, b) => a - b);
    const basisChanges: number[] = [];
    const referenceReturns: number[] = [];
    const logBases = list.map((o) => o.logBasis);
    const referencePrices = list.map((o) => o.referencePrice);
    for (let i = 1; i < list.length; i++) {
      basisChanges.push(at(logBases, i) - at(logBases, i - 1));
      referenceReturns.push(Math.log(at(referencePrices, i) / at(referencePrices, i - 1)));
    }
    summaries.push({
      pool,
      // Every pool in the map has at least one observation, and one fee rate.
      feeRate: at(
        raw.map((o) => o.feeRate),
        0,
      ),
      observations: list.length,
      medianLiquidity: nearestRank(liquidity, 0.5),
      medianLogBasis: nearestRank(bases, 0.5),
      p05LogBasis: nearestRank(bases, 0.05),
      p95LogBasis: nearestRank(bases, 0.95),
      maxAbsLogBasis: Math.max(...bases.map(Math.abs)),
      intervals: basisChanges.length,
      rmsBasisChange: rms(basisChanges),
      rmsReferenceReturn: rms(referenceReturns),
    });
  }
  return summaries.sort((a, b) => b.medianLiquidity - a.medianLiquidity);
}
