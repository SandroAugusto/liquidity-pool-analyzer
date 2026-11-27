/**
 * Persistence format of pool fee snapshots (ADR-0007): one JSON object per
 * line (JSON Lines), version 1.
 *
 * ```json
 * {"v":1,"observedAt":"2026-11-27T03:17:04.000Z","protocol":"orca-whirlpool",
 *  "pool":"…","slot":"123","base":{"mint":"…","decimals":8},
 *  "quote":{"mint":"…","decimals":9},"price":36.9,"liquidity":98.7,
 *  "feeGrowthPerLiquidity":{"base":0.01,"quote":2.05},"feeRate":0.0005}
 * ```
 *
 * Prices are quote per base, amounts token units, `feeRate` a fraction: the
 * fields of {@link PoolReading}. Numbers are written with JavaScript's shortest
 * round-trip representation, so parsing gives back the same doubles. `slot` is
 * a decimal string because it can exceed 2⁵³. `observedAt` is when the reader
 * received the response, not the slot's block time.
 */

import { quotePerBase, tokenAmounts } from '../math/index.js';
import type { PoolReading, Protocol, TokenInfo } from '../positions/index.js';

const VERSION = 1;
const PROTOCOLS: readonly Protocol[] = ['orca-whirlpool'];

/** A snapshot line that does not match the format. */
export class SnapshotFormatError extends Error {
  constructor(reason: string) {
    super(`Invalid fee snapshot: ${reason}`);
    this.name = 'SnapshotFormatError';
  }
}

/** A reading and when it was observed. */
export interface PoolSnapshot {
  readonly observedAt: Date;
  readonly reading: PoolReading;
}

/** One line (without the trailing newline). */
export function formatSnapshotLine({ observedAt, reading: r }: PoolSnapshot): string {
  return JSON.stringify({
    v: VERSION,
    observedAt: observedAt.toISOString(),
    protocol: r.source.protocol,
    pool: r.source.pool,
    slot: r.slot.toString(),
    base: { mint: r.pair.base.mint, decimals: r.pair.base.decimals },
    quote: { mint: r.pair.quote.mint, decimals: r.pair.quote.decimals },
    price: r.price,
    liquidity: r.liquidity,
    feeGrowthPerLiquidity: {
      base: r.feeGrowthPerLiquidity.base,
      quote: r.feeGrowthPerLiquidity.quote,
    },
    feeRate: r.feeRate,
  });
}

/** Parses and validates one line. Throws {@link SnapshotFormatError}. */
export function parseSnapshotLine(line: string): PoolSnapshot {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new SnapshotFormatError('not JSON');
  }
  const o = record(value, 'line');
  if (o.v !== VERSION) {
    throw new SnapshotFormatError(`unsupported version ${String(o.v)}`);
  }
  const observedAt = new Date(text(o.observedAt, 'observedAt'));
  if (Number.isNaN(observedAt.getTime())) {
    throw new SnapshotFormatError('observedAt is not a date');
  }
  const protocol = PROTOCOLS.find((p) => p === o.protocol);
  if (protocol === undefined) {
    throw new SnapshotFormatError(`unknown protocol ${String(o.protocol)}`);
  }
  const slotText = text(o.slot, 'slot');
  if (!/^\d+$/.test(slotText)) {
    throw new SnapshotFormatError('slot is not a decimal integer');
  }
  const growth = record(o.feeGrowthPerLiquidity, 'feeGrowthPerLiquidity');
  const liquidity = finite(o.liquidity, 'liquidity');
  const feeRate = finite(o.feeRate, 'feeRate');
  if (liquidity < 0 || feeRate < 0 || feeRate >= 1) {
    throw new SnapshotFormatError('liquidity or feeRate out of range');
  }
  return {
    observedAt,
    reading: {
      source: { protocol, pool: text(o.pool, 'pool') },
      pair: { base: token(o.base, 'base'), quote: token(o.quote, 'quote') },
      price: guarded(() => quotePerBase(finite(o.price, 'price'))),
      liquidity,
      feeGrowthPerLiquidity: guarded(() =>
        tokenAmounts(finite(growth.base, 'base growth'), finite(growth.quote, 'quote growth')),
      ),
      feeRate,
      slot: BigInt(slotText),
    },
  };
}

/** Parses a whole file: one snapshot per non-empty line, in file order. */
export function parseSnapshotLines(contents: string): PoolSnapshot[] {
  return contents.split('\n').flatMap((line, i) => {
    if (line.trim() === '') {
      return [];
    }
    try {
      return [parseSnapshotLine(line)];
    } catch (error) {
      if (error instanceof SnapshotFormatError) {
        throw new SnapshotFormatError(`line ${String(i + 1)}: ${error.message}`);
      }
      /* c8 ignore next 2 -- parseSnapshotLine throws only SnapshotFormatError */
      throw error;
    }
  });
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new SnapshotFormatError(`${name} is not an object`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, name: string): string {
  if (typeof value !== 'string' || value === '') {
    throw new SnapshotFormatError(`${name} is not a non-empty string`);
  }
  return value;
}

function finite(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new SnapshotFormatError(`${name} is not a finite number`);
  }
  return value;
}

function token(value: unknown, name: string): TokenInfo {
  const o = record(value, name);
  const decimals = o.decimals;
  if (typeof decimals !== 'number' || !Number.isInteger(decimals) || decimals < 0) {
    throw new SnapshotFormatError(`${name}.decimals is not a non-negative integer`);
  }
  return { mint: text(o.mint, `${name}.mint`), decimals };
}

/** Runs a validating constructor, reporting its rejection as a format error. */
function guarded<T>(build: () => T): T {
  try {
    return build();
  } catch (error) {
    throw new SnapshotFormatError(error instanceof Error ? error.message : String(error));
  }
}
