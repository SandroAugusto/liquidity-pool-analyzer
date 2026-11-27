/**
 * Snapshot persistence format (ADR-0007). Values are synthetic; the round trip
 * must give back the exact doubles and the exact slot.
 */

import { describe, expect, it } from 'vitest';

import { quotePerBase, tokenAmounts } from '../../src/math/index.js';
import type { PoolReading } from '../../src/positions/index.js';
import {
  SnapshotFormatError,
  formatSnapshotLine,
  parseSnapshotLine,
  parseSnapshotLines,
} from '../../src/research/fee-snapshots.js';

const READING: PoolReading = {
  source: { protocol: 'orca-whirlpool', pool: 'B5EwJVDuAauzUEEdwvbuXzbFFgEYnUqqS37TUM1c4PQA' },
  pair: {
    base: { mint: '3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh', decimals: 8 },
    quote: { mint: 'So11111111111111111111111111111111111111112', decimals: 9 },
  },
  price: quotePerBase(846.2007319872413),
  liquidity: 9702.979314159265,
  feeGrowthPerLiquidity: tokenAmounts(0.003894774370495485, 2.0475355419736387),
  feeRate: 0.0005,
  // Above 2⁵³: must survive as a string.
  slot: 9007199254740993n,
};
const OBSERVED = new Date('2026-11-27T03:17:04.123Z');

function line(over: Record<string, unknown>): string {
  return JSON.stringify({
    ...(JSON.parse(formatSnapshotLine({ observedAt: OBSERVED, reading: READING })) as object),
    ...over,
  });
}

describe('snapshot lines', () => {
  it('round-trip exactly, slot included', () => {
    const text = formatSnapshotLine({ observedAt: OBSERVED, reading: READING });
    expect(text).not.toContain('\n');
    const parsed = parseSnapshotLine(text);
    expect(parsed.observedAt.toISOString()).toBe(OBSERVED.toISOString());
    expect(parsed.reading).toEqual(READING);
    expect(parsed.reading.slot).toBe(9007199254740993n);
  });

  it('write the documented field names and version', () => {
    expect(Object.keys(JSON.parse(line({})) as object)).toEqual([
      'v',
      'observedAt',
      'protocol',
      'pool',
      'slot',
      'base',
      'quote',
      'price',
      'liquidity',
      'feeGrowthPerLiquidity',
      'feeRate',
    ]);
    expect(line({})).toContain('"v":1');
    expect(line({})).toContain('"slot":"9007199254740993"');
  });

  it.each([
    ['not JSON', '{', /not JSON/],
    ['an array', '[]', /line is not an object/],
    ['another version', line({ v: 2 }), /unsupported version 2/],
    ['a bad date', line({ observedAt: 'yesterday' }), /observedAt is not a date/],
    ['a missing date', line({ observedAt: undefined }), /observedAt is not a non-empty string/],
    ['an unknown protocol', line({ protocol: 'uniswap-v3' }), /unknown protocol/],
    ['a numeric slot', line({ slot: 5 }), /slot is not a non-empty string/],
    ['a negative slot', line({ slot: '-5' }), /slot is not a decimal integer/],
    ['an empty pool', line({ pool: '' }), /pool is not/],
    ['a zero price', line({ price: 0 }), /price/i],
    ['a string price', line({ price: '846' }), /price is not a finite number/],
    ['negative liquidity', line({ liquidity: -1 }), /out of range/],
    ['a percentage fee', line({ feeRate: 5 }), /out of range/],
    [
      'negative fee growth',
      line({ feeGrowthPerLiquidity: { base: -1, quote: 0 } }),
      SnapshotFormatError,
    ],
    ['missing fee growth', line({ feeGrowthPerLiquidity: null }), /feeGrowthPerLiquidity/],
    [
      'fractional decimals',
      line({ base: { mint: 'x', decimals: 8.5 } }),
      /base.decimals is not a non-negative integer/,
    ],
    ['a missing mint', line({ quote: { decimals: 9 } }), /quote.mint/],
  ])('refuse %s', (_name, text, error) => {
    expect(() => parseSnapshotLine(text)).toThrow(error);
  });

  it('refuse with SnapshotFormatError, never a raw constructor error', () => {
    expect(() => parseSnapshotLine(line({ price: -3 }))).toThrow(SnapshotFormatError);
  });
});

describe('parseSnapshotLines', () => {
  it('parses non-empty lines in order', () => {
    const second = { ...READING, slot: READING.slot + 1n };
    const contents = [
      formatSnapshotLine({ observedAt: OBSERVED, reading: READING }),
      '',
      formatSnapshotLine({ observedAt: OBSERVED, reading: second }),
      '',
    ].join('\n');
    expect(parseSnapshotLines(contents).map((s) => s.reading.slot)).toEqual([
      READING.slot,
      READING.slot + 1n,
    ]);
  });

  it('names the line of a bad snapshot', () => {
    const contents = `${line({})}\n${line({ v: 0 })}\n`;
    expect(() => parseSnapshotLines(contents)).toThrow(/line 2: .*unsupported version 0/);
  });
});
