import {
  getInitializableTickIndex,
  priceToSqrtPrice,
  priceToTickIndex,
  sqrtPriceToTickIndex,
} from '@orca-so/whirlpools-core';
import { describe, expect, it } from 'vitest';

import { DEFAULT_RPC_URL, main } from '../../src/cli/positions.js';
import type { CliDeps } from '../../src/cli/positions.js';
import { MINT, SyntheticChain, WALLET } from '../adapters/orca/synthetic-chain.js';

const SPACING = 16;

/** Synthetic WBTC/SOL position, range ≈ 1150–1250; `price` in SOL per WBTC. */
async function chainWithPosition(price = 1200): Promise<SyntheticChain> {
  const chain = new SyntheticChain();
  const sqrtPrice = priceToSqrtPrice(1 / price, 9, 8);
  const pool = chain.addPool({
    mintA: MINT.SOL,
    mintB: MINT.WBTC,
    tickSpacing: SPACING,
    feeRate: 500,
    sqrtPrice,
    tickCurrentIndex: sqrtPriceToTickIndex(sqrtPrice),
  });
  await chain.addPosition(pool, SPACING, {
    liquidity: 4_000_000_000n,
    tickLowerIndex: getInitializableTickIndex(priceToTickIndex(1 / 1250, 9, 8), SPACING, false),
    tickUpperIndex: getInitializableTickIndex(priceToTickIndex(1 / 1150, 9, 8), SPACING, true),
  });
  return chain;
}

function run(
  argv: readonly string[],
  chain: SyntheticChain,
  env: Record<string, string> = {},
): Promise<{ code: number; out: string; err: string; rpcUrls: string[] }> {
  const result = { out: '', err: '', rpcUrls: [] as string[] };
  const deps: CliDeps = {
    env,
    createPort: (url) => {
      result.rpcUrls.push(url);
      return chain.port();
    },
    out: (text) => (result.out += text),
    err: (text) => (result.err += text),
  };
  return main(argv, deps).then((code) => ({ code, ...result }));
}

describe('pnpm positions', () => {
  it('prints the position in SOL per WBTC with range, distances, amounts and fees', async () => {
    const { code, out } = await run([WALLET], await chainWithPosition());

    expect(code).toBe(0);
    expect(out).toContain('WBTC/SOL  fee 0.05 %');
    expect(out).toMatch(/range {5}1149\.\d+ – 1251\.\d+ SOL\/WBTC/);
    expect(out).toMatch(/price {5}1200\.00 SOL\/WBTC {2}in range/);
    expect(out).toMatch(/to lower -4\.\d\d %, to upper \+?4\.\d\d %/);
    expect(out).toMatch(/amounts {3}0\.00\d+ WBTC \+ \d\.\d+ SOL/);
    expect(out).toMatch(/slot {6}\d+/);
  });

  it('flags a position whose price is outside its range', async () => {
    const { out } = await run([WALLET], await chainWithPosition(1300));
    expect(out).toContain('OUT OF RANGE');
  });

  it('says so when there are no positions', async () => {
    const { code, out } = await run([WALLET], new SyntheticChain());
    expect(code).toBe(0);
    expect(out).toBe('No open Orca Whirlpool positions.\n');
  });

  it('uses SOLANA_RPC_URL, else the public endpoint', async () => {
    const chain = await chainWithPosition();
    expect((await run([WALLET], chain)).rpcUrls).toEqual([DEFAULT_RPC_URL]);
    expect((await run([WALLET], chain, { SOLANA_RPC_URL: 'http://local' })).rpcUrls).toEqual([
      'http://local',
    ]);
  });

  it('honours --quote, ahead of the default preference', async () => {
    const { out } = await run([WALLET, '--quote', MINT.WBTC], await chainWithPosition());
    expect(out).toContain('SOL/WBTC  fee');
    expect(out).toMatch(/price {5}0\.000833\d+ WBTC\/SOL/);
  });

  it('asks for --quote when the pair is ambiguous', async () => {
    const chain = new SyntheticChain();
    const pool = chain.addPool({
      mintA: MINT.BONK,
      mintB: MINT.WBTC,
      tickSpacing: SPACING,
      feeRate: 3000,
      sqrtPrice: 1n << 64n,
      tickCurrentIndex: 0,
    });
    await chain.addPosition(pool, SPACING, {
      liquidity: 1n,
      tickLowerIndex: -16,
      tickUpperIndex: 16,
    });

    const { code, err } = await run([WALLET], chain);

    expect(code).toBe(1);
    expect(err).toContain('--quote <mint>');
  });

  it.each([
    [[]],
    [['--quote', 'x']],
    [[WALLET, '--quote']],
    [[WALLET, '--other', 'x']],
    [[WALLET, 'a', 'b', 'c']],
  ])('prints usage and exits 2 for %j', async (argv) => {
    const { code, err } = await run(argv, new SyntheticChain());
    expect(code).toBe(2);
    expect(err).toContain('usage: pnpm positions');
  });

  it('lets unexpected errors through', async () => {
    const chain = await chainWithPosition();
    const port = chain.port();
    const failing = {
      ...port,
      getAccounts: () => Promise.reject(new Error('rpc down')),
    };
    await expect(
      main([WALLET], {
        env: {},
        createPort: () => failing,
        out: () => undefined,
        err: () => undefined,
      }),
    ).rejects.toThrow('rpc down');
  });
});
