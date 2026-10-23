/**
 * Concentrated-liquidity (Uniswap v3 / Orca Whirlpool) position math.
 *
 * Conventions
 * -----------
 * - Prices are {@link QuotePerBase}: **quote per base** (e.g. SOL per WBTC for a
 *   WBTC/SOL pool, where WBTC is the base and SOL is the quote).
 * - A position is fully described by its liquidity `L` and its price range
 *   `[lower, upper]`. Token holdings at any price follow from those three
 *   numbers alone.
 * - This is the *continuous* model. Real pools quantise prices into ticks and
 *   store `sqrt(price)` as a fixed-point integer; the differences are far below
 *   the precision needed for position analysis and are deliberately ignored
 *   here. Do **not** use this module to build transactions.
 *
 * Validation
 * ----------
 * "Parse, don't validate": {@link PriceRange}, {@link Position} and
 * {@link TokenAmounts} can only be built through their constructors
 * ({@link createRange}, {@link createPosition}, {@link tokenAmounts}), which
 * validate once. Calculation functions trust their typed inputs and only check
 * relationships *between* inputs (a price inside a range, a non-empty deposit).
 *
 * Formulas (with sqrt(P) written as s):
 *   quote = L · (s(P) − s(lower))
 *   base  = L · (1/s(P) − 1/s(upper))
 * Outside the range, P is clamped to the nearest bound, which makes the
 * position 100 % base below the range and 100 % quote above it.
 */

import { quotePerBase } from './price.js';
import type { QuotePerBase } from './price.js';

declare const validated: unique symbol;

/** A validated price range. Build with {@link createRange}. */
export interface PriceRange {
  /** Lower price bound. Strictly less than `upper`. */
  readonly lower: QuotePerBase;
  /** Upper price bound. */
  readonly upper: QuotePerBase;
  readonly [validated]: 'PriceRange';
}

/** A validated bundle of token amounts. Build with {@link tokenAmounts}. */
export interface TokenAmounts {
  /** Amount of the base token (e.g. WBTC). Finite, ≥ 0. */
  readonly base: number;
  /** Amount of the quote token (e.g. SOL). Finite, ≥ 0. */
  readonly quote: number;
  readonly [validated]: 'TokenAmounts';
}

