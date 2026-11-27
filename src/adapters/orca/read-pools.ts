/**
 * Reads the fee state of public Orca Whirlpools as protocol-neutral
 * {@link PoolReading}s (ADR-0007). Read-only: nothing here builds or signs
 * anything, and nothing here concerns any wallet or position.
 *
 * Every pool's mutable state (price, liquidity, fee growth) comes from one
 * `getAccounts` call, so all readings of a call share its slot. Mint decimals,
 * which never change, come from a second call.
 */

import {
  WHIRLPOOL_DISCRIMINATOR,
  getWhirlpoolAddress,
  getWhirlpoolDecoder,
  getWhirlpoolSize,
} from '@orca-so/whirlpools-client';
import { address, getAddressEncoder } from '@solana/kit';

import { InvalidAccountError, UnsupportedPositionError } from '../../positions/index.js';
import type { PoolReading } from '../../positions/index.js';
import { getAccountsAligned, isAccountOf, readMintDecimals } from './accounts.js';
import {
  baseIsTokenA,
  feeGrowthPerModelLiquidity,
  priceFromSqrtPrice,
  toModelLiquidity,
} from './conversion.js';
import { MAX_ACCOUNTS_PER_CALL } from './port.js';
import type { SolanaReadPort } from './port.js';
import { DEFAULT_QUOTE_PREFERENCE } from './read-positions.js';

/** Whirlpool `feeRate` is in millionths. */
const FEE_RATE_DENOMINATOR = 1_000_000;

/**
 * Fee tier indexes of Orca's public tiers: for these, the index equals the tick
 * spacing; 32896 is the splash-pool tier (tick spacing 32896). Pools on tiers not
 * listed here, such as adaptive-fee tiers, are not found by
 * {@link whirlpoolAddressesForPair}.
 */
export const FEE_TIER_INDEXES: readonly number[] = [
  1, 2, 4, 8, 16, 32, 64, 96, 128, 256, 512, 32896,
];

/**
 * Addresses of the Whirlpools of a pair on the given fee tiers, whether or not
 * they exist (see {@link readPools}). The order of the two mints does not
 * matter: the program requires token A to be the mint with the smaller bytes.
 */
export async function whirlpoolAddressesForPair(
  mintX: string,
  mintY: string,
  feeTierIndexes: readonly number[] = FEE_TIER_INDEXES,
): Promise<string[]> {
  const encoder = getAddressEncoder();
  const [mintA, mintB] =
    compareBytes(encoder.encode(address(mintX)), encoder.encode(address(mintY))) <= 0
      ? [mintX, mintY]
      : [mintY, mintX];
  return Promise.all(
    feeTierIndexes.map(async (index) => {
      const [pda] = await getWhirlpoolAddress(address(mintA), address(mintB), index);
      return pda;
    }),
  );
}

export interface ReadPoolsOptions {
  /** Quote mints in order of preference; see {@link DEFAULT_QUOTE_PREFERENCE}. */
  readonly quotePreference?: readonly string[];
}

/**
 * Reads every pool in `pools` that exists, in one consistent read. An address
 * with no account is skipped; an account that is not a Whirlpool throws
 * {@link InvalidAccountError}. A pool with a Token-2022 mint throws
 * {@link UnsupportedPositionError} (transfer fees are not handled, ADR-0004).
 * At most {@link MAX_ACCOUNTS_PER_CALL} addresses, so that one call, and one
 * slot, covers them all.
 *
 * `feeRate` is the pool's base fee; for adaptive-fee pools it is not the fee
 * charged at any given moment, while `feeGrowthPerLiquidity` is what was
 * actually earned.
 */
export async function readPools(
  port: SolanaReadPort,
  pools: readonly string[],
  options: ReadPoolsOptions = {},
): Promise<PoolReading[]> {
  if (pools.length > MAX_ACCOUNTS_PER_CALL) {
    throw new RangeError(
      `at most ${String(MAX_ACCOUNTS_PER_CALL)} pools per read, got ${String(pools.length)}`,
    );
  }
  const quotePreference = options.quotePreference ?? DEFAULT_QUOTE_PREFERENCE;
  const { slot, accounts } = await getAccountsAligned(port, pools);
  const found = accounts.flatMap((account, i) => {
    if (account === null) {
      return [];
    }
    if (!isAccountOf(account, getWhirlpoolSize(), WHIRLPOOL_DISCRIMINATOR)) {
      throw new InvalidAccountError(pools[i] ?? '', 'Whirlpool');
    }
    return [{ address: account.address, whirlpool: getWhirlpoolDecoder().decode(account.data) }];
  });
  if (found.length === 0) {
    return [];
  }
  const mints = [
    ...new Set(found.flatMap((p) => [p.whirlpool.tokenMintA, p.whirlpool.tokenMintB])),
  ];
  const decimals = await readMintDecimals(port, mints);

  return found.map(({ address: pool, whirlpool }): PoolReading => {
    const decimalsA = decimals.get(whirlpool.tokenMintA);
    const decimalsB = decimals.get(whirlpool.tokenMintB);
    if (decimalsA === null || decimalsB === null) {
      throw new UnsupportedPositionError(pool, 'pool has a Token-2022 mint');
    }
    /* c8 ignore next 3 -- readMintDecimals returns an entry for every mint it was given, or throws */
    if (decimalsA === undefined || decimalsB === undefined) {
      throw new InvalidAccountError(pool, 'mints of a Whirlpool');
    }
    const baseIsA = baseIsTokenA(whirlpool.tokenMintA, whirlpool.tokenMintB, quotePreference);
    const o = { baseIsA, decimalsA, decimalsB };
    const tokenA = { mint: whirlpool.tokenMintA, decimals: decimalsA };
    const tokenB = { mint: whirlpool.tokenMintB, decimals: decimalsB };
    return {
      source: { protocol: 'orca-whirlpool', pool },
      pair: baseIsA ? { base: tokenA, quote: tokenB } : { base: tokenB, quote: tokenA },
      price: priceFromSqrtPrice(whirlpool.sqrtPrice, o),
      liquidity: toModelLiquidity(whirlpool.liquidity, decimalsA, decimalsB),
      feeGrowthPerLiquidity: feeGrowthPerModelLiquidity(
        whirlpool.feeGrowthGlobalA,
        whirlpool.feeGrowthGlobalB,
        o,
      ),
      feeRate: whirlpool.feeRate / FEE_RATE_DENOMINATOR,
      slot,
    };
  });
}

function compareBytes(x: ArrayLike<number>, y: ArrayLike<number>): number {
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) {
      return d;
    }
  }
  return x.length - y.length;
}
