# ADR-0007: Fee growth snapshots of public pools

- **Status:** Proposed
- **Date:** 2026-11-27

## Context

Criterion 1 of [ADR-0005](./0005-rebalance-economics.md) asks whether fees earned in
range scale as σ / hL. [ADR-0006](./0006-public-candles-for-research.md) and the
exit-time report assumed this needs the pool's liquidity by tick over time, from an
indexer or a paid API. It does not.

A concentrated-liquidity pool keeps a cumulative fee growth per unit of liquidity
(`fee_growth_global_{a,b}` on a Whirlpool, as in Uniswap v3). A position's fees are its
liquidity times the growth _inside_ its range, which is the global growth minus the
growth recorded outside its two ticks. The outside figures change only when the price
crosses those ticks. So while the price stays inside a range, its fees per unit of
liquidity equal the change in the **global** figure, and the value of a centred
position per unit of liquidity has a closed form, 2√P · (1 − e^(−hL/2)). Fee return
per unit of value for any synthetic centred position follows from two snapshots of
one pool account, read for free from a public RPC.

What a pool account does not keep is its history. Snapshots have to be taken from now
on.

## Decision

- **Reader.** `readPools` (`src/adapters/orca/read-pools.ts`) reads Whirlpools in one
  `getAccounts` call (one slot) and returns protocol-neutral `PoolReading`s
  (`src/positions/pool.ts`): price quote per base, active liquidity and cumulative fee
  growth per unit of **model** liquidity in token units, fee rate as a fraction, slot.
  Raw on-chain integers stay inside the adapter, as for positions (ADR-0004).
- **Which pools.** Every WBTC/SOL Whirlpool on Orca's public fee tiers, derived as
  PDAs (`whirlpoolAddressesForPair`), not a hand-picked address. The collection is of
  the pair, not of any one pool, and has nothing to do with any wallet or position.
- **Cadence.** Hourly, by `.github/workflows/fee-snapshots.yml` at minute 17, three
  attempts 30 s apart. The public mainnet endpoint is the default; a `SOLANA_RPC_URL`
  repository secret, if set, replaces it. A missed hour is a gap, not an error:
  analysis works on consecutive readings, whatever their spacing.
- **Format.** JSON Lines, one object per pool per run, version 1
  (`src/research/fee-snapshots.ts`): the fields of `PoolReading` plus `observedAt`;
  doubles in JavaScript's shortest round-trip form, `slot` as a decimal string.
  Parsing validates every field through the math constructors and refuses anything
  else with `SnapshotFormatError`.
- **Where the data live.** Monthly files `fee-growth/YYYY-MM.jsonl` on an orphan
  branch, `data/fee-growth`, committed by `github-actions[bot]`. `main` keeps the rule
  of ADR-0006: no committed file on `main` is a data series. These snapshots are the
  project's own readings of public protocol accounts, not a provider's data, so the
  redistribution concern of ADR-0006 does not apply. Size: about 220 bytes per pool
  per hour, so with ten pools about 20 MB a year before git compression.
- **Analysis.** `src/research/fee-growth.ts`: `feesPerLiquidityBetween` (refuses
  fee growth that decreases, readings of different pools, or slots out of order) and
  `feeReturnUntilExit` (opens a synthetic centred position on a reading and accumulates
  fees until a reading at or beyond a bound).

## Consequences

- Criterion 1 can be measured on data collected by the project, at no cost. The
  first answer needs weeks of snapshots: hourly fee increments are noisy, and
  regimes of σ need time to occur.
- Readings are seen hourly, so an exit and return between two snapshots is missed
  (fees overstated for that hour: the global growth includes swaps while the price was
  outside) and the hour in which an exit is seen is not counted (understated). The
  same discrete-monitoring bias as the exit-time study, in both directions.
- The position's own liquidity is assumed not to change the pool's. For large
  positions relative to the pool's active liquidity, fees per unit of liquidity would
  be lower than measured.
- `feeRate` is the base fee. For adaptive-fee pools it is not what was charged, but fee
  growth is what was actually earned, so the fee study does not depend on it.
- Scheduled workflows run only from the default branch, so collection starts when this
  is merged. GitHub may disable scheduled workflows in public repositories after a
  period without activity; whether commits to a non-default branch count was not
  checked. If collection stops, the gap shows in the data.
- A backfill from public pool volume (for example GeckoTerminal's free OHLCV, which
  covers recent months) is possible but approximate: it lacks the active liquidity
  that converts volume into fees per unit of liquidity. It can be calibrated against
  these snapshots once they overlap. Not part of this decision.

## Alternatives considered

- **Liquidity by tick over time from an indexer or archive RPC.** Not needed for
  centred synthetic positions, as above; and the free tiers that once offered SQL over
  Solana history are now trial-only.
- **Rebuilding history from every swap transaction.** Possible from the public RPC's
  transaction history, but slow, and it re-implements the program's fee accounting —
  the kind of code where a plausible wrong number hides. Deferred.
- **Snapshots as workflow artifacts.** No commits, but artifacts expire, and a series
  that disappears after months defeats the purpose.
- **Snapshots on `main`.** Hourly bot commits would bury the code history and break the
  rule of ADR-0006 for no gain.
- **Raw on-chain integers in the snapshot.** Exact, but protocol-specific (Uniswap v3
  uses Q128.128); the neutral reading in doubles carries relative errors around 10⁻¹⁶,
  far below the hourly fee increments it is used to difference.
