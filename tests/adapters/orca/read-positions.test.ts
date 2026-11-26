/**
 * Orca reader against synthetic chain state (see synthetic-chain.ts for
 * provenance). These tests pin the adapter's own logic — orientation, unit
 * conversion, single-slot reads, account validation — against the SDK's
 * independent integer math. Agreement with *real* positions (#5, criteria 1–2)
 * needs recorded fixtures and is not claimed here.
 */

import { WHIRLPOOL_PROGRAM_ADDRESS } from '@orca-so/whirlpools-client';
import {
  getInitializableTickIndex,
  priceToSqrtPrice,
  priceToTickIndex,
  sqrtPriceToTickIndex,
  tickIndexToPrice,
  tickIndexToSqrtPrice,
} from '@orca-so/whirlpools-core';
import type { Address } from '@solana/kit';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { readPositions } from '../../../src/adapters/orca/index.js';
import { amountsAtPrice } from '../../../src/math/index.js';
import {
  AmbiguousQuoteError,
  InconsistentReadError,
  InvalidAccountError,
  UnsupportedPositionError,
} from '../../../src/positions/index.js';
import type { PositionReading } from '../../../src/positions/index.js';
import {
  DECIMALS,
  MINT,
  SyntheticChain,
  TOKEN_2022_PROGRAM,
  WALLET,
  fakeAddress,
} from './synthetic-chain.js';

const SPACING = 16;
const Q64 = 1n << 64n;

/**
 * A synthetic WBTC/SOL pool: range ≈ 1150–1250 and price 1200, SOL per WBTC. On chain SOL is token A (its address sorts first),
 * so the pool's native price is WBTC per SOL ≈ 0.00083.
 */
function wbtcSolPool(
  chain: SyntheticChain,
  extra: { feeGrowthGlobalA?: bigint; feeGrowthGlobalB?: bigint } = {},
): { pool: Address; lower: number; upper: number } {
  const [decA, decB] = [DECIMALS[MINT.SOL] ?? 0, DECIMALS[MINT.WBTC] ?? 0];
  const sqrtPrice = priceToSqrtPrice(1 / 1200, decA, decB);
  const pool = chain.addPool({
    mintA: MINT.SOL,
    mintB: MINT.WBTC,
    tickSpacing: SPACING,
    feeRate: 500,
    sqrtPrice,
    tickCurrentIndex: sqrtPriceToTickIndex(sqrtPrice),
    ...extra,
  });
  return {
    pool,
    lower: getInitializableTickIndex(priceToTickIndex(1 / 1250, decA, decB), SPACING, false),
    upper: getInitializableTickIndex(priceToTickIndex(1 / 1150, decA, decB), SPACING, true),
  };
}

async function readOne(chain: SyntheticChain): Promise<PositionReading> {
  const readings = await readPositions(chain.port(), WALLET);
  expect(readings).toHaveLength(1);
  const [reading] = readings;
  if (reading === undefined) {
    throw new Error('unreachable: length checked');
  }
  return reading;
}

/** Relative difference, with an absolute floor for amounts near zero. */
function close(actual: number, expected: number, sigFigs = 4, floor = 0): boolean {
  return Math.abs(actual - expected) <= Math.max(Math.abs(expected) * 10 ** -sigFigs, floor);
}

describe('orientation (SOL is token A in WBTC/SOL)', () => {
  it('quotes SOL per WBTC, not the pool-native WBTC per SOL', async () => {
    const chain = new SyntheticChain();
    const { pool, lower, upper } = wbtcSolPool(chain);
    await chain.addPosition(pool, SPACING, {
      liquidity: 4_000_000_000n,
      tickLowerIndex: lower,
      tickUpperIndex: upper,
    });

    const reading = await readOne(chain);

    expect(reading.pair.base.mint).toBe(MINT.WBTC);
    expect(reading.pair.quote.mint).toBe(MINT.SOL);
    expect(reading.price).toBeCloseTo(1200, 6);
    // Tick quantisation (spacing 16 ≈ 0.16 %) moves the bounds slightly outward.
    expect(reading.position.range.lower).toBeGreaterThan(1150 * 0.998);
    expect(reading.position.range.lower).toBeLessThanOrEqual(1150);
    expect(reading.position.range.upper).toBeGreaterThanOrEqual(1250);
    expect(reading.position.range.upper).toBeLessThan(1250 * 1.002);
    expect(reading.feeRate).toBe(0.0005);
  });

  it('puts the base token (WBTC, token B) in amounts.base', async () => {
    const chain = new SyntheticChain();
    const { pool, lower, upper } = wbtcSolPool(chain);
    await chain.addPosition(pool, SPACING, {
      liquidity: 4_000_000_000n,
      tickLowerIndex: lower,
      tickUpperIndex: upper,
    });

    const { amounts } = await readOne(chain);

    // Inside the range near its middle: some of each, WBTC worth ~1/100 of SOL in count.
    expect(amounts.base).toBeGreaterThan(0.001);
    expect(amounts.base).toBeLessThan(0.02);
    expect(amounts.quote).toBeGreaterThan(1);
    expect(amounts.quote).toBeLessThan(20);
  });
});

