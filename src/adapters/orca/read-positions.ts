/**
 * Reads every open Orca Whirlpool position of a wallet as protocol-neutral
 * {@link PositionReading}s. Read-only: nothing here builds or signs anything.
 *
 * Two phases, so that every figure of a position comes from one slot (#5,
 * criterion 7):
 *
 * 1. **Discovery** — find the wallet's position NFTs, then the positions,
 *    pools and mints they point to. Immutable facts are kept from this phase
 *    (a position's pool, a pool's mints and tick spacing, a mint's decimals),
 *    plus each position's tick bounds, which are only a plan: they can change
 *    (`reset_position_range`, `reposition_liquidity_v2`).
 * 2. **State** — one `getAccounts` call per group of positions, containing
 *    each position, its pool and both tick arrays. Liquidity, price, amounts
 *    and fees are computed from that response alone, so they share its slot.
 *    A position whose bounds no longer match its plan is re-planned and read
 *    again, up to {@link MAX_READS} times; its tick arrays may be different
 *    accounts now.
 *
 * A position without liquidity (opened, never funded or fully withdrawn) is
 * read from its own fields: it holds no tokens, its fees owed were settled on
 * its last liquidity change, and its tick arrays may never have been created.
 *
 * Amounts and fees come from the Orca SDK's own math (`@orca-so/whirlpools-core`),
 * not from `src/math`: the SDK is the on-chain source of truth that the
 * continuous model is validated against.
 */

import {
  POSITION_DISCRIMINATOR,
  WHIRLPOOL_DISCRIMINATOR,
  WHIRLPOOL_PROGRAM_ADDRESS,
  decodeTickArray,
  getPositionAddress,
  getPositionDecoder,
  getPositionSize,
  getTickArrayAddress,
  getWhirlpoolDecoder,
  getWhirlpoolSize,
} from '@orca-so/whirlpools-client';
import type { Position as OrcaPosition, TickArray, Whirlpool } from '@orca-so/whirlpools-client';
import {
  collectFeesQuote,
  decreaseLiquidityQuote,
  getTickArrayStartTickIndex,
  getTickIndexInArray,
} from '@orca-so/whirlpools-core';
import { address, lamports } from '@solana/kit';

import { createPosition } from '../../math/index.js';
import {
  InconsistentReadError,
  InvalidAccountError,
  UnsupportedPositionError,
} from '../../positions/index.js';
import type { PositionReading, TokenInfo } from '../../positions/index.js';
import {
  baseIsTokenA,
  priceFromSqrtPrice,
  rangeFromTicks,
  toModelLiquidity,
  toTokenAmounts,
} from './conversion.js';
import type { Orientation } from './conversion.js';
import { MAX_ACCOUNTS_PER_CALL } from './port.js';
import type { RawAccount, SolanaReadPort } from './port.js';

const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
/** Offset of `decimals` in an SPL mint account (same in Token-2022's base layout). */
const MINT_DECIMALS_OFFSET = 44;
/** Whirlpool `feeRate` is in millionths. */
const FEE_RATE_DENOMINATOR = 1_000_000;
/** Accounts per position in the state call: position, pool, two tick arrays. */
const STATE_ACCOUNTS_PER_POSITION = 4;
/** State reads per position before giving up on a range that keeps moving. */
const MAX_READS = 3;

/**
 * Quote tokens in order of preference: USDC, USDT, SOL. In a WBTC/SOL pool
 * this makes SOL the quote, matching the Orca UI's "SOL per WBTC". A pair with
 * neither token listed needs an explicit preference.
 */
export const DEFAULT_QUOTE_PREFERENCE: readonly string[] = [
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
  'So11111111111111111111111111111111111111112',
];

export interface ReadPositionsOptions {
  /** Quote mints in order of preference; see {@link DEFAULT_QUOTE_PREFERENCE}. */
  readonly quotePreference?: readonly string[];
}

/**
 * A position's pool (immutable) and tick bounds (as last seen; re-checked in
 * the state call).
 */
interface PositionRef {
  readonly address: string;
  readonly pool: string;
  readonly tickLowerIndex: number;
  readonly tickUpperIndex: number;
}

/** Immutable facts about a pool, from discovery. */
interface PoolRef {
  readonly mintA: string;
  readonly mintB: string;
  readonly tickSpacing: number;
}

/** A position with everything needed to fetch and interpret its state. */
interface PositionPlan extends PositionRef {
  readonly orientation: Orientation;
  readonly pair: { readonly base: TokenInfo; readonly quote: TokenInfo };
  readonly tickArrayLower: { readonly address: string; readonly start: number };
  readonly tickArrayUpper: { readonly address: string; readonly start: number };
  readonly tickSpacing: number;
}

