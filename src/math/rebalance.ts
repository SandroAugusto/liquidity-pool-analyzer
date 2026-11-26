/**
 * Economics of a "re-centre on exit" strategy, with the swap cost of each
 * re-centre and an empirical fee model. See docs/adr/0005-rebalance-economics.md.
 *
 * Model
 * -----
 * Log-price follows a driftless random walk with daily volatility σ
 * (`sigmaPerDay`). A position covers `[lower, upper]`; its log half-width is
 * `hL = ln(upper / lower) / 2`.
 *
 * - Time to exit from price P: E[T] = ln(P / lower) · ln(upper / P) / σ².
 *   At the geometric centre this is hL² / σ².
 * - Cost of one cycle, measured from the centre: the divergence loss at the
 *   edge, `L`, plus the swap needed to re-centre, `s`. Per day:
 *   (L + s) / E[T] = (L + s) · σ² / hL².
 * - Fees per day while in range: k · σ / hL, with k an empirical constant
 *   (not yet validated; see the ADR).
 * - Fee-to-cost ratio: k · hL / (σ · (L + s)). Since L ≈ hL / 4 for ranges up to
 *   a few tens of percent, with s = 0 the ratio is ≈ 4k / σ and the width cancels:
 *   whether re-centring pays depends on σ, not on how wide the range is. The swap
 *   cost is what makes width matter again, and only for narrow ranges.
 *
 * Conventions: σ, fee rates, k, L and s are fractions (0.015 means 1.5 %).
 * Prices are {@link QuotePerBase}. These are planning numbers, not forecasts:
 * volatility clusters and ratios trend.
 */

import { PriceOutOfRangeError, divergenceLossToEdgeFromCentre } from './clmm.js';
import type { PriceRange } from './clmm.js';
import { ensureFinite, ensurePositiveFinite } from './errors.js';
import type { QuotePerBase } from './price.js';

function assertPositiveFinite(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive finite number, got ${String(value)}`);
  }
}

function assertNonNegativeFinite(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a finite non-negative number, got ${String(value)}`);
  }
}

/**
 * Log half-width of a range, ln(upper / lower) / 2, computed as a difference of
 * logs so the ratio cannot overflow for bounds that are individually valid.
 */
export function logHalfWidth(range: PriceRange): number {
  return ensurePositiveFinite((Math.log(range.upper) - Math.log(range.lower)) / 2, 'logHalfWidth');
}

/**
 * Expected days until the price first leaves `range`, starting from `price`,
 * for a driftless walk with daily volatility `sigmaPerDay`:
 * ln(P / lower) · ln(upper / P) / σ².
 *
 * Unlike `expectedDaysToExit`, this accounts for a price that is not at the
 * centre: a position opened near one bound exits sooner. Throws
 * {@link PriceOutOfRangeError} when the price is at or outside a bound.
 *
 * The estimate is only as good as σ. Volatility clusters, so a σ from a long
 * trailing window lags the regime the position will live in; prefer a recent one
 * (ADR-0005).
 */
export function expectedDaysToExitFrom(
  price: QuotePerBase,
  range: PriceRange,
  sigmaPerDay: number,
): number {
  assertPositiveFinite(sigmaPerDay, 'sigmaPerDay');
  if (price <= range.lower || price >= range.upper) {
    throw new PriceOutOfRangeError(price, range);
  }
  const logP = Math.log(price);
  const toLower = logP - Math.log(range.lower);
  const toUpper = Math.log(range.upper) - logP;
  return ensurePositiveFinite(
    ((toLower / sigmaPerDay) * toUpper) / sigmaPerDay,
    'expectedDaysToExitFrom',
  );
}

/** Inputs shared by the cost functions. */
export interface RemountCostInputs {
  readonly range: PriceRange;
  /** Daily volatility of the log-price, as a fraction. */
  readonly sigmaPerDay: number;
  /**
   * Cost of the swap that re-centres the position, as a fraction of the
   * position's value (pool fee plus slippage on the swapped share). Network
   * fees on Solana are negligible at this scale.
   */
  readonly swapCostPerRemount: number;
}

/**
 * Cost per remount cycle as a fraction of position value: the divergence loss
 * from the centre to the edge plus the swap. Positive.
 */
export function costPerRemount(range: PriceRange, swapCostPerRemount: number): number {
  assertNonNegativeFinite(swapCostPerRemount, 'swapCostPerRemount');
  const lossAtEdge = Math.abs(divergenceLossToEdgeFromCentre(range));
  return ensurePositiveFinite(lossAtEdge + swapCostPerRemount, 'costPerRemount');
}

/**
 * Expected cost per day of re-centring on every exit, for a position that is
 * re-opened at the centre each time: (L + s) · σ² / hL². Positive fraction per
 * day.
 */
export function remountCostPerDay(inputs: RemountCostInputs): number {
  assertPositiveFinite(inputs.sigmaPerDay, 'sigmaPerDay');
  const cost = costPerRemount(inputs.range, inputs.swapCostPerRemount);
  const hL = logHalfWidth(inputs.range);
  const sigmaOverH = inputs.sigmaPerDay / hL;
  // Mathematically positive for valid inputs; zero can only be underflow.
  return ensurePositiveFinite(cost * sigmaOverH * sigmaOverH, 'remountCostPerDay');
}

/**
 * Ratio of fee income to expected remount cost. Above 1, re-centring on exit
 * is expected to beat holding the deposited tokens; below 1, it is expected to
 * lose to them.
 *
 * `feeRatePerDay` is fees earned per day *while in range*, as a fraction of
 * position value.
 */
export function feeToCostRatio(feeRatePerDay: number, inputs: RemountCostInputs): number {
  assertNonNegativeFinite(feeRatePerDay, 'feeRatePerDay');
  return ensureFinite(feeRatePerDay / remountCostPerDay(inputs), 'feeToCostRatio');
}

/**
 * The fee constant k implied by an observed fee rate: k = fee · hL / σ.
 * Under the model, fees per day in range are k · σ / hL, so k is comparable
 * across ranges of different widths and periods of different volatility.
 */
export function feeConstant(feeRatePerDay: number, range: PriceRange, sigmaPerDay: number): number {
  assertNonNegativeFinite(feeRatePerDay, 'feeRatePerDay');
  assertPositiveFinite(sigmaPerDay, 'sigmaPerDay');
  return ensureFinite((feeRatePerDay / sigmaPerDay) * logHalfWidth(range), 'feeConstant');
}

/**
 * Daily volatility at which fees exactly pay for re-centring, for a fee
 * constant k: σ* = k · hL / (L + s). Re-centring is expected to pay below σ*
 * and to lose above it. With s = 0 this is ≈ 4k for any width.
 */
export function breakevenVolatility(
  feeConstantK: number,
  range: PriceRange,
  swapCostPerRemount: number,
): number {
  assertNonNegativeFinite(feeConstantK, 'feeConstantK');
  const cost = costPerRemount(range, swapCostPerRemount);
  return ensureFinite((feeConstantK / cost) * logHalfWidth(range), 'breakevenVolatility');
}
