/**
 * `pnpm fee-snapshot`, offline: synthetic WBTC/SOL pools on the real derived
 * addresses (see synthetic-chain.ts for provenance), a fixed clock and an
 * in-memory file.
 */

import { describe, expect, it } from 'vitest';

import { FEE_TIER_INDEXES, whirlpoolAddressesForPair } from '../../src/adapters/orca/index.js';
import type { SolanaReadPort } from '../../src/adapters/orca/index.js';
import { PAIR, main } from '../../src/cli/fee-snapshot.js';
import type { SnapshotDeps } from '../../src/cli/fee-snapshot.js';
import { DEFAULT_RPC_URL } from '../../src/cli/positions.js';
import { parseSnapshotLines } from '../../src/research/fee-snapshots.js';
import { MINT, SyntheticChain } from '../adapters/orca/synthetic-chain.js';

const NOW = new Date('2026-11-27T03:17:00.000Z');

/** Moves the synthetic pool built by `addPool` to a real derived address. */
async function chainWithPoolsOn(tiers: readonly number[]): Promise<SyntheticChain> {
  const chain = new SyntheticChain();
  const addresses = await whirlpoolAddressesForPair(PAIR.WBTC, PAIR.SOL);
  for (const tier of tiers) {
    const made = chain.addPool({
      mintA: MINT.SOL,
      mintB: MINT.WBTC,
      tickSpacing: tier,
      feeRate: tier * 50,
      sqrtPrice: 2n ** 60n,
      tickCurrentIndex: -55452,
      liquidity: 10n ** 12n,
      feeGrowthGlobalA: BigInt(tier) * 2n ** 64n,
    });
    const account = chain.accounts.get(made);
    const target = addresses[FEE_TIER_INDEXES.indexOf(tier)];
    if (account === undefined || target === undefined) {
      throw new Error('setup');
    }
    chain.accounts.delete(made);
    chain.put(target, account.programAddress, account.data);
  }
  return chain;
}

function deps(port: SolanaReadPort, files: Map<string, string>, env = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const urls: string[] = [];
  const d: SnapshotDeps = {
    env,
    createPort: (url) => {
      urls.push(url);
      return port;
    },
    now: () => NOW,
    append: (path, text) => {
      files.set(path, (files.get(path) ?? '') + text);
      return Promise.resolve();
    },
    out: (t) => out.push(t),
    err: (t) => err.push(t),
  };
  return { d, out, err, urls };
}

describe('fee-snapshot', () => {
  it('appends one parseable line per existing pool, all from one slot', async () => {
    const chain = await chainWithPoolsOn([8, 64]);
    const files = new Map<string, string>();
    const { d, out, urls } = deps(chain.port(), files);
    expect(await main(['--out', 'data/2026-11.jsonl'], d)).toBe(0);
    expect(await main(['--out', 'data/2026-11.jsonl'], d)).toBe(0);

    const snapshots = parseSnapshotLines(files.get('data/2026-11.jsonl') ?? '');
    expect(snapshots).toHaveLength(4);
    expect(snapshots.every((s) => s.observedAt.getTime() === NOW.getTime())).toBe(true);
    expect(snapshots.map((s) => s.reading.feeRate)).toEqual([0.0004, 0.0032, 0.0004, 0.0032]);
    expect(snapshots[0]?.reading.slot).toBe(snapshots[1]?.reading.slot);
    expect(snapshots[0]?.reading.pair.base.mint).toBe(PAIR.WBTC);
    expect(out[0]).toMatch(/^2 pools at slot \d+ appended to data\/2026-11\.jsonl\n$/);
    expect(urls).toEqual([DEFAULT_RPC_URL, DEFAULT_RPC_URL]);
  });

  it('uses SOLANA_RPC_URL when set', async () => {
    const chain = await chainWithPoolsOn([8]);
    const { d, urls } = deps(chain.port(), new Map(), { SOLANA_RPC_URL: 'https://rpc.example' });
    expect(await main(['--out', 'x.jsonl'], d)).toBe(0);
    expect(urls).toEqual(['https://rpc.example']);
  });

  it('treats an empty SOLANA_RPC_URL (an unset workflow secret) as unset', async () => {
    const chain = await chainWithPoolsOn([8]);
    const { d, urls } = deps(chain.port(), new Map(), { SOLANA_RPC_URL: '' });
    expect(await main(['--out', 'x.jsonl'], d)).toBe(0);
    expect(urls).toEqual([DEFAULT_RPC_URL]);
  });

  it('writes nothing and fails when no pool exists', async () => {
    const files = new Map<string, string>();
    const { d, err } = deps(new SyntheticChain().port(), files);
    expect(await main(['--out', 'x.jsonl'], d)).toBe(1);
    expect(files.size).toBe(0);
    expect(err.join('')).toMatch(/No WBTC\/SOL Whirlpool found/);
  });

  it.each([[[]], [['--out']], [['--out', '-x']], [['--file', 'x']], [['--out', 'x', 'y']]])(
    'prints usage for %j',
    async (argv) => {
      const { d, err } = deps(new SyntheticChain().port(), new Map());
      expect(await main(argv, d)).toBe(2);
      expect(err.join('')).toMatch(/^usage: pnpm fee-snapshot --out <file.jsonl>/);
    },
  );
});
