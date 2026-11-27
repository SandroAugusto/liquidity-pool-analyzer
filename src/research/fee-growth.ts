/**
 * Fees earned by synthetic positions, from a series of pool readings
 * (ADR-0007, criterion 1 of ADR-0005).
 *
 * A pool's cumulative fee growth per unit of liquidity grows on every swap. A
 * position earns its liquidity times that growth for exactly the swaps that
 * happen while the price is inside its range: the growth "outside" its two
 * bounds only changes when the price crosses one of them. So while the price
 * stays inside, the position's fees per unit of liquidity equal the change in
 * the pool's global figure, and no history of liquidity by tick is needed.
 *
 * Readings are snapshots, so the price is only seen at readings: an exit and
 * return between two readings is missed (the interval is counted as earned in
 * full, overstating fees), and the interval in which an exit is seen is not
 * counted (understating them). The same discrete-monitoring caveat as the
 * exit-time study applies.
 */

import { quotePerBase, tokenAmounts } from '../math/index.js';
import type { QuotePerBase, TokenAmounts } from '../math/index.js';
import type { PoolReading } from '../positions/index.js';

/** Two readings that are not of the same pool and pair, or not in time order. */
export class ReadingMismatchError extends Error {
  constructor(reason: string) {
    super(`Readings cannot be compared: ${reason}`);
    this.name = 'ReadingMismatchError';
  }
}

/**
 * A pool's fee growth went down between two readings. On chain it only grows
 * (until a wrap-around at 2¹²⁸, decades away at current rates), so the data
 * are wrong; a negative fee is never returned instead.
 */
export class FeeGrowthDecreasedError extends Error {
  constructor(
    readonly pool: string,
    readonly fromSlot: bigint,
    readonly toSlot: bigint,
  ) {
    super(
      `Fee growth of ${pool} decreased between slots ${String(fromSlot)} and ${String(toSlot)}`,
    );
    this.name = 'FeeGrowthDecreasedError';
  }
}

/**
 * Fees per unit of model liquidity earned between two readings of the same pool
 * by a position in range throughout, in token units of base and quote.
 */
export function feesPerLiquidityBetween(older: PoolReading, newer: PoolReading): TokenAmounts {
  if (older.source.pool !== newer.source.pool) {
    throw new ReadingMismatchError(`different pools ${older.source.pool} and ${newer.source.pool}`);
  }
  if (
    older.pair.base.mint !== newer.pair.base.mint ||
    older.pair.quote.mint !== newer.pair.quote.mint
  ) {
    throw new ReadingMismatchError('base and quote differ');
  }
  if (newer.slot <= older.slot) {
    throw new ReadingMismatchError(`slot ${String(newer.slot)} is not after ${String(older.slot)}`);
  }
  const base = newer.feeGrowthPerLiquidity.base - older.feeGrowthPerLiquidity.base;
  const quote = newer.feeGrowthPerLiquidity.quote - older.feeGrowthPerLiquidity.quote;
  if (base < 0 || quote < 0) {
    throw new FeeGrowthDecreasedError(newer.source.pool, older.slot, newer.slot);
  }
  return tokenAmounts(base, quote);
}

/**
 * Value in quote of one unit of model liquidity in a range centred on `price`
 * (quote per base) with log half-width `logHalfWidth` (bounds `price · e^(∓h)`),
 * at that price: `2√P · (1 − e^(−h/2))`.
 *
 * Derivation: base `L · (1/√P − 1/√(P·e^h))`, quote `L · (√P − √(P·e^(−h)))`;
 * each is `L · √P^(∓1) · (1 − e^(−h/2))`, and base is worth `P` quote.
 */
export function centredValuePerLiquidity(price: QuotePerBase, logHalfWidth: number): number {
  if (!Number.isFinite(logHalfWidth) || logHalfWidth <= 0) {
    throw new RangeError(`logHalfWidth must be positive and finite, got ${String(logHalfWidth)}`);
  }
  return -2 * Math.sqrt(price) * Math.expm1(-logHalfWidth / 2);
}

/** Fees of a synthetic centred position until its exit is seen (see the module comment). */
export interface FeeReturnUntilExit {
  /**
   * Fees earned, valued in quote at each interval's closing price, as a fraction
   * of the position's value in quote when opened. 0.001 means 0.1 %.
   */
  readonly feeReturn: number;
  /** Intervals counted: consecutive reading pairs with both prices in range. */
  readonly intervals: number;
  /** Whether a reading at or beyond a bound was seen. */
  readonly exited: boolean;
}

/**
 * Opens a synthetic position at `readings[0]`, centred on its price with log
 * half-width `logHalfWidth`, and accumulates its fees over the following
 * readings until one is at or beyond a bound (an exit, as in the exit-time
 * study) or the series ends. The position's own liquidity is assumed small
 * enough not to change the pool's.
 */
export function feeReturnUntilExit(
  readings: readonly PoolReading[],
  logHalfWidth: number,
): FeeReturnUntilExit {
  const [opening] = readings;
  if (opening === undefined) {
    throw new RangeError('at least one reading is needed');
  }
  const value = centredValuePerLiquidity(opening.price, logHalfWidth);
  const lower = quotePerBase(opening.price * Math.exp(-logHalfWidth));
  const upper = quotePerBase(opening.price * Math.exp(logHalfWidth));
  let feesInQuote = 0;
  let intervals = 0;
  for (let i = 1; i < readings.length; i++) {
    const older = readings[i - 1];
    const newer = readings[i];
    /* c8 ignore next 3 -- i is within bounds; the guard satisfies noUncheckedIndexedAccess */
    if (older === undefined || newer === undefined) {
      break;
    }
    const fees = feesPerLiquidityBetween(older, newer);
    if (newer.price <= lower || newer.price >= upper) {
      return { feeReturn: feesInQuote / value, intervals, exited: true };
    }
    feesInQuote += fees.base * newer.price + fees.quote;
    intervals++;
  }
  return { feeReturn: feesInQuote / value, intervals, exited: false };
}
