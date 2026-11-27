/**
 * Protocol-neutral reading of a concentrated-liquidity pool's fee state.
 *
 * Like `PositionReading`, nothing protocol-specific (ticks, fixed-point
 * square-root prices, raw on-chain integers) appears here: an adapter for any
 * CLMM (Orca, Uniswap v3) converts to this shape (ADR-0007).
 */

import type { QuotePerBase, TokenAmounts } from '../math/index.js';
import type { Protocol, TokenInfo } from './reading.js';

/**
 * State of one pool, from a single consistent read at {@link PoolReading.slot}.
 *
 * `feeGrowthPerLiquidity` is the pool's cumulative fee growth: the trading fees
 * one unit of model liquidity would have earned had it been in range at every
 * moment since the pool was created. Between two readings, a position whose
 * range contained the price throughout earns its liquidity times the change in
 * this figure; outside its range it earns nothing (ADR-0007).
 */
export interface PoolReading {
  readonly source: { readonly protocol: Protocol; readonly pool: string };
  readonly pair: { readonly base: TokenInfo; readonly quote: TokenInfo };
  /** Pool price, quote per base. */
  readonly price: QuotePerBase;
  /** Active liquidity at the current price, in the continuous model's units. */
  readonly liquidity: number;
  /**
   * Cumulative fees per unit of model liquidity, in token units of base and quote.
   * Liquidity providers' share only: the protocol's share is excluded on chain.
   */
  readonly feeGrowthPerLiquidity: TokenAmounts;
  /** Pool fee as a fraction: 0.0005 means 0.05 %. */
  readonly feeRate: number;
  /** Slot the state was read at. */
  readonly slot: bigint;
}
