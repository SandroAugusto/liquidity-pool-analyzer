/**
 * Read-only client for Coinbase Exchange public candles
 * (`GET /products/{product}/candles`). No authentication, no account data:
 * only public market prices, used for research (ADR-0006).
 *
 * The endpoint returns at most 300 candles per request, newest first, as
 * `[time, low, high, open, close, volume]` with `time` in epoch seconds at the
 * start of the bucket. This module pages through a time range and returns the
 * **close** of each bucket, keyed by bucket start.
 */

export const COINBASE_EXCHANGE_URL = 'https://api.exchange.coinbase.com';
const MAX_CANDLES_PER_REQUEST = 300;

/** Bucket sizes the endpoint accepts, in seconds. */
export const GRANULARITIES_SECONDS = [60, 300, 900, 3600, 21600, 86400] as const;
export type GranularitySeconds = (typeof GRANULARITIES_SECONDS)[number];

/** The HTTP call, injected so the client is testable offline. */
export type HttpGetJson = (url: string) => Promise<unknown>;

export interface CandleRequest {
  /** Coinbase product id, e.g. `BTC-USD`. Price is quote currency per base. */
  readonly product: string;
  readonly granularitySeconds: GranularitySeconds;
  /** Inclusive start, epoch seconds, aligned to the granularity. */
  readonly startSeconds: number;
  /** Exclusive end, epoch seconds, aligned to the granularity. */
  readonly endSeconds: number;
}

export class CandleFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CandleFormatError';
  }
}

function validateRequest(request: CandleRequest): void {
  const { product, granularitySeconds, startSeconds, endSeconds } = request;
  if (!/^[A-Z0-9]+-[A-Z0-9]+$/.test(product)) {
    throw new RangeError(`product must look like BASE-QUOTE, got ${JSON.stringify(product)}`);
  }
  if (!(GRANULARITIES_SECONDS as readonly number[]).includes(granularitySeconds)) {
    throw new RangeError(`unsupported granularity ${String(granularitySeconds)}`);
  }
  for (const [name, value] of [
    ['startSeconds', startSeconds],
    ['endSeconds', endSeconds],
  ] as const) {
    if (!Number.isInteger(value) || value < 0 || value % granularitySeconds !== 0) {
      throw new RangeError(
        `${name} must be a non-negative multiple of the granularity, got ${String(value)}`,
      );
    }
  }
  if (endSeconds <= startSeconds) {
    throw new RangeError(`endSeconds must be after startSeconds`);
  }
}

function parseRows(body: unknown, url: string): [number, number][] {
  if (!Array.isArray(body)) {
    throw new CandleFormatError(`expected an array of candles from ${url}`);
  }
  return body.map((row: unknown) => {
    if (!Array.isArray(row) || row.length < 5) {
      throw new CandleFormatError(`malformed candle from ${url}: ${JSON.stringify(row)}`);
    }
    const time: unknown = row[0];
    const close: unknown = row[4];
    if (typeof time !== 'number' || !Number.isInteger(time) || typeof close !== 'number') {
      throw new CandleFormatError(`malformed candle from ${url}: ${JSON.stringify(row)}`);
    }
    if (!Number.isFinite(close) || close <= 0) {
      throw new CandleFormatError(`non-positive close from ${url}: ${JSON.stringify(row)}`);
    }
    return [time, close];
  });
}

/**
 * Closes for every bucket in `[startSeconds, endSeconds)` that Coinbase
 * returned. Buckets with no trades are absent from the response and from the
 * result; callers decide how to treat gaps. Requests are issued sequentially.
 */
export async function fetchCloses(
  request: CandleRequest,
  get: HttpGetJson,
): Promise<Map<number, number>> {
  validateRequest(request);
  const { product, granularitySeconds, startSeconds, endSeconds } = request;
  const closes = new Map<number, number>();
  const pageSeconds = granularitySeconds * MAX_CANDLES_PER_REQUEST;
  for (let from = startSeconds; from < endSeconds; from += pageSeconds) {
    const to = Math.min(from + pageSeconds, endSeconds);
    // The endpoint's `end` is inclusive; ask for the last bucket start of the page.
    const params = new URLSearchParams({
      granularity: String(granularitySeconds),
      start: new Date(from * 1000).toISOString(),
      end: new Date((to - granularitySeconds) * 1000).toISOString(),
    });
    const url = `${COINBASE_EXCHANGE_URL}/products/${product}/candles?${params.toString()}`;
    for (const [time, close] of parseRows(await get(url), url)) {
      if (time >= from && time < to) {
        closes.set(time, close);
      }
    }
  }
  return closes;
}