/** A validated position. Build with {@link createPosition}. */
export interface Position {
  /** Liquidity `L`. Finite, ≥ 0 (zero is a closed or empty position). */
  readonly liquidity: number;
  readonly range: PriceRange;
  readonly [validated]: 'Position';
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class InvalidRangeError extends RangeError {
  constructor(lower: number, upper: number) {
    super(`Invalid price range: lower=${String(lower)} must be < upper=${String(upper)}`);
    this.name = 'InvalidRangeError';
  }
}

export class InvalidLiquidityError extends RangeError {
  constructor(liquidity: number) {
    super(`Liquidity must be a finite non-negative number, got ${String(liquidity)}`);
    this.name = 'InvalidLiquidityError';
  }
}

export class InvalidAmountError extends RangeError {
  constructor(token: 'base' | 'quote', amount: number) {
    super(`${token} amount must be finite and non-negative, got ${String(amount)}`);
    this.name = 'InvalidAmountError';
  }
}

export class PriceOutOfRangeError extends RangeError {
  constructor(price: QuotePerBase, range: PriceRange) {
    super(
      `Price ${String(price)} is outside range [${String(range.lower)}, ${String(range.upper)}]`,
    );
    this.name = 'PriceOutOfRangeError';
  }
}

export class EmptyDepositError extends RangeError {
  constructor() {
    super('Deposit has zero value; divergence loss is undefined');
    this.name = 'EmptyDepositError';
  }
}

// ---------------------------------------------------------------------------
// Constructors — the only place validation happens
// ---------------------------------------------------------------------------

/** Builds a {@link PriceRange}. Both bounds must already be valid prices. */
export function createRange(lower: QuotePerBase, upper: QuotePerBase): PriceRange {
  if (lower >= upper) {
    throw new InvalidRangeError(lower, upper);
  }
  return Object.freeze({ lower, upper }) as PriceRange;
}

/** Builds a {@link Position}. Liquidity must be finite and non-negative. */
export function createPosition(liquidity: number, range: PriceRange): Position {
  if (!Number.isFinite(liquidity) || liquidity < 0) {
    throw new InvalidLiquidityError(liquidity);
  }
  return Object.freeze({ liquidity, range }) as Position;
}

/** Builds a {@link TokenAmounts}. Both amounts must be finite and non-negative. */
export function tokenAmounts(base: number, quote: number): TokenAmounts {
  if (!Number.isFinite(base) || base < 0) {
    throw new InvalidAmountError('base', base);
  }
  if (!Number.isFinite(quote) || quote < 0) {
    throw new InvalidAmountError('quote', quote);
  }
  return Object.freeze({ base, quote }) as TokenAmounts;
}

/**
 * Builds a range symmetric in *relative* terms around a centre price:
 * `[centre / (1 + halfWidth), centre · (1 + halfWidth)]`.
 *
 * Note this is symmetric multiplicatively, not additively, so the centre is
 * the geometric mean of the bounds. `halfWidth` is a fraction (0.05 for ±5 %).
 * Bounds that overflow or underflow at numerical extremes are rejected by
 * {@link quotePerBase}.
 */
export function rangeAround(centre: QuotePerBase, halfWidth: number): PriceRange {
  if (!Number.isFinite(halfWidth) || halfWidth <= 0) {
    throw new RangeError(`halfWidth must be a positive finite number, got ${String(halfWidth)}`);
  }
  return createRange(
    quotePerBase(centre / (1 + halfWidth)),
    quotePerBase(centre * (1 + halfWidth)),
  );
}

// ---------------------------------------------------------------------------
// Calculations — trust their typed inputs
// ---------------------------------------------------------------------------

function clampToRange(price: QuotePerBase, range: PriceRange): QuotePerBase {
  // min/max of valid prices is a valid price; the cast is sound.
  return Math.min(Math.max(price, range.lower), range.upper) as QuotePerBase;
}

/** Geometric centre of a range, √(lower · upper). */
export function geometricCentre(range: PriceRange): QuotePerBase {
  return quotePerBase(Math.sqrt(range.lower * range.upper));
}

/**
 * Relative distance from `price` to each bound, as fractions of `price`.
 * Negative `toLower` means the lower bound is below the price (the usual case).
 */
export function distanceToBounds(
  price: QuotePerBase,
  range: PriceRange,
): { readonly toLower: number; readonly toUpper: number } {
  return { toLower: range.lower / price - 1, toUpper: range.upper / price - 1 };
}

function assertStrictlyInside(price: QuotePerBase, range: PriceRange): void {
  if (price <= range.lower || price >= range.upper) {
    throw new PriceOutOfRangeError(price, range);
  }
}

/**
 * Recovers liquidity `L` from a known **quote** deposit at a known price.
 * Requires the price to be strictly inside the range (otherwise the quote
 * amount carries no information about `L`).
 */
export function liquidityFromQuote(
  quoteAmount: number,
  price: QuotePerBase,
  range: PriceRange,
): number {
  assertStrictlyInside(price, range);
  if (!Number.isFinite(quoteAmount) || quoteAmount <= 0) {
    throw new InvalidAmountError('quote', quoteAmount);
  }
  return quoteAmount / (Math.sqrt(price) - Math.sqrt(range.lower));
}

/**
 * Recovers liquidity `L` from a known **base** deposit at a known price.
 * Same in-range requirement as {@link liquidityFromQuote}.
 */
export function liquidityFromBase(
  baseAmount: number,
  price: QuotePerBase,
  range: PriceRange,
): number {
  assertStrictlyInside(price, range);
  if (!Number.isFinite(baseAmount) || baseAmount <= 0) {
    throw new InvalidAmountError('base', baseAmount);
  }
  return baseAmount / (1 / Math.sqrt(price) - 1 / Math.sqrt(range.upper));
}

/**
 * Token holdings of a position at a given price. The price is clamped to the
 * range, so this is valid (and meaningful) for out-of-range prices too.
 *
 * Both outputs are provably non-negative: after clamping, `P ≥ lower` gives
 * `√P ≥ √lower`, and `P ≤ upper` gives `1/√P ≥ 1/√upper` (sqrt and division
 * are monotonic and correctly rounded in IEEE-754).
 */
export function amountsAtPrice(position: Position, price: QuotePerBase): TokenAmounts {
  const p = clampToRange(price, position.range);
  const sqrtP = Math.sqrt(p);
  return tokenAmounts(
    position.liquidity * (1 / sqrtP - 1 / Math.sqrt(position.range.upper)),
    position.liquidity * (sqrtP - Math.sqrt(position.range.lower)),
  );
}

/** Value of a token bundle expressed in the quote token at `price`. */
export function valueInQuote(amounts: TokenAmounts, price: QuotePerBase): number {
  return amounts.quote + amounts.base * price;
}

/**
 * Divergence loss (a.k.a. impermanent loss) of a position relative to simply
 * holding `deposit`, both valued in quote at `price`.
 *
 * Returns a signed fraction of the hold value: 0 when the price equals the
 * entry price, negative otherwise (the pool is never worth more than the hold
 * before fees). Fees are **not** included; add them separately.
 *
 * Throws {@link EmptyDepositError} when the deposit values to zero, since the
 * ratio is then undefined.
 */
export function divergenceLoss(
  position: Position,
  deposit: TokenAmounts,
  price: QuotePerBase,
): number {
  const pool = valueInQuote(amountsAtPrice(position, price), price);
  const hold = valueInQuote(deposit, price);
  if (hold <= 0) {
    throw new EmptyDepositError();
  }
  return (pool - hold) / hold;
}

/**
 * Divergence loss incurred by a position opened at the geometric centre of its
 * range when the price reaches either bound. Because the range is
 * multiplicatively symmetric, both bounds give the same number.
 *
 * Useful as the per-cycle cost of a "re-centre on exit" strategy.
 */
export function divergenceLossToEdgeFromCentre(range: PriceRange): number {
  const centre = geometricCentre(range);
  // Liquidity scale is irrelevant for a relative result; use L = 1.
  const position = createPosition(1, range);
  const deposit = amountsAtPrice(position, centre);
  return divergenceLoss(position, deposit, range.upper);
}
