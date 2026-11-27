# ADR-0006: Public exchange candles as the research data source

- **Status:** Accepted; the fee-data alternatives below are superseded by ADR-0007
- **Date:** 2026-11-26

## Context

ADR-0005 leaves its empirical claims unvalidated until they are measured on public
data with synthetic positions (AGENTS.md, "No owner position data"). The first of
them, exit times against E[T] (criterion 2), needs long price histories of the pool's
pair at hourly and finer resolution. Pools do not keep such a history on chain, and
reconstructing it from swaps needs an indexer this project does not have.

## Decision

- **Source:** Coinbase Exchange public candles
  (`GET /products/{product}/candles`, no key), BTC-USD and SOL-USD, crossed into SOL
  per BTC. Adapter in `src/adapters/coinbase`: pages of 300 candles, keeps only
  candles inside each page, rejects malformed rows and non-positive closes, and
  returns closes keyed by bucket start. Network access is injected and the adapter is
  tested offline against a fake endpoint.
- **Raw data is never committed.** Downloads are cached in `.cache/` (gitignored); the
  repository holds code and aggregate results only (`docs/research/`). This keeps the
  repository small, sidesteps the question of redistributing a provider's data, and
  keeps the rule simple:
  nothing in a committed file is a price series.
- **Research code lives in `src/research`**, separate from `src/math`: it composes the
  math with data but signs nothing and feeds nothing into `src/math` callers. Coverage
  floor 95 % lines, functions and statements, 90 % branches (ADR-0003); the CLI's
  process wiring is excluded as elsewhere.
- **Results record the run date.** Candles can be revised or missing; the report
  states how many samples were dropped and when the study was run.

## Consequences

- Results are reproducible by anyone with network access, without credentials, but
  can drift slightly between runs if the provider revises data.
- A centralised exchange's price is a proxy for the pool's price. Over minutes the two
  can differ; arbitrage should keep them close over hours, but that is not measured
  here. Claims about very short intervals are weaker for it, and the report says so.
- Pool-specific studies (fees, liquidity by tick) still need a different source.

## Alternatives considered

- **Commit the price series** for exact reproducibility. Rejected: size, the
  provider's terms (not reviewed), and it blurs the "no data files" line drawn for privacy.
- **On-chain swap history** of the pool itself. The right source for fee studies;
  needs an indexer or a paid API. Deferred to criterion 1 of ADR-0005.
- **Other public APIs** (aggregators with daily data only, exchanges that require a
  key). Daily data cannot answer questions about hours; keys add a secret to manage.
