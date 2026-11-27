import { describe, expect, it } from 'vitest';

import { main, parseArgs } from '../../src/cli/exit-time-study.js';
import type { StudyDeps } from '../../src/cli/exit-time-study.js';

/** A deterministic pseudo-random walk per product, served like the candles endpoint. */
function fakeEndpoint(calls: string[]) {
  const price = (product: string, t: number): number => {
    const phase = product.startsWith('BTC') ? 0 : 1.3;
    return (
      (product.startsWith('BTC') ? 60_000 : 150) * Math.exp(0.03 * Math.sin(t / 20_000 + phase))
    );
  };
  return (url: string): Promise<unknown> => {
    calls.push(url);
    const parsed = new URL(url);
    const product = parsed.pathname.split('/')[2] ?? '';
    const step = Number(parsed.searchParams.get('granularity'));
    const from = Date.parse(parsed.searchParams.get('start') ?? '') / 1000;
    const to = Date.parse(parsed.searchParams.get('end') ?? '') / 1000;
    const rows: number[][] = [];
    for (let t = to; t >= from; t -= step) {
      rows.push([t, 0, 0, 0, price(product, t), 1]);
    }
    return Promise.resolve(rows);
  };
}

function deps() {
  const calls: string[] = [];
  const cache = new Map<string, string>();
  const out: string[] = [];
  const err: string[] = [];
  const d: StudyDeps = {
    get: fakeEndpoint(calls),
    readCache: (key) => Promise.resolve(cache.get(key) ?? null),
    writeCache: (key, contents) => {
      cache.set(key, contents);
      return Promise.resolve();
    },
    out: (t) => out.push(t),
    err: (t) => err.push(t),
  };
  return { d, calls, cache, out, err };
}

describe('parseArgs', () => {
  it('accepts dates and an optional step', () => {
    expect(parseArgs(['--from', '2026-01-01', '--to', '2026-01-02'])).toEqual({
      fromSeconds: Date.UTC(2026, 0, 1) / 1000,
      toSeconds: Date.UTC(2026, 0, 2) / 1000,
      step: 'hour',
    });
    expect(
      parseArgs(['--from', '2026-01-01', '--to', '2026-01-02', '--step', 'minute'])?.step,
    ).toBe('minute');
  });

  it('rejects anything else', () => {
    for (const argv of [
      [],
      ['--from', '2026-01-01'],
      ['--from', '2026-01-02', '--to', '2026-01-01'],
      ['--from', '2026-1-1', '--to', '2026-01-02'],
      ['--from', '2026-02-30', '--to', '2026-03-02'],
      ['--from', '2026-01-01', '--to', '2026-01-02', '--step', 'day'],
      ['--from', '2026-01-01', '--to', '2026-01-02', '--other', 'x'],
      ['--from', '2026-01-01', '--from', '2026-01-01', '--to', '2026-01-02'],
      ['from', '2026-01-01', '--to', '2026-01-02'],
    ]) {
      expect(parseArgs(argv)).toBeNull();
    }
  });
});

describe('main', () => {
  it('prints usage and returns 2 on bad arguments', async () => {
    const { d, err, calls } = deps();
    expect(await main(['--bogus'], d)).toBe(2);
    expect(err.join('')).toContain('usage:');
    expect(calls).toHaveLength(0);
  });

  it('fetches, caches and prints aggregate tables only', async () => {
    const { d, calls, cache, out } = deps();
    const argv = ['--from', '2026-01-01', '--to', '2026-03-01'];
    expect(await main(argv, d)).toBe(0);
    const report = out.join('');
    expect(report).toContain('## SOL per BTC, hour closes, 2026-01-01 to 2026-03-01');
    expect(report).toContain(
      '1416 samples; 0 times dropped because one product had no candle, and 0 with no candle for either',
    );
    expect(report).toContain('### σ from the 30 daily closes before opening');
    expect(report).toContain('### σ from the 7 days of samples before opening');
    for (const width of ['±1 %', '±2 %', '±4 %', '±8 %']) {
      expect(report).toContain(`| ${width} |`);
    }
    expect(report).toContain('model 0.757');
    // Aggregates only: no price level from the series appears in the report.
    expect(report).not.toMatch(/\d{3,}\.\d{3,}/);
    expect(cache.size).toBe(2);

    const fetchedOnce = calls.length;
    const second = deps();
    second.d = {
      ...second.d,
      readCache: d.readCache,
      get: () => Promise.reject(new Error('cached')),
    };
    expect(await main(argv, second.d)).toBe(0);
    expect(second.out.join('')).toBe(report);
    expect(fetchedOnce).toBeGreaterThan(0);
  });

  it('uses one-minute candles for --step minute', async () => {
    const { d, calls } = deps();
    expect(await main(['--from', '2026-01-01', '--to', '2026-01-02', '--step', 'minute'], d)).toBe(
      0,
    );
    expect(calls.every((u) => u.includes('granularity=60&'))).toBe(true);
  });
});