describe('model vs SDK (#5 criterion 2, on synthetic state)', () => {
  it('amountsAtPrice on the reading matches the SDK amounts to 4 significant figures', async () => {
    const chain = new SyntheticChain();
    const { pool, lower, upper } = wbtcSolPool(chain);
    await chain.addPosition(pool, SPACING, {
      liquidity: 4_000_000_000n,
      tickLowerIndex: lower,
      tickUpperIndex: upper,
    });

    const reading = await readOne(chain);
    const model = amountsAtPrice(reading.position, reading.price);

    expect(close(model.base, reading.amounts.base)).toBe(true);
    expect(close(model.quote, reading.amounts.quote)).toBe(true);
  });

  // Random pools, both orientations, in and out of range. The SDK computes
  // amounts in integer fixed point from ticks and sqrtPrice; the model computes
  // them in floating point from the converted price, range and liquidity. They
  // only agree if every conversion (direction, decimals, liquidity units) is right.
  it('holds for random pools, decimals, ranges and prices', async () => {
    const pairs = [
      [MINT.SOL, MINT.WBTC], // base = B (WBTC), quote = A (SOL)
      [MINT.SOL, MINT.USDC], // base = A (SOL), quote = B (USDC)
      [MINT.BONK, MINT.SOL], // base = A (BONK), quote = B (SOL)
    ] as const;
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...pairs),
        fc.integer({ min: -2000, max: 2000 }), // lower tick, in spacings
        fc.integer({ min: 1, max: 400 }), // width, in spacings
        fc.double({ min: -0.5, max: 1.5, noNaN: true }), // price position relative to the range
        fc.bigInt({ min: 10n ** 9n, max: 10n ** 15n }), // raw liquidity
        async ([mintA, mintB], lowerSpacings, widthSpacings, at, liquidity) => {
          const lower = lowerSpacings * SPACING * 10;
          const upper = lower + widthSpacings * SPACING;
          const tick = Math.round(lower + at * (upper - lower));
          const sqrtPrice = tickIndexToSqrtPrice(tick);
          const chain = new SyntheticChain();
          const pool = chain.addPool({
            mintA,
            mintB,
            tickSpacing: SPACING,
            feeRate: 3000,
            sqrtPrice,
            tickCurrentIndex: tick,
          });
          await chain.addPosition(pool, SPACING, {
            liquidity,
            tickLowerIndex: lower,
            tickUpperIndex: upper,
          });

          // Discard states no real pool can hold: an amount above u64::MAX
          // makes the SDK refuse, which is correct and not under test here.
          const readings = await readPositions(chain.port(), WALLET).catch((error: unknown) => {
            if (String(error).includes('exceeds max u64')) {
              return null;
            }
            throw error;
          });
          fc.pre(readings !== null);
          const [reading] = readings;
          if (reading === undefined) {
            throw new Error('expected one reading');
          }
          const model = amountsAtPrice(reading.position, reading.price);

          // The SDK floors to whole base units: allow one unit of each token.
          const unitBase = 10 ** -reading.pair.base.decimals;
          const unitQuote = 10 ** -reading.pair.quote.decimals;
          expect(close(model.base, reading.amounts.base, 4, 2 * unitBase)).toBe(true);
          expect(close(model.quote, reading.amounts.quote, 4, 2 * unitQuote)).toBe(true);
        },
      ),
      { numRuns: 150 },
    );
  });
});

