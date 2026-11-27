import { describe, expect, it } from 'vitest';

import { main, parseForecastArgs } from '../../src/cli/exit-time-forecast.js';
import type { StudyDeps } from '../../src/cli/exit-time-study.js';

function fakeEndpoint() {
  const price = (product: string, t: number): number =>
    (product.startsWith('BTC') ? 60_000 : 150) *
    Math.exp(
      0.03 * Math.sin(t / 20_000 + (product.startsWith('BTC') ? 0 : 1.3)) +
        0.01 * Math.sin(t / 3_000),
    );
  return (url: string): Promise<unknown> => {
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
  const out: string[] = [];
  const err: string[] = [];
  const d: StudyDeps = {
    get: fakeEndpoint(),
    readCache: () => Promise.resolve(null),
    writeCache: () => Promise.resolve(),
    out: (t) => out.push(t),
    err: (t) => err.push(t),
  };
  return { d, out, err };
}

describe('parseForecastArgs', () => {
  const base = ['--from', '2026-01-01', '--to', '2026-06-01'];

  it('requires a split inside the period and takes an optional bootstrap count', () => {
    expect(parseForecastArgs([...base, '--split', '2026-03-01'])).toMatchObject({
      splitSeconds: Date.UTC(2026, 2, 1) / 1000,
      boot: 200,
      step: 'hour',
    });
    expect(parseForecastArgs([...base, '--split', '2026-03-01', '--boot', '5'])?.boot).toBe(5);
  });

  it('rejects anything else', () => {
    for (const argv of [
      base,
      [...base, '--split'],
      [...base, '--split', '2026-3-1'],
      [...base, '--split', '2025-12-01'],
      [...base, '--split', '2026-06-01'],
      [...base, '--split', '2026-03-01', '--boot'],
      [...base, '--split', '2026-03-01', '--boot', '0'],
      ['--split', '2026-03-01'],
    ]) {
      expect(parseForecastArgs(argv)).toBeNull();
    }
  });
});

describe('main', () => {
  it('prints usage and returns 2 on bad arguments', async () => {
    const { d, err } = deps();
    expect(await main(['--from', '2026-01-01'], d)).toBe(2);
    expect(err.join('')).toContain('usage: pnpm exit-time-forecast');
  });

  it('prints both directions with every method', async () => {
    const { d, out } = deps();
    expect(
      await main(
        ['--from', '2026-01-01', '--to', '2026-07-01', '--split', '2026-04-01', '--boot', '3'],
        d,
      ),
    ).toBe(0);
    const report = out.join('');
    expect(report).toContain(
      '## Forecasting time in range: SOL per BTC, hour closes, 2026-01-01 to 2026-07-01',
    );
    expect(report).toContain(
      '### Train on positions opened before 2026-03-02, test from 2026-04-01',
    );
    expect(report).toContain(
      '### Train on positions opened from 2026-04-01, test before 2026-03-02',
    );
    for (const name of [
      'Model, 30-day σ',
      'Empirical, 30-day σ',
      'Empirical by regime, 30-day σ',
      'Empirical, blended σ',
    ]) {
      expect(report).toContain(`| ${name} |`);
    }
    expect(report).toContain('(baseline)');
    expect(report).not.toMatch(/\d{3,}\.\d{3,}/);
  });

  it('says so when one side of the split has too few positions', async () => {
    const { d, out } = deps();
    expect(
      await main(
        ['--from', '2026-01-01', '--to', '2026-03-01', '--split', '2026-02-20', '--boot', '2'],
        d,
      ),
    ).toBe(0);
    expect(out.join('')).toContain('Not enough positions on one side of the split.');
  });
});
