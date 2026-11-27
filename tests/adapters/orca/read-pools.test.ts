/**
 * Pool reader. Two kinds of evidence:
 *
 * - **Real public data** (public-wbtc-sol-pool.ts): the WBTC/SOL 0.05 % pool and
 *   its mints as recorded from mainnet. Price and fee growth are checked against
 *   the Orca SDK's own integer math (`sqrtPriceToPrice`, `collectFeesQuote`), an
 *   implementation independent of the adapter's conversion.
 * - **Synthetic chain state** (synthetic-chain.ts) for the adapter's own logic:
 *   single-slot reads, skipped and invalid accounts, orientation.
 */

import { getWhirlpoolAddress, getWhirlpoolDecoder } from '@orca-so/whirlpools-client';
import { collectFeesQuote, sqrtPriceToPrice } from '@orca-so/whirlpools-core';
import { address } from '@solana/kit';
import { describe, expect, it } from 'vitest';

import {
  FEE_TIER_INDEXES,
  readPools,
  whirlpoolAddressesForPair,
} from '../../../src/adapters/orca/index.js';
import type { RawAccount, SolanaReadPort } from '../../../src/adapters/orca/index.js';
import {
  AmbiguousQuoteError,
  InvalidAccountError,
  UnsupportedPositionError,
} from '../../../src/positions/index.js';
import { PUBLIC_ACCOUNTS, PUBLIC_SLOT } from './public-wbtc-sol-pool.js';
import {
  MINT,
  SyntheticChain,
  TOKEN_2022_PROGRAM,
  TOKEN_PROGRAM,
  fakeAddress,
} from './synthetic-chain.js';

const Q64 = 2n ** 64n;
const SOL_WBTC_005 = 'B5EwJVDuAauzUEEdwvbuXzbFFgEYnUqqS37TUM1c4PQA';

/** A port serving the recorded public accounts at their slot. */
function publicPort(): SolanaReadPort & { readonly calls: (readonly string[])[] } {
  const accounts = new Map<string, RawAccount>(
    PUBLIC_ACCOUNTS.map((a) => [
      a.address,
      {
        address: a.address,
        programAddress: a.owner,
        data: Uint8Array.from(Buffer.from(a.base64, 'base64')),
      },
    ]),
  );
  const calls: (readonly string[])[] = [];
  return {
    calls,
    findNftMints: () => Promise.reject(new Error('not used')),
    getAccounts: (addresses) => {
      calls.push(addresses);
      return Promise.resolve({
        slot: PUBLIC_SLOT,
        accounts: addresses.map((a) => accounts.get(a) ?? null),
      });
    },
  };
}

function publicWhirlpool() {
  const pool = PUBLIC_ACCOUNTS.find((a) => a.address === SOL_WBTC_005);
  if (pool === undefined) {
    throw new Error('recorded pool missing');
  }
  return getWhirlpoolDecoder().decode(Uint8Array.from(Buffer.from(pool.base64, 'base64')));
}

describe('whirlpoolAddressesForPair', () => {
  it('derives the real WBTC/SOL pool address on tier 8, in either mint order', async () => {
    const i = FEE_TIER_INDEXES.indexOf(8);
    expect((await whirlpoolAddressesForPair(MINT.WBTC, MINT.SOL))[i]).toBe(SOL_WBTC_005);
    expect((await whirlpoolAddressesForPair(MINT.SOL, MINT.WBTC))[i]).toBe(SOL_WBTC_005);
  });

  it('matches the SDK derivation with token A as the mint with smaller bytes', async () => {
    // SOL's first byte is 0x06, WBTC's 0x25: SOL is token A (as in the recorded pool).
    const [expected] = await getWhirlpoolAddress(MINT.SOL, MINT.WBTC, 64);
    expect(await whirlpoolAddressesForPair(MINT.WBTC, MINT.SOL, [64])).toEqual([expected]);
    expect(publicWhirlpool().tokenMintA).toBe(MINT.SOL);
  });
});

