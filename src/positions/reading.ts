/**
 * Protocol-neutral reading of a concentrated-liquidity position.
 *
 * This is what every consumer (CLI, rules, alerts) depends on. Adapters for a
 * specific protocol produce it; nothing protocol-specific (ticks, fixed-point
 * square-root prices, raw on-chain integers) appears here (#5, criterion 8).
 *
 * All prices are {@link QuotePerBase}; all amounts are in token units (not
 * base units), already oriented to the pair's base and quote.
 */

import type { Position, QuotePerBase, TokenAmounts } from '../math/index.js';

/** Protocols an adapter exists for. */
export type Protocol = 'orca-whirlpool';

/** One side of the pair. */
export interface TokenInfo {
  /** Mint address. */
  readonly mint: string;
  /** Number of decimals of the mint (token units = base units / 10^decimals). */
  readonly decimals: number;
}

/** Where a reading came from. */
export interface ReadingSource {
  readonly protocol: Protocol;
  /** Pool address. */
  readonly pool: string;
  /** Position account address. */
  readonly position: string;
}

/**
 * State of one position, taken from a single consistent read: every field
 * comes from on-chain state at {@link PositionReading.slot}.
 */
export interface PositionReading {
  readonly source: ReadingSource;
  readonly pair: { readonly base: TokenInfo; readonly quote: TokenInfo };
  /**
   * Liquidity in the continuous model's units (not the on-chain integer) and
   * range in quote per base. Feed it to `src/math`.
   */
  readonly position: Position;
  /** Current pool price, quote per base. */
  readonly price: QuotePerBase;
  /** Current token holdings, in token units, as computed by the protocol SDK. */
  readonly amounts: TokenAmounts;
  /** Fees earned and not yet collected, in token units. */
  readonly feesOwed: TokenAmounts;
  /** Pool fee as a fraction: 0.0005 means 0.05 %. */
  readonly feeRate: number;
  /** Slot the state was read at. */
  readonly slot: bigint;
}