describe('fees owed', () => {
  // In range with zero growth outside both ticks, growth inside equals global
  // growth, so fees = owed + L · growth / 2^64 (base units), per token.
  const growthA = 3n * Q64 + Q64 / 4n; // 3.25 base units of A per unit of liquidity
  const growthB = Q64 / 1000n;

  for (const dynamicTickArrays of [false, true]) {
    it(`are computed from ${dynamicTickArrays ? 'dynamic' : 'fixed'} tick arrays`, async () => {
      const chain = new SyntheticChain();
      const { pool, lower, upper } = wbtcSolPool(chain, {
        feeGrowthGlobalA: growthA,
        feeGrowthGlobalB: growthB,
      });
      const liquidity = 4_000_000_000n;
      await chain.addPosition(pool, SPACING, {
        liquidity,
        tickLowerIndex: lower,
        tickUpperIndex: upper,
        feeOwedA: 1_000n,
        feeOwedB: 7n,
        dynamicTickArrays,
      });

      const { feesOwed } = await readOne(chain);

      const expectedSolRaw = 1_000n + (liquidity * growthA) / Q64; // token A = SOL = quote
      const expectedWbtcRaw = 7n + (liquidity * growthB) / Q64; // token B = WBTC = base
      expect(feesOwed.quote).toBeCloseTo(Number(expectedSolRaw) / 1e9, 9);
      expect(feesOwed.base).toBeCloseTo(Number(expectedWbtcRaw) / 1e8, 8);
    });
  }
});

describe('consistent read (#5 criterion 7)', () => {
  it('takes every mutable figure from the state call, with its slot', async () => {
    const chain = new SyntheticChain();
    const { pool, lower, upper } = wbtcSolPool(chain);
    const position = await chain.addPosition(pool, SPACING, {
      liquidity: 4_000_000_000n,
      tickLowerIndex: lower,
      tickUpperIndex: upper,
    });
    const nft = chain.nftMints[0];
    if (nft === undefined) {
      throw new Error('expected one NFT');
    }
    // Discovery sees liquidity 4e9; before the state call (the 4th getAccounts:
    // positions, pools, mints, state) liquidity doubles.
    chain.beforeGetAccounts = (call) => {
      if (call === 3) {
        chain.writePosition(position, pool, nft, {
          liquidity: 8_000_000_000n,
          tickLowerIndex: lower,
          tickUpperIndex: upper,
        });
      }
    };

    const reading = await readOne(chain);

    const stateCall = chain.calls.at(-1);
    expect(stateCall?.addresses).toEqual(expect.arrayContaining([position, pool]));
    expect(reading.slot).toBe(stateCall?.slot);
    // Amounts and liquidity both reflect 8e9: they come from the same response.
    const baseline = new SyntheticChain();
    const b = wbtcSolPool(baseline);
    await baseline.addPosition(b.pool, SPACING, {
      liquidity: 8_000_000_000n,
      tickLowerIndex: lower,
      tickUpperIndex: upper,
    });
    const expected = await readOne(baseline);
    expect(reading.position.liquidity).toBe(expected.position.liquidity);
    expect(reading.amounts).toEqual(expected.amounts);
  });

  it('skips a position closed between discovery and the state call', async () => {
    const chain = new SyntheticChain();
    const { pool, lower, upper } = wbtcSolPool(chain);
    const position = await chain.addPosition(pool, SPACING, {
      liquidity: 1n,
      tickLowerIndex: lower,
      tickUpperIndex: upper,
    });
    chain.beforeGetAccounts = (call) => {
      if (call === 3) {
        chain.accounts.delete(position);
      }
    };

    expect(await readPositions(chain.port(), WALLET)).toEqual([]);
  });

  it('splits more than 25 positions over several state calls', async () => {
    const chain = new SyntheticChain();
    const { pool, lower, upper } = wbtcSolPool(chain);
    for (let i = 0; i < 30; i += 1) {
      await chain.addPosition(pool, SPACING, {
        liquidity: BigInt(i + 1) * 1_000_000n,
        tickLowerIndex: lower,
        tickUpperIndex: upper,
      });
    }

    const readings = await readPositions(chain.port(), WALLET);

    expect(readings).toHaveLength(30);
    const stateCalls = chain.calls.filter((c) => c.addresses.length % 4 === 0).slice(-2);
    expect(stateCalls.map((c) => c.addresses.length)).toEqual([100, 20]);
    expect(new Set(readings.map((r) => r.slot)).size).toBe(2);
  });
});