describe('readPools on the recorded public pool', () => {
  it('reads WBTC as base and SOL as quote, with the price the SDK gives, inverted', async () => {
    const [reading] = await readPools(publicPort(), [SOL_WBTC_005]);
    const whirlpool = publicWhirlpool();
    const wbtcPerSol = sqrtPriceToPrice(whirlpool.sqrtPrice, 9, 8);
    expect(reading?.pair.base).toEqual({ mint: MINT.WBTC, decimals: 8 });
    expect(reading?.pair.quote).toEqual({ mint: MINT.SOL, decimals: 9 });
    expect(reading?.price).toBeCloseTo(1 / wbtcPerSol, 9);
    // Market sanity: SOL per BTC was between 500 and 2,000 throughout 2024–2026.
    expect(reading?.price).toBeGreaterThan(500);
    expect(reading?.price).toBeLessThan(2000);
    expect(reading?.feeRate).toBe(0.0005);
    expect(reading?.slot).toBe(PUBLIC_SLOT);
    expect(reading?.source).toEqual({ protocol: 'orca-whirlpool', pool: SOL_WBTC_005 });
  });

  it('gives fees per unit of liquidity that the SDK reproduces for a position in range since creation', async () => {
    const [reading] = await readPools(publicPort(), [SOL_WBTC_005]);
    const whirlpool = publicWhirlpool();
    // A synthetic position around the current tick with zero checkpoints and zero
    // fee growth outside its ticks: the SDK then owes it L · global / 2⁶⁴.
    const liquidityRaw = 10n ** 15n;
    const lower = Math.floor(whirlpool.tickCurrentIndex / 8) * 8 - 800;
    const tick = {
      initialized: true,
      liquidityNet: 0n,
      liquidityGross: liquidityRaw,
      feeGrowthOutsideA: 0n,
      feeGrowthOutsideB: 0n,
      rewardGrowthsOutside: [0n, 0n, 0n],
    };
    const owed = collectFeesQuote(
      whirlpool,
      {
        liquidity: liquidityRaw,
        tickLowerIndex: lower,
        tickUpperIndex: lower + 1600,
        feeGrowthCheckpointA: 0n,
        feeOwedA: 0n,
        feeGrowthCheckpointB: 0n,
        feeOwedB: 0n,
        rewardInfos: [0n, 0n, 0n].map((g) => ({ growthInsideCheckpoint: g, amountOwed: 0n })),
      },
      tick,
      tick,
    );
    expect(owed.feeOwedA).toBe((liquidityRaw * whirlpool.feeGrowthGlobalA) / Q64);
    const liquidityModel = Number(liquidityRaw) / Math.sqrt(1e9 * 1e8);
    // A is SOL (quote), B is WBTC (base); compare in token units.
    expect(liquidityModel * (reading?.feeGrowthPerLiquidity.quote ?? NaN)).toBeCloseTo(
      Number(owed.feeOwedA) / 1e9,
      6,
    );
    expect(liquidityModel * (reading?.feeGrowthPerLiquidity.base ?? NaN)).toBeCloseTo(
      Number(owed.feeOwedB) / 1e8,
      8,
    );
    expect(owed.feeOwedA).toBeGreaterThan(0n);
  });

  it('reads pools in one call for their state, then one for mint decimals', async () => {
    const port = publicPort();
    const pools = await whirlpoolAddressesForPair(MINT.WBTC, MINT.SOL);
    const readings = await readPools(port, pools);
    expect(readings.map((r) => r.source.pool)).toEqual([SOL_WBTC_005]);
    expect(port.calls).toEqual([pools, [MINT.SOL, MINT.WBTC]]);
  });
});