/**
 * Every open Whirlpool position held by `wallet`, as of the slot recorded in
 * each reading. Position bundles are not read (v1).
 *
 * @throws {AmbiguousQuoteError} when a pair's quote token cannot be chosen.
 * @throws {UnsupportedPositionError} for a pool with a Token-2022 mint (transfer
 *   fees are not handled yet).
 * @throws {InvalidAccountError} when an account the reading depends on is
 *   missing or malformed.
 * @throws {InconsistentReadError} when a position's range changes on every one
 *   of {@link MAX_READS} reads.
 */
export async function readPositions(
  port: SolanaReadPort,
  wallet: string,
  options: ReadPositionsOptions = {},
): Promise<readonly PositionReading[]> {
  const quotePreference = options.quotePreference ?? DEFAULT_QUOTE_PREFERENCE;

  const refs = await discoverPositions(port, wallet);
  if (refs.length === 0) {
    return [];
  }
  const pools = await discoverPools(port, unique(refs.map((ref) => ref.pool)));
  const decimals = await discoverMints(
    port,
    unique([...pools.values()].flatMap((pool) => [pool.mintA, pool.mintB])),
  );
  const plan = (ref: PositionRef): Promise<PositionPlan> =>
    planPosition(ref, pools, decimals, quotePreference);

  const readings: PositionReading[] = [];
  const perCall = Math.floor(MAX_ACCOUNTS_PER_CALL / STATE_ACCOUNTS_PER_POSITION);
  let pending = await Promise.all(refs.map(plan));
  for (let read = 1; pending.length > 0; read += 1) {
    const moved: PositionRef[] = [];
    for (let i = 0; i < pending.length; i += perCall) {
      const state = await readState(port, pending.slice(i, i + perCall));
      readings.push(...state.readings);
      moved.push(...state.moved);
    }
    const [first] = moved;
    if (first !== undefined && read === MAX_READS) {
      throw new InconsistentReadError(first.address, MAX_READS);
    }
    pending = await Promise.all(moved.map(plan));
  }
  return readings;
}

async function discoverPositions(port: SolanaReadPort, wallet: string): Promise<PositionRef[]> {
  const { mints } = await port.findNftMints(wallet);
  const addresses = await Promise.all(
    mints.map(async (mint) => (await getPositionAddress(address(mint)))[0]),
  );
  const accounts = await getAccountsChunked(port, addresses);
  const refs: PositionRef[] = [];
  accounts.forEach((account) => {
    // An NFT whose position PDA is not a Whirlpool position is some other NFT.
    if (account === null || !isAccountOf(account, getPositionSize(), POSITION_DISCRIMINATOR)) {
      return;
    }
    const position = getPositionDecoder().decode(account.data);
    refs.push({
      address: account.address,
      pool: position.whirlpool,
      tickLowerIndex: position.tickLowerIndex,
      tickUpperIndex: position.tickUpperIndex,
    });
  });
  return refs;
}

async function discoverPools(
  port: SolanaReadPort,
  addresses: readonly string[],
): Promise<Map<string, PoolRef>> {
  const accounts = await getAccountsChunked(port, addresses);
  const pools = new Map<string, PoolRef>();
  accounts.forEach((account, i) => {
    const pool = decodePool(account, addresses[i] ?? '');
    pools.set(pool.address, {
      mintA: pool.whirlpool.tokenMintA,
      mintB: pool.whirlpool.tokenMintB,
      tickSpacing: pool.whirlpool.tickSpacing,
    });
  });
  return pools;
}

/** Decimals per mint; `null` for a Token-2022 mint (unsupported, see readPositions). */
async function discoverMints(
  port: SolanaReadPort,
  addresses: readonly string[],
): Promise<Map<string, number | null>> {
  const accounts = await getAccountsChunked(port, addresses);
  const decimals = new Map<string, number | null>();
  accounts.forEach((account, i) => {
    const mint = addresses[i] ?? '';
    if (account?.programAddress === TOKEN_2022_PROGRAM) {
      decimals.set(mint, null);
      return;
    }
    const value = account?.data[MINT_DECIMALS_OFFSET];
    if (account?.programAddress !== TOKEN_PROGRAM || value === undefined) {
      throw new InvalidAccountError(mint, 'SPL token mint');
    }
    decimals.set(mint, value);
  });
  return decimals;
}