// Review of #14: a position's range is not immutable. `reset_position_range`
// (and `reposition_liquidity_v2`) rewrite its tick bounds, so bounds seen in
// discovery must be re-checked against the state call.
describe('range changed between discovery and state (review of #14)', () => {
  const growthGlobal = 10n * Q64;
  const growthOutsideOld = 2n * Q64;

  it('uses the new bounds’ ticks for fees, not the discovery plan’s', async () => {
    const chain = new SyntheticChain();
    const { pool, lower, upper } = wbtcSolPool(chain, { feeGrowthGlobalA: growthGlobal });
    const liquidity = 4_000_000_000n;
    const position = await chain.addPosition(pool, SPACING, {
      liquidity,
      tickLowerIndex: lower,
      tickUpperIndex: upper,
      tickFeeGrowthOutsideA: growthOutsideOld,
    });
    const nft = chain.nftMints[0];
    if (nft === undefined) {
      throw new Error('expected one NFT');
    }
    // Same tick arrays, narrower range; the new ticks have no growth outside.
    const moved = { liquidity, tickLowerIndex: lower + SPACING, tickUpperIndex: upper - SPACING };
    chain.beforeGetAccounts = async (call) => {
      if (call === 3) {
        chain.writePosition(position, pool, nft, moved);
        await chain.addTickArrays(pool, SPACING, { ...moved, tickFeeGrowthOutsideA: 0n });
      }
    };

    const reading = await readOne(chain);

    // In range, zero growth outside the new ticks: fees = L · global / 2^64.
    expect(reading.feesOwed.quote).toBeCloseTo(Number((liquidity * growthGlobal) / Q64) / 1e9, 9);
    const expectedLower = 1 / tickIndexToPrice(moved.tickUpperIndex, 9, 8);
    expect(reading.position.range.lower).toBeCloseTo(expectedLower, 9);
  });

  it('re-plans when the new bounds live in other tick arrays', async () => {
    const chain = new SyntheticChain();
    const { pool, lower, upper } = wbtcSolPool(chain);
    const position = await chain.addPosition(pool, SPACING, {
      liquidity: 4_000_000_000n,
      tickLowerIndex: lower,
      tickUpperIndex: upper,
    });
    const nft = chain.nftMints[0];
    if (nft === undefined) {
      throw new Error('expected one NFT');
    }
    const far = {
      liquidity: 4_000_000_000n,
      tickLowerIndex: lower - 8 * 1408,
      tickUpperIndex: upper + 8 * 1408,
    };
    chain.beforeGetAccounts = async (call) => {
      if (call === 3) {
        // The old range's tick arrays are gone; only the new ones exist.
        for (const [addr, account] of chain.accounts) {
          if (account.programAddress === WHIRLPOOL_PROGRAM_ADDRESS && account.data.length > 1000) {
            chain.accounts.delete(addr);
          }
        }
        chain.writePosition(position, pool, nft, far);
        await chain.addTickArrays(pool, SPACING, far);
      }
    };

    const reading = await readOne(chain);

    expect(reading.position.range.upper).toBeCloseTo(
      1 / tickIndexToPrice(far.tickLowerIndex, 9, 8),
      6,
    );
    expect(reading.slot).toBe(chain.calls.at(-1)?.slot);
  });

  it('refuses when the range keeps changing', async () => {
    const chain = new SyntheticChain();
    const { pool, lower, upper } = wbtcSolPool(chain);
    const position = await chain.addPosition(pool, SPACING, {
      liquidity: 1n,
      tickLowerIndex: lower,
      tickUpperIndex: upper,
    });
    const nft = chain.nftMints[0];
    if (nft === undefined) {
      throw new Error('expected one NFT');
    }
    chain.beforeGetAccounts = (call) => {
      if (call >= 3) {
        const shift = (call % 2 === 0 ? 1 : 2) * SPACING;
        chain.writePosition(position, pool, nft, {
          liquidity: 1n,
          tickLowerIndex: lower + shift,
          tickUpperIndex: upper - shift,
        });
      }
    };

    await expect(readPositions(chain.port(), WALLET)).rejects.toThrow(InconsistentReadError);
  });
});

// Review of #14: `open_position` creates the position without tick arrays;
// they appear only when liquidity is added.
describe('unfunded open position (review of #14)', () => {
  it('is read from its stored fields, without tick arrays, alongside funded ones', async () => {
    const chain = new SyntheticChain();
    const { pool, lower, upper } = wbtcSolPool(chain);
    await chain.addPosition(pool, SPACING, {
      liquidity: 4_000_000_000n,
      tickLowerIndex: lower,
      tickUpperIndex: upper,
    });
    const far = { lower: lower - 30 * 1408, upper: upper - 30 * 1408 };
    await chain.addPosition(pool, SPACING, {
      liquidity: 0n,
      tickLowerIndex: far.lower,
      tickUpperIndex: far.upper,
      feeOwedA: 1_000n,
      feeOwedB: 7n,
      withoutTickArrays: true,
    });

    const readings = await readPositions(chain.port(), WALLET);

    expect(readings).toHaveLength(2);
    const unfunded = readings.find((r) => r.position.liquidity === 0);
    expect(unfunded?.amounts).toMatchObject({ base: 0, quote: 0 });
    expect(unfunded?.feesOwed).toMatchObject({ base: 7 / 1e8, quote: 1_000 / 1e9 });
  });
});

