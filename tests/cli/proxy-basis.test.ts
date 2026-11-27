/**
 * `pnpm proxy-basis`, offline: a fake candles endpoint with constant prices and
 * synthetic snapshots on public pool addresses.
 */

import { describe, expect, it } from 'vitest';

import { main } from '../../src/cli/proxy-basis.js';
import type { ProxyDeps } from '../../src/cli/proxy-basis.js';
import { quotePerBase, tokenAmounts } from '../../src/math/index.js';
import { formatSnapshotLine } from '../../src/research/fee-snapshots.js';

const DEEP = 'B5EwJVDuAauzUEEdwvbuXzbFFgEYnUqqS37TUM1c4PQA';
const EMPTY = '91wW5NsKVRvqPjapJTNBZSMMKTQ6niL2fvcremxxPn7E';

/** BTC-USD 60,000 and SOL-USD 75: 800 SOL per BTC at every minute. */
function fakeEndpoint(calls: string[]) {
  return (url: string): Promise<unknown> => {
    calls.push(url);
    const parsed = new URL(url);
    const price = parsed.pathname.includes('BTC') ? 60_000 : 75;
    const from = Date.parse(parsed.searchParams.get('start') ?? '') / 1000;
    const to = Date.parse(parsed.searchParams.get('end') ?? '') / 1000;
    const rows: number[][] = [];
    for (let t = to; t >= from; t -= 60) {
      rows.push([t, 0, 0, 0, price, 1]);
    }
    return Promise.resolve(rows);
  };
}

function line(pool: string, observedAt: string, price: number, liquidity: number): string {
  return formatSnapshotLine({
    observedAt: new Date(observedAt),
    reading: {
      source: { protocol: 'orca-whirlpool', pool },
      pair: {
        base: { mint: '3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh', decimals: 8 },
        quote: { mint: 'So11111111111111111111111111111111111111112', decimals: 9 },
      },
      price: quotePerBase(price),
      liquidity,
      feeGrowthPerLiquidity: tokenAmounts(0, 0),
      feeRate: 0.0005,
      slot: 1n,
    },
  });
}

function deps(files: Record<string, string>) {
  const calls: string[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const d: ProxyDeps = {
    get: fakeEndpoint(calls),
    readCache: () => Promise.resolve(null),
    writeCache: () => Promise.resolve(),
    readText: (path) => {
      const contents = files[path];
      return contents === undefined
        ? Promise.reject(new Error(`no file ${path}`))
        : Promise.resolve(contents);
    },
    out: (t) => out.push(t),
    err: (t) => err.push(t),
  };
  return { d, calls, out, err };
}

describe('proxy-basis', () => {
  it('reports the basis per pool and skips pools with no liquidity', async () => {
    const contents = [
      line(DEEP, '2026-11-27T18:17:05Z', 808, 7800),
      line(EMPTY, '2026-11-27T18:17:05Z', 461, 0),
      line(DEEP, '2026-11-27T19:17:05Z', 800, 7900),
      '',
    ].join('\n');
    const { d, calls, out } = deps({ 'a.jsonl': contents });
    expect(await main(['a.jsonl'], d)).toBe(0);
    expect(calls.some((u) => u.includes('BTC-USD'))).toBe(true);
    expect(calls.some((u) => u.includes('SOL-USD'))).toBe(true);
    const report = out.join('');
    expect(report).toContain('3 snapshots; 1 skipped for a pool with no active liquidity');
    expect(report).toContain('0 with no Coinbase minute close');
    // ln(808 / 800) = 0.00995033… → 99.5 bp; ln(800 / 800) = 0. Median (nearest
    // rank of two) is the lower value, the change is −99.5 bp, the reference is flat.
    expect(report).toContain(
      `| \`${DEEP}\` | 0.05 % | 2 | 7.80e+3 | 0.0 | 0.0 to 99.5 | 99.5 | 1 | 99.5 | 0.0 |`,
    );
    expect(report).not.toContain(EMPTY);
  });

  it('refuses no arguments or a flag', async () => {
    for (const argv of [[], ['--snapshots', 'a.jsonl']]) {
      const { d, err } = deps({});
      expect(await main(argv, d)).toBe(2);
      expect(err.join('')).toMatch(/^usage:/);
    }
  });

  it('fails when the files hold no snapshot', async () => {
    const { d, err } = deps({ 'empty.jsonl': '' });
    expect(await main(['empty.jsonl'], d)).toBe(1);
    expect(err.join('')).toContain('No snapshots');
  });
});