async function planPosition(
  ref: PositionRef,
  pools: ReadonlyMap<string, PoolRef>,
  decimals: ReadonlyMap<string, number | null>,
  quotePreference: readonly string[],
): Promise<PositionPlan> {
  const pool = pools.get(ref.pool);
  if (pool === undefined) {
    throw new InvalidAccountError(ref.pool, 'Whirlpool');
  }
  const decimalsA = decimals.get(pool.mintA);
  const decimalsB = decimals.get(pool.mintB);
  if (decimalsA === null || decimalsB === null) {
    throw new UnsupportedPositionError(ref.address, 'pool has a Token-2022 mint');
  }
  if (decimalsA === undefined || decimalsB === undefined) {
    throw new InvalidAccountError(decimalsA === undefined ? pool.mintA : pool.mintB, 'mint');
  }
  const baseIsA = baseIsTokenA(pool.mintA, pool.mintB, quotePreference);
  const tokenA = { mint: pool.mintA, decimals: decimalsA };
  const tokenB = { mint: pool.mintB, decimals: decimalsB };
  const [tickArrayLower, tickArrayUpper] = await Promise.all([
    tickArrayRef(ref.pool, ref.tickLowerIndex, pool.tickSpacing),
    tickArrayRef(ref.pool, ref.tickUpperIndex, pool.tickSpacing),
  ]);
  return {
    ...ref,
    orientation: { baseIsA, decimalsA, decimalsB },
    pair: baseIsA ? { base: tokenA, quote: tokenB } : { base: tokenB, quote: tokenA },
    tickArrayLower,
    tickArrayUpper,
    tickSpacing: pool.tickSpacing,
  };
}

async function tickArrayRef(
  pool: string,
  tickIndex: number,
  tickSpacing: number,
): Promise<{ readonly address: string; readonly start: number }> {
  const start = getTickArrayStartTickIndex(tickIndex, tickSpacing);
  const [pda] = await getTickArrayAddress(address(pool), start);
  return { address: pda, start };
}

/**
 * One state call for `plans`; every reading gets that call's slot. Positions
 * whose bounds moved since they were planned come back in `moved`, with their
 * new bounds, instead of being read with the wrong ticks.
 */
async function readState(
  port: SolanaReadPort,
  plans: readonly PositionPlan[],
): Promise<{ readings: PositionReading[]; moved: PositionRef[] }> {
  const { slot, accounts } = await getAccountsAligned(
    port,
    plans.flatMap((plan) => [
      plan.address,
      plan.pool,
      plan.tickArrayLower.address,
      plan.tickArrayUpper.address,
    ]),
  );
  const readings: PositionReading[] = [];
  const moved: PositionRef[] = [];
  plans.forEach((plan, i) => {
    const at = i * STATE_ACCOUNTS_PER_POSITION;
    const positionAccount = accounts[at] ?? null;
    if (positionAccount === null) {
      return; // closed between discovery and state: no longer an open position
    }
    if (!isAccountOf(positionAccount, getPositionSize(), POSITION_DISCRIMINATOR)) {
      throw new InvalidAccountError(plan.address, 'Whirlpool position');
    }
    const position = getPositionDecoder().decode(positionAccount.data);
    const { whirlpool } = decodePool(accounts[at + 1] ?? null, plan.pool);
    if (position.liquidity === 0n) {
      readings.push(toUnfundedReading(plan, position, whirlpool, slot));
      return;
    }
    if (
      position.tickLowerIndex !== plan.tickLowerIndex ||
      position.tickUpperIndex !== plan.tickUpperIndex
    ) {
      moved.push({
        address: plan.address,
        pool: plan.pool,
        tickLowerIndex: position.tickLowerIndex,
        tickUpperIndex: position.tickUpperIndex,
      });
      return;
    }
    const tickLower = tickAt(
      accounts[at + 2] ?? null,
      plan,
      plan.tickLowerIndex,
      plan.tickArrayLower,
    );
    const tickUpper = tickAt(
      accounts[at + 3] ?? null,
      plan,
      plan.tickUpperIndex,
      plan.tickArrayUpper,
    );
    readings.push(toReading(plan, position, whirlpool, tickLower, tickUpper, slot));
  });
  return { readings, moved };
}

function toReading(
  plan: PositionPlan,
  position: OrcaPosition,
  whirlpool: Whirlpool,
  tickLower: TickArray['ticks'][number],
  tickUpper: TickArray['ticks'][number],
  slot: bigint,
): PositionReading {
  const o = plan.orientation;
  const amounts = decreaseLiquidityQuote(
    position.liquidity,
    0,
    whirlpool.sqrtPrice,
    position.tickLowerIndex,
    position.tickUpperIndex,
  );
  const fees = collectFeesQuote(whirlpool, position, tickLower, tickUpper);
  return {
    source: { protocol: 'orca-whirlpool', pool: plan.pool, position: plan.address },
    pair: plan.pair,
    position: createPosition(
      toModelLiquidity(position.liquidity, o.decimalsA, o.decimalsB),
      rangeFromTicks(position.tickLowerIndex, position.tickUpperIndex, o),
    ),
    price: priceFromSqrtPrice(whirlpool.sqrtPrice, o),
    amounts: toTokenAmounts(amounts.tokenEstA, amounts.tokenEstB, o),
    feesOwed: toTokenAmounts(fees.feeOwedA, fees.feeOwedB, o),
    feeRate: whirlpool.feeRate / FEE_RATE_DENOMINATOR,
    slot,
  };
}

