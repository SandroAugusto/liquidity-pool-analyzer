import { describe, expect, it } from 'vitest';

import { main, parseDiagnosticsArgs } from '../../src/cli/exit-time-diagnostics.js';
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

describe('parseDiagnosticsArgs', () => {
  it('adds an optional seed count to the study arguments', () => {
    expect(parseDiagnosticsArgs(['--from', '2026-01-01', '--to', '2026-01-02'])?.seeds).toBe(20);
    expect(
      parseDiagnosticsArgs(['--seeds', '3', '--from', '2026-01-01', '--to', '2026-01-02'])?.seeds,
    ).toBe(3);
  });

  it('rejects a bad seed count or bad study arguments', () => {
    for (const argv of [
      ['--from', '2026-01-01', '--to', '2026-01-02', '--seeds'],
      ['--from', '2026-01-01', '--to', '2026-01-02', '--seeds', '0'],
      ['--from', '2026-01-01', '--to', '2026-01-02', '--seeds', '1000'],
      ['--from', '2026-01-01', '--to', '2026-01-02', '--seeds', 'x'],
      ['--seeds', '2'],
    ]) {
      expect(parseDiagnosticsArgs(argv)).toBeNull();
    }
  });
});

describe('main', () => {
  it('prints usage and returns 2 on bad arguments', async () => {
    const { d, err } = deps();
    expect(await main(['--seeds', '0'], d)).toBe(2);
    expect(err.join('')).toContain('usage: pnpm exit-time-diagnostics');
  });

  it('prints the four diagnostic tables', async () => {
    const { d, out } = deps();
    expect(await main(['--from', '2026-01-01', '--to', '2026-03-15', '--seeds', '2'], d)).toBe(0);
    const report = out.join('');
    for (const heading of [
      '## Diagnostics: SOL per BTC, hour closes, 2026-01-01 to 2026-03-15',
      '### Variance ratio by horizon (one step = 1 hour)',
      '### Median T / E[T] on surrogate paths',
      '| Signs randomised (keeps clustering), own σ |',
      '| Returns shuffled (keeps fat tails only), own σ |',
      '| Gaussian walk (the model), own σ |',
      '| Signs randomised (keeps clustering), actual σ |',
      '### Tails at ±8 %',
      '| Gaussian walk |',
      '| Signs randomised |',
      'Net log change over the period',
      '### 7-day and 30-day σ on the same',
      '### Trailing σ against the σ of the next 7 days',
      '| After a fall (7-day σ < 0.8 × 30-day) |',
    ]) {
      expect(report).toContain(heading);
    }
    expect(report).toContain('over 2 seeds');
    expect(report).not.toMatch(/\d{3,}\.\d{3,}/);
  });

  it('uses minute horizons for --step minute', async () => {
    const { d, out } = deps();
    expect(
      await main(
        ['--from', '2026-01-01', '--to', '2026-01-03', '--step', 'minute', '--seeds', '1'],
        d,
      ),
    ).toBe(0);
    expect(out.join('')).toContain('| 5 min | 15 min | 1 h | 4 h | 1 d |');
  });
});
