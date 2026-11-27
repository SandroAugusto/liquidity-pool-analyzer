// Public surface of the Coinbase adapter: public market candles only (ADR-0006).
export {
  CandleFormatError,
  COINBASE_EXCHANGE_URL,
  GRANULARITIES_SECONDS,
  fetchCloses,
} from './candles.js';
export type { CandleRequest, GranularitySeconds, HttpGetJson } from './candles.js';
