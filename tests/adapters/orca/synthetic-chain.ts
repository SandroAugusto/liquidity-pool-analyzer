/**
 * Synthetic Whirlpool chain state for offline adapter tests.
 *
 * Provenance: **synthetic**, not recorded from chain. Accounts are encoded with
 * the SDK's own encoders, so the adapter decodes exactly the byte layout it will
 * meet on chain; the values are chosen by each test. Tests pinned to real
 * recorded positions (#5, criteria 1–3) need recorded fixtures, which require
 * RPC access this environment does not have.
 *
 * Mint addresses are the real public mints (not secrets). Wallet and position
 * NFT addresses are made-up byte patterns.
 */

import {
  WHIRLPOOL_PROGRAM_ADDRESS,
  getDynamicTickArrayEncoder,
  getFixedTickArrayEncoder,
  getPositionAddress,
  getPositionEncoder,
  getTickArrayAddress,
  getWhirlpoolEncoder,
} from '@orca-so/whirlpools-client';
import type { TickArgs } from '@orca-so/whirlpools-client';
import {
  _TICK_ARRAY_SIZE,
  getTickArrayStartTickIndex,
  getTickIndexInArray,
} from '@orca-so/whirlpools-core';
import { address, getAddressDecoder } from '@solana/kit';
import type { Address } from '@solana/kit';

import type { RawAccount, SolanaReadPort } from '../../../src/adapters/orca/index.js';

export const MINT = {
  SOL: address('So11111111111111111111111111111111111111112'),
  WBTC: address('3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh'),
  USDC: address('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'),
  BONK: address('DezXAZ8z7PnrnRJjz3wXBoRgixCaDvZYsTHxu8fCbWuA'),
} as const;

export const DECIMALS: Record<string, number> = {
  [MINT.SOL]: 9,
  [MINT.WBTC]: 8,
  [MINT.USDC]: 6,
  [MINT.BONK]: 5,
};

export const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

/** A made-up address from a repeated byte. */
export function fakeAddress(byte: number): Address {
  return getAddressDecoder().decode(new Uint8Array(32).fill(byte));
}

export const WALLET = fakeAddress(7);

const ZERO_TICK: TickArgs = {
  initialized: false,
  liquidityNet: 0n,
  liquidityGross: 0n,
  feeGrowthOutsideA: 0n,
  feeGrowthOutsideB: 0n,
  rewardGrowthsOutside: [0n, 0n, 0n],
};

const NO_REWARD = {
  mint: address('11111111111111111111111111111111'),
  vault: address('11111111111111111111111111111111'),
  extension: new Uint8Array(32),
  emissionsPerSecondX64: 0n,
  growthGlobalX64: 0n,
};

export interface PoolSpec {
  readonly mintA: Address;
  readonly mintB: Address;
  readonly tickSpacing: number;
  /** Millionths: 500 is 0.05 %. */
  readonly feeRate: number;
  readonly sqrtPrice: bigint;
  readonly tickCurrentIndex: number;
  readonly feeGrowthGlobalA?: bigint;
  readonly feeGrowthGlobalB?: bigint;
  /** Active liquidity (raw); 0 unless given. */
  readonly liquidity?: bigint;
}

export interface PositionSpec {
  readonly liquidity: bigint;
  readonly tickLowerIndex: number;
  readonly tickUpperIndex: number;
  readonly feeOwedA?: bigint;
  readonly feeOwedB?: bigint;
  /** Encode the position's tick arrays as dynamic instead of fixed. */
  readonly dynamicTickArrays?: boolean;
  /** Do not create the tick arrays (an opened but never funded position). */
  readonly withoutTickArrays?: boolean;
  /** Fee growth outside the position's two ticks, token A (Q64.64). */
  readonly tickFeeGrowthOutsideA?: bigint;
}

/** In-memory chain plus a port over it that counts calls and stamps slots. */
export class SyntheticChain {
  readonly accounts = new Map<string, RawAccount>();
  readonly nftMints: Address[] = [];
  readonly calls: { method: string; slot: bigint; addresses: readonly string[] }[] = [];
  /** Runs before each `getAccounts` call, with its 0-based index; lets a test change state between calls. */
  beforeGetAccounts: (call: number) => void | Promise<void> = () => undefined;
  private slot = 100n;
  private nextByte = 20;

  put(addr: string, programAddress: string, data: Uint8Array): void {
    this.accounts.set(addr, { address: addr, programAddress, data });
  }

  addMint(mint: Address, programAddress = TOKEN_PROGRAM): void {
    const data = new Uint8Array(82);
    data[44] = DECIMALS[mint] ?? 0;
    this.put(mint, programAddress, data);
  }