/**
 * A position with zero liquidity holds no tokens and accrues no fees; what it
 * is owed was settled into its own fields on its last liquidity change, so no
 * tick array is needed (and none may exist).
 */
function toUnfundedReading(
  plan: PositionPlan,
  position: OrcaPosition,
  whirlpool: Whirlpool,
  slot: bigint,
): PositionReading {
  const o = plan.orientation;
  return {
    source: { protocol: 'orca-whirlpool', pool: plan.pool, position: plan.address },
    pair: plan.pair,
    position: createPosition(
      0,
      rangeFromTicks(position.tickLowerIndex, position.tickUpperIndex, o),
    ),
    price: priceFromSqrtPrice(whirlpool.sqrtPrice, o),
    amounts: toTokenAmounts(0n, 0n, o),
    feesOwed: toTokenAmounts(position.feeOwedA, position.feeOwedB, o),
    feeRate: whirlpool.feeRate / FEE_RATE_DENOMINATOR,
    slot,
  };
}

function decodePool(
  account: RawAccount | null,
  expected: string,
): { readonly address: string; readonly whirlpool: Whirlpool } {
  if (account === null || !isAccountOf(account, getWhirlpoolSize(), WHIRLPOOL_DISCRIMINATOR)) {
    throw new InvalidAccountError(expected, 'Whirlpool');
  }
  return { address: account.address, whirlpool: getWhirlpoolDecoder().decode(account.data) };
}

/**
 * The tick at `tickIndex` from its tick array. Uses `decodeTickArray`, which
 * handles both fixed and dynamic tick arrays — `getTickArrayDecoder()` decodes
 * fixed arrays only and would misread a dynamic one.
 */
function tickAt(
  account: RawAccount | null,
  plan: PositionPlan,
  tickIndex: number,
  tickArray: { readonly address: string; readonly start: number },
): TickArray['ticks'][number] {
  if (account?.programAddress !== WHIRLPOOL_PROGRAM_ADDRESS) {
    throw new InvalidAccountError(tickArray.address, 'tick array');
  }
  let decoded: TickArray;
  try {
    decoded = decodeTickArray({
      address: address(account.address),
      data: account.data,
      executable: false,
      lamports: lamports(0n),
      programAddress: address(account.programAddress),
      space: BigInt(account.data.length),
    }).data;
  } catch {
    throw new InvalidAccountError(tickArray.address, 'tick array');
  }
  const tick = decoded.ticks[getTickIndexInArray(tickIndex, tickArray.start, plan.tickSpacing)];
  if (
    decoded.whirlpool !== plan.pool ||
    decoded.startTickIndex !== tickArray.start ||
    tick === undefined
  ) {
    throw new InvalidAccountError(tickArray.address, `tick array of ${plan.pool}`);
  }
  return tick;
}

/** Whether `account` is a Whirlpool position (owner, size and discriminator). */
export function isPositionAccount(account: RawAccount): boolean {
  return isAccountOf(account, getPositionSize(), POSITION_DISCRIMINATOR);
}

function isAccountOf(account: RawAccount, size: number, discriminator: Uint8Array): boolean {
  return (
    account.programAddress === WHIRLPOOL_PROGRAM_ADDRESS &&
    account.data.length === size &&
    discriminator.every((byte, i) => account.data[i] === byte)
  );
}

/**
 * `port.getAccounts`, checked: one entry per requested address, in order, each
 * non-null entry being the account that was asked for. A misaligned response
 * would attach one pool's mint decimals to another — a plausible wrong number.
 */
async function getAccountsAligned(
  port: SolanaReadPort,
  addresses: readonly string[],
): Promise<{ readonly slot: bigint; readonly accounts: readonly (RawAccount | null)[] }> {
  const response = await port.getAccounts(addresses);
  if (
    response.accounts.length !== addresses.length ||
    response.accounts.some((account, i) => account !== null && account.address !== addresses[i])
  ) {
    throw new InvalidAccountError(addresses.join(','), 'response aligned with the request');
  }
  return response;
}

async function getAccountsChunked(
  port: SolanaReadPort,
  addresses: readonly string[],
): Promise<(RawAccount | null)[]> {
  const accounts: (RawAccount | null)[] = [];
  for (let i = 0; i < addresses.length; i += MAX_ACCOUNTS_PER_CALL) {
    const chunk = addresses.slice(i, i + MAX_ACCOUNTS_PER_CALL);
    accounts.push(...(await getAccountsAligned(port, chunk)).accounts);
  }
  return accounts;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}