describe('readPools on synthetic chain state', () => {
  function chainWith(spec: Partial<Parameters<SyntheticChain['addPool']>[0]> = {}) {
    const chain = new SyntheticChain();
    const pool = chain.addPool({
      mintA: MINT.SOL,
      mintB: MINT.WBTC,
      tickSpacing: 8,
      feeRate: 500,
      sqrtPrice: 2n ** 60n,
      tickCurrentIndex: -55452,
      liquidity: 10n ** 12n,
      feeGrowthGlobalA: 3n * Q64,
      feeGrowthGlobalB: Q64,
      ...spec,
    });
    return { chain, pool };
  }

  it('converts fee growth per raw liquidity to per model liquidity by √(10^dB / 10^dA)', async () => {
    const { chain, pool } = chainWith();
    const [reading] = await readPools(chain.port(), [pool]);
    // 3 SOL-base-units-per-raw-L → ×√(1e8/1e9) per model L in SOL; 1 for WBTC → ×√(1e9/1e8).
    expect(reading?.feeGrowthPerLiquidity.quote).toBeCloseTo(3 * Math.sqrt(0.1), 12);
    expect(reading?.feeGrowthPerLiquidity.base).toBeCloseTo(Math.sqrt(10), 12);
    expect(reading?.liquidity).toBeCloseTo(1e12 / Math.sqrt(1e17), 9);
  });

  it('takes every reading from the slot of the single state call', async () => {
    const { chain, pool } = chainWith();
    const other = chain.addPool({
      mintA: MINT.SOL,
      mintB: MINT.WBTC,
      tickSpacing: 64,
      feeRate: 3000,
      sqrtPrice: 2n ** 60n,
      tickCurrentIndex: -55452,
    });
    const readings = await readPools(chain.port(), [pool, fakeAddress(200), other]);
    const stateCall = chain.calls.find((c) => c.method === 'getAccounts');
    expect(readings.map((r) => r.source.pool)).toEqual([pool, other]);
    expect(readings.every((r) => r.slot === stateCall?.slot)).toBe(true);
    expect(chain.calls.filter((c) => c.method === 'getAccounts')).toHaveLength(2);
  });

  it('returns nothing, after one call, when no pool exists', async () => {
    const chain = new SyntheticChain();
    expect(await readPools(chain.port(), [fakeAddress(200)])).toEqual([]);
    expect(chain.calls).toHaveLength(1);
  });

  it('refuses an account that is not a Whirlpool', async () => {
    const chain = new SyntheticChain();
    chain.put(fakeAddress(201), TOKEN_PROGRAM, new Uint8Array(82));
    await expect(readPools(chain.port(), [fakeAddress(201)])).rejects.toBeInstanceOf(
      InvalidAccountError,
    );
  });

  it('refuses a pool with a Token-2022 mint', async () => {
    const { chain, pool } = chainWith();
    chain.addMint(MINT.WBTC, TOKEN_2022_PROGRAM);
    await expect(readPools(chain.port(), [pool])).rejects.toBeInstanceOf(UnsupportedPositionError);
  });

  it('refuses a response that is not aligned with the request', async () => {
    const { chain, pool } = chainWith();
    const port = chain.port();
    const shifted: SolanaReadPort = {
      ...port,
      getAccounts: async (addresses) => {
        const response = await port.getAccounts(addresses);
        return { ...response, accounts: response.accounts.slice(1) };
      },
    };
    await expect(readPools(shifted, [pool, fakeAddress(200)])).rejects.toBeInstanceOf(
      InvalidAccountError,
    );
  });

  it('refuses more pools than one call can read', async () => {
    const chain = new SyntheticChain();
    const many = Array.from({ length: 101 }, (_, i) => fakeAddress(i));
    await expect(readPools(chain.port(), many)).rejects.toBeInstanceOf(RangeError);
  });

  it('orients by quote preference and refuses a pair with no known quote', async () => {
    const chain = new SyntheticChain();
    const usdc = chain.addPool({
      mintA: MINT.WBTC,
      mintB: MINT.USDC,
      tickSpacing: 8,
      feeRate: 500,
      sqrtPrice: 2n ** 64n,
      tickCurrentIndex: 0,
    });
    const bonk = chain.addPool({
      mintA: MINT.BONK,
      mintB: MINT.WBTC,
      tickSpacing: 8,
      feeRate: 500,
      sqrtPrice: 2n ** 64n,
      tickCurrentIndex: 0,
    });
    const [reading] = await readPools(chain.port(), [usdc]);
    expect(reading?.pair.quote.mint).toBe(MINT.USDC);
    await expect(readPools(chain.port(), [bonk])).rejects.toBeInstanceOf(AmbiguousQuoteError);
    const [withPreference] = await readPools(chain.port(), [bonk], {
      quotePreference: [MINT.WBTC],
    });
    expect(withPreference?.pair.base.mint).toBe(MINT.BONK);
    expect(address(withPreference?.pair.quote.mint ?? '')).toBe(MINT.WBTC);
  });
});