describe('discovery', () => {
  it('returns nothing for a wallet without NFTs', async () => {
    expect(await readPositions(new SyntheticChain().port(), WALLET)).toEqual([]);
  });

  it('ignores NFTs that are not Whirlpool positions', async () => {
    const chain = new SyntheticChain();
    chain.nftMints.push(fakeAddress(99)); // its position PDA does not exist
    expect(await readPositions(chain.port(), WALLET)).toEqual([]);
  });
});

describe('refusals', () => {
  it('throws AmbiguousQuoteError when neither token is a known quote', async () => {
    const chain = new SyntheticChain();
    const pool = chain.addPool({
      mintA: MINT.BONK,
      mintB: MINT.WBTC,
      tickSpacing: SPACING,
      feeRate: 3000,
      sqrtPrice: Q64,
      tickCurrentIndex: 0,
    });
    await chain.addPosition(pool, SPACING, {
      liquidity: 1n,
      tickLowerIndex: -16,
      tickUpperIndex: 16,
    });

    await expect(readPositions(chain.port(), WALLET)).rejects.toThrow(AmbiguousQuoteError);
  });

  it('accepts an explicit quote preference for such a pair', async () => {
    const chain = new SyntheticChain();
    const pool = chain.addPool({
      mintA: MINT.BONK,
      mintB: MINT.WBTC,
      tickSpacing: SPACING,
      feeRate: 3000,
      sqrtPrice: Q64,
      tickCurrentIndex: 0,
    });
    await chain.addPosition(pool, SPACING, {
      liquidity: 1n,
      tickLowerIndex: -16,
      tickUpperIndex: 16,
    });

    const [reading] = await readPositions(chain.port(), WALLET, { quotePreference: [MINT.WBTC] });

    expect(reading?.pair.quote.mint).toBe(MINT.WBTC);
  });

  it('throws UnsupportedPositionError for a Token-2022 mint', async () => {
    const chain = new SyntheticChain();
    chain.addMint(MINT.USDC, TOKEN_2022_PROGRAM);
    const pool = chain.addPool({
      mintA: MINT.SOL,
      mintB: MINT.USDC,
      tickSpacing: SPACING,
      feeRate: 3000,
      sqrtPrice: Q64,
      tickCurrentIndex: 0,
    });
    await chain.addPosition(pool, SPACING, {
      liquidity: 1n,
      tickLowerIndex: -16,
      tickUpperIndex: 16,
    });

    await expect(readPositions(chain.port(), WALLET)).rejects.toThrow(UnsupportedPositionError);
  });

  it.each([
    [
      'the pool is not a Whirlpool',
      (c: SyntheticChain, pool: string) => {
        const account = c.accounts.get(pool);
        if (account) c.put(pool, '11111111111111111111111111111111', account.data);
      },
    ],
    ['a mint is missing', (c: SyntheticChain) => c.accounts.delete(MINT.WBTC)],
    [
      'a tick array is missing',
      (c: SyntheticChain) => {
        for (const [addr, account] of c.accounts) {
          if (account.programAddress === WHIRLPOOL_PROGRAM_ADDRESS && account.data.length > 1000) {
            c.accounts.delete(addr);
          }
        }
      },
    ],
  ])('throws InvalidAccountError when %s', async (_, corrupt) => {
    const chain = new SyntheticChain();
    const { pool, lower, upper } = wbtcSolPool(chain);
    await chain.addPosition(pool, SPACING, {
      liquidity: 1n,
      tickLowerIndex: lower,
      tickUpperIndex: upper,
    });
    corrupt(chain, pool);

    await expect(readPositions(chain.port(), WALLET)).rejects.toThrow(InvalidAccountError);
  });

  // Reversing only the mint lookup (SOL, WBTC) would, unguarded, swap their
  // decimals (9 ↔ 8) and every amount would be off by 10× — silently.
  it('throws InvalidAccountError when the port returns a misaligned response', async () => {
    const chain = new SyntheticChain();
    const { pool, lower, upper } = wbtcSolPool(chain);
    await chain.addPosition(pool, SPACING, {
      liquidity: 1n,
      tickLowerIndex: lower,
      tickUpperIndex: upper,
    });
    const port = chain.port();
    let call = 0;
    const misaligned = {
      ...port,
      getAccounts: async (addresses: readonly string[]) => {
        const response = await port.getAccounts(addresses);
        const isMintLookup = call++ === 2;
        return isMintLookup
          ? { ...response, accounts: [...response.accounts].reverse() }
          : response;
      },
    };

    await expect(readPositions(misaligned, WALLET)).rejects.toThrow(InvalidAccountError);
  });
});
