/**
 * Concentrated-liquidity (Uniswap v3 / Orca Whirlpool) position math.
 *
 * Conventions
 * -----------
 * - `price` is always expressed as **quote per base** (e.g. SOL per WBTC for a
 *   WBTC/SOL pool, where WBTC is the base and SOL is the quote).
 * - A position is fully described by its liquidity `L` and its price range
 *   `[lower, upper]`. Token holdings at any price follow from those three
 *   numbers alone.
 * - This is the *continuous* model. Real pools quantise prices into ticks and
 *   store `sqrt(price)` as a fixed-point integer; the differences are far below
 *   the precision needed for position analysis and are deliberately ignored
 *   here. Do **not** use this module to build transactions.
 *
 * Formulas (with sqrt(P) written as s):
 *   quote = L · (s(P) − s(lower))
 *   base  = L · (1/s(P) − 1/s(upper))
 * Outside the range, P is clamped to the nearest bound, which makes the
 * position 100 % base below the range and 100 % quote above it.
 */

export interface PriceRange {
  /** Lower price bound, quote per base. Must be > 0 and < upper. */
  readonly lower: number;
  /** Upper price bound, quote per base. */
  readonly upper: number;
}

export interface TokenAmounts {
  /** Amount of the base token (e.g. WBTC). */
  readonly base: number;
  /** Amount of the quote token (e.g. SOL). */
  readonly quote: number;
}

export interface Position {
  readonly liquidity: number;
  readonly range: PriceRange;
}

export class InvalidRangeError extends RangeError {
  constructor(range: PriceRange) {
    super(`Invalid price range: lower=${String(range.lower)} upper=${String(range.upper)}`);
    this.name = 'InvalidRangeError';
  }
}

export class PriceOutOfRangeError extends RangeError {
  constructor(price: number, range: PriceRange) {
    super(
      `Price ${String(price)} is outside range [${String(range.lower)}, ${String(range.upper)}]`,
    );
    this.name = 'PriceOutOfRangeError';
  }
}

function assertValidRange(range: PriceRange): void {
  if (
    !Number.isFinite(range.lower) ||
    !Number.isFinite(range.upper) ||
    range.lower <= 0 ||
    range.lower >= range.upper
  ) {
    throw new InvalidRangeError(range);
  }
}

function assertPositivePrice(price: number): void {
  if (!Number.isFinite(price) || price <= 0) {
    throw new RangeError(`Price must be a positive finite number, got ${String(price)}`);
  }
}

function assertValidLiquidity(liquidity: number): void {
  if (!Number.isFinite(liquidity) || liquidity < 0) {
    throw new RangeError(
      `Liquidity must be a finite non-negative number, got ${String(liquidity)}`,
    );
  }
}

function assertValidPosition(position: Position): void {
  assertValidRange(position.range);
  assertValidLiquidity(position.liquidity);
}

function assertValidAmounts(amounts: TokenAmounts): void {
  if (!Number.isFinite(amounts.base) || amounts.base < 0) {
    throw new RangeError(
      `base amount must be finite and non-negative, got ${String(amounts.base)}`,
    );
  }
  if (!Number.isFinite(amounts.quote) || amounts.quote < 0) {
    throw new RangeError(
      `quote amount must be finite and non-negative, got ${String(amounts.quote)}`,
    );
  }
}

function clampToRange(price: number, range: PriceRange): number {
  return Math.min(Math.max(price, range.lower), range.upper);
}

/**
 * Builds a range symmetric in *relative* terms around a centre price:
 * `[centre / (1 + halfWidth), centre · (1 + halfWidth)]`.
 *
 * Note this is symmetric multiplicatively, not additively, so the centre is
 * the geometric mean of the bounds. `halfWidth` is a fraction (0.05 for ±5 %).
 */
export function rangeAround(centre: number, halfWidth: number): PriceRange {
  assertPositivePrice(centre);
  if (!Number.isFinite(halfWidth) || halfWidth <= 0) {
    throw new RangeError(`halfWidth must be a positive finite number, got ${String(halfWidth)}`);
  }
  return { lower: centre / (1 + halfWidth), upper: centre * (1 + halfWidth) };
}

/** Geometric centre of a range, √(lower · upper). */
export function geometricCentre(range: PriceRange): number {
  assertValidRange(range);
  return Math.sqrt(range.lower * range.upper);
}

/**
 * Relative distance from `price` to each bound, as fractions of `price`.
 * Negative `toLower` means the lower bound is below the price (the usual case).
 */
export function distanceToBounds(
  price: number,
  range: PriceRange,
): { readonly toLower: number; readonly toUpper: number } {
  assertPositivePrice(price);
  assertValidRange(range);
  return { toLower: range.lower / price - 1, toUpper: range.upper / price - 1 };
}

/**
 * Recovers liquidity `L` from a known **quote** deposit at a known price.
 * Requires the price to be strictly inside the range (otherwise the quote
 * amount carries no information about `L`).
 */
export function liquidityFromQuote(quoteAmount: number, price: number, range: PriceRange): number {
  assertValidRange(range);
  assertPositivePrice(price);
  if (price <= range.lower || price >= range.upper) {
    throw new PriceOutOfRangeError(price, range);
  }
  if (!Number.isFinite(quoteAmount) || quoteAmount <= 0) {
    throw new RangeError(`quoteAmount must be positive, got ${String(quoteAmount)}`);
  }
  return quoteAmount / (Math.sqrt(price) - Math.sqrt(range.lower));
}

/**
 * Recovers liquidity `L` from a known **base** deposit at a known price.
 * Same in-range requirement as {@link liquidityFromQuote}.
 */
export function liquidityFromBase(baseAmount: number, price: number, range: PriceRange): number {
  assertValidRange(range);
  assertPositivePrice(price);
  if (price <= range.lower || price >= range.upper) {
    throw new PriceOutOfRangeError(price, range);
  }
  if (!Number.isFinite(baseAmount) || baseAmount <= 0) {
    throw new RangeError(`baseAmount must be positive, got ${String(baseAmount)}`);
  }
  return baseAmount / (1 / Math.sqrt(price) - 1 / Math.sqrt(range.upper));
}

/**
 * Token holdings of a position at a given price. The price is clamped to the
 * range, so this is valid (and meaningful) for out-of-range prices too.
 */
export function amountsAtPrice(position: Position, price: number): TokenAmounts {
  assertValidPosition(position);
  assertPositivePrice(price);
  const p = clampToRange(price, position.range);
  const sqrtP = Math.sqrt(p);
  return {
    quote: position.liquidity * (sqrtP - Math.sqrt(position.range.lower)),
    base: position.liquidity * (1 / sqrtP - 1 / Math.sqrt(position.range.upper)),
  };
}

/**
 * Value of a token bundle expressed in the quote token at `price`.
 * Both amounts must be finite and non-negative.
 */
export function valueInQuote(amounts: TokenAmounts, price: number): number {
  assertValidAmounts(amounts);
  assertPositivePrice(price);
  return amounts.quote + amounts.base * price;
}

export class EmptyDepositError extends RangeError {
  constructor() {
    super('Deposit has zero value; divergence loss is undefined');
    this.name = 'EmptyDepositError';
  }
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
export function divergenceLoss(position: Position, deposit: TokenAmounts, price: number): number {
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
  assertValidRange(range);
  const centre = geometricCentre(range);
  // Liquidity scale is irrelevant for a relative result; use L = 1.
  const position: Position = { liquidity: 1, range };
  const deposit = amountsAtPrice(position, centre);
  return divergenceLoss(position, deposit, range.upper);
}