  addPool(spec: PoolSpec): Address {
    const pool = fakeAddress(this.nextByte++);
    this.put(
      pool,
      WHIRLPOOL_PROGRAM_ADDRESS,
      Uint8Array.from(
        getWhirlpoolEncoder().encode({
          whirlpoolsConfig: fakeAddress(1),
          whirlpoolBump: new Uint8Array([255]),
          tickSpacing: spec.tickSpacing,
          feeTierIndexSeed: new Uint8Array([spec.tickSpacing, 0]),
          feeRate: spec.feeRate,
          protocolFeeRate: 1300,
          liquidity: spec.liquidity ?? 0n,
          sqrtPrice: spec.sqrtPrice,
          tickCurrentIndex: spec.tickCurrentIndex,
          protocolFeeOwedA: 0n,
          protocolFeeOwedB: 0n,
          tokenMintA: spec.mintA,
          tokenVaultA: fakeAddress(2),
          feeGrowthGlobalA: spec.feeGrowthGlobalA ?? 0n,
          tokenMintB: spec.mintB,
          tokenVaultB: fakeAddress(3),
          feeGrowthGlobalB: spec.feeGrowthGlobalB ?? 0n,
          rewardLastUpdatedTimestamp: 0n,
          rewardInfos: [NO_REWARD, NO_REWARD, NO_REWARD],
        }),
      ),
    );
    for (const mint of [spec.mintA, spec.mintB]) {
      if (!this.accounts.has(mint)) {
        this.addMint(mint);
      }
    }
    return pool;
  }

  /** Adds a position NFT held by the wallet, the position and its two tick arrays. */
  async addPosition(pool: Address, tickSpacing: number, spec: PositionSpec): Promise<Address> {
    const nft = fakeAddress(this.nextByte++);
    const [position] = await getPositionAddress(nft);
    this.nftMints.push(nft);
    this.writePosition(position, pool, nft, spec);
    if (spec.withoutTickArrays !== true) {
      await this.addTickArrays(pool, tickSpacing, spec);
    }
    return position;
  }

  /** Writes (or updates) the tick arrays holding the spec's two ticks. */
  async addTickArrays(pool: Address, tickSpacing: number, spec: PositionSpec): Promise<void> {
    for (const tickIndex of [spec.tickLowerIndex, spec.tickUpperIndex]) {
      await this.writeTickArray(
        pool,
        tickSpacing,
        tickIndex,
        spec.dynamicTickArrays ?? false,
        spec.tickFeeGrowthOutsideA ?? 0n,
      );
    }
  }

  writePosition(position: Address, pool: Address, nft: Address, spec: PositionSpec): void {
    this.put(
      position,
      WHIRLPOOL_PROGRAM_ADDRESS,
      Uint8Array.from(
        getPositionEncoder().encode({
          whirlpool: pool,
          positionMint: nft,
          liquidity: spec.liquidity,
          tickLowerIndex: spec.tickLowerIndex,
          tickUpperIndex: spec.tickUpperIndex,
          feeGrowthCheckpointA: 0n,
          feeOwedA: spec.feeOwedA ?? 0n,
          feeGrowthCheckpointB: 0n,
          feeOwedB: spec.feeOwedB ?? 0n,
          rewardInfos: [0, 1, 2].map(() => ({ growthInsideCheckpoint: 0n, amountOwed: 0n })),
        }),
      ),
    );
  }

  private async writeTickArray(
    pool: Address,
    tickSpacing: number,
    tickIndex: number,
    dynamic: boolean,
    feeGrowthOutsideA: bigint,
  ): Promise<void> {
    const start = getTickArrayStartTickIndex(tickIndex, tickSpacing);
    const [tickArray] = await getTickArrayAddress(pool, start);
    // Mark the position's tick initialised; keep any tick already written.
    const existing = this.initialisedTicks.get(tickArray) ?? new Map<number, bigint>();
    existing.set(getTickIndexInArray(tickIndex, start, tickSpacing), feeGrowthOutsideA);
    this.initialisedTicks.set(tickArray, existing);
    const size = _TICK_ARRAY_SIZE();
    const data = dynamic
      ? getDynamicTickArrayEncoder().encode({
          startTickIndex: start,
          whirlpool: pool,
          tickBitmap: [...existing.keys()].reduce((bits, i) => bits | (1n << BigInt(i)), 0n),
          ticks: Array.from({ length: size }, (_, i) =>
            existing.has(i)
              ? {
                  __kind: 'Initialized' as const,
                  fields: [
                    {
                      liquidityNet: 0n,
                      liquidityGross: 1n,
                      feeGrowthOutsideA: existing.get(i) ?? 0n,
                      feeGrowthOutsideB: 0n,
                      rewardGrowthsOutside: [0n, 0n, 0n],
                    },
                  ] as const,
                }
              : { __kind: 'Uninitialized' as const },
          ),
        })
      : getFixedTickArrayEncoder().encode({
          startTickIndex: start,
          whirlpool: pool,
          ticks: Array.from({ length: size }, (_, i) =>
            existing.has(i)
              ? {
                  ...ZERO_TICK,
                  initialized: true,
                  liquidityGross: 1n,
                  feeGrowthOutsideA: existing.get(i) ?? 0n,
                }
              : ZERO_TICK,
          ),
        });
    this.put(tickArray, WHIRLPOOL_PROGRAM_ADDRESS, Uint8Array.from(data));
  }

  private readonly initialisedTicks = new Map<string, Map<number, bigint>>();

  port(): SolanaReadPort {
    return {
      findNftMints: (owner) => {
        const slot = this.slot++;
        this.calls.push({ method: 'findNftMints', slot, addresses: [owner] });
        return Promise.resolve({ slot, mints: owner === WALLET ? [...this.nftMints] : [] });
      },
      getAccounts: async (addresses) => {
        await this.beforeGetAccounts(this.calls.filter((c) => c.method === 'getAccounts').length);
        const slot = this.slot++;
        this.calls.push({ method: 'getAccounts', slot, addresses });
        return { slot, accounts: addresses.map((a) => this.accounts.get(a) ?? null) };
      },
    };
  }
}
