/**
 * Branded price type.
 *
 * A bare `number` carries no information about which way round a price is.
 * `amountsAtPrice(position, 0.00083)` (WBTC per SOL) would be accepted just like
 * `amountsAtPrice(position, 1200)` (SOL per WBTC) and return plausible garbage.
 *
 * `QuotePerBase` is a `number` at runtime — arithmetic works, nothing is boxed —
 * but at compile time only {@link quotePerBase} can produce one. Every price
 * that enters the math core passes through that single, validated door.
 */

declare const priceBrand: unique symbol;

/**
 * A price expressed as **quote token per base token** — e.g. SOL per WBTC in a
 * WBTC/SOL pool, where WBTC is the base and SOL is the quote. Always positive
 * and finite.
 */
export type QuotePerBase = number & { readonly [priceBrand]: 'QuotePerBase' };

export class InvalidPriceError extends RangeError {
  constructor(value: number) {
    super(`Price must be a positive finite number, got ${String(value)}`);
    this.name = 'InvalidPriceError';
  }
}

/**
 * The only way to obtain a {@link QuotePerBase}. Validates once; downstream
 * code trusts the type.
 */
export function quotePerBase(value: number): QuotePerBase {
  if (!Number.isFinite(value) || value <= 0) {
    throw new InvalidPriceError(value);
  }
  return value as QuotePerBase;
}
