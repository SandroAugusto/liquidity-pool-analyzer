import { describe, expect, it } from 'vitest';

import { CandleFormatError, fetchCloses } from '../../../src/adapters/coinbase/index.js';
import type { CandleRequest } from '../../../src/adapters/coinbase/index.js';

const HOUR = 3600;
const START = 1_700_000_000 - (1_700_000_000 % HOUR);

/** Fake endpoint: serves candles for every bucket in the requested [start, end]. */
function fakeGet(close: (t: number) => number, calls: string[] = []) {
  return (url: string): Promise<unknown> => {
    calls.push(url);
    const params = new URL(url).searchParams;
    const step = Number(params.get('granularity'));
    const from = Date.parse(params.get('start') ?? '') / 1000;
    const to = Date.parse(params.get('end') ?? '') / 1000;
    const rows: number[][] = [];
    for (let t = to; t >= from; t -= step) {
      rows.push([t, 0, 0, 0, close(t), 1]);
    }
    return Promise.resolve(rows);
  };
}

const request: CandleRequest = {
  product: 'BTC-USD',
  granularitySeconds: 3600,
  startSeconds: START,
  endSeconds: START + 700 * HOUR,
};

describe('fetchCloses', () => {
  it('pages through the range in 300-candle requests and keeps every bucket once', async () => {
    const calls: string[] = [];
    const closes = await fetchCloses(
      request,
      fakeGet((t) => t / 1e6, calls),
    );
    expect(calls).toHaveLength(3);
    expect(closes.size).toBe(700);
    expect(closes.get(START)).toBe(START / 1e6);
    expect(closes.get(START + 699 * HOUR)).toBe((START + 699 * HOUR) / 1e6);
    expect(closes.has(START + 700 * HOUR)).toBe(false);
    expect(calls[0]).toContain('/products/BTC-USD/candles?granularity=3600');
  });

  it('drops candles the endpoint returns outside the requested page', async () => {
    const get = (): Promise<unknown> =>
      Promise.resolve([
        [START - HOUR, 0, 0, 0, 1, 1],
        [START, 0, 0, 0, 2, 1],
      ]);
    const closes = await fetchCloses({ ...request, endSeconds: START + HOUR }, get);
    expect([...closes]).toEqual([[START, 2]]);
  });

  it('rejects malformed responses', async () => {
    const one = { ...request, endSeconds: START + HOUR };
    for (const body of [
      {},
      [[START]],
      [['x', 0, 0, 0, 1]],
      [[START, 0, 0, 0, 0]],
      [[START, 0, 0, 0, Number.NaN]],
    ]) {
      await expect(fetchCloses(one, () => Promise.resolve(body))).rejects.toThrow(
        CandleFormatError,
      );
    }
  });

  it('rejects invalid requests before any call', async () => {
    const get = (): Promise<unknown> => Promise.reject(new Error('must not call'));
    const bad: CandleRequest[] = [
      { ...request, product: 'btc usd' },
      { ...request, granularitySeconds: 120 as CandleRequest['granularitySeconds'] },
      { ...request, startSeconds: START + 1 },
      { ...request, endSeconds: START },
      { ...request, startSeconds: -HOUR },
    ];
    for (const r of bad) {
      await expect(fetchCloses(r, get)).rejects.toThrow(RangeError);
    }
  });
});
