# liquidity-pool-analyzer

Decision-support tooling for concentrated-liquidity (CLMM) positions.

Most LP dashboards show an APR. This project is built to answer the questions the APR
hides. Where each one stands today:

| Question                                    | What answering it takes                                                                                                                                                              | Status                                                                                                                                                                                                                                                       |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Am I beating hold?**                      | Position value plus collected fees against simply holding the deposited tokens, in the pool's own price ratio, not in USD, so that market beta is not mistaken for pool performance. | Math done and tested; read-only position reader exists. No report yet.                                                                                                                                                                                       |
| **What is this range actually costing me?** | Divergence loss per re-centre cycle, amortised over the expected time in range.                                                                                                      | Divergence math done. Expected time in range: **the model is not reliable as a forecast** ([exit-time study](./docs/research/exit-time.md)); empirical quantiles are close to calibrated at ±1 % to ±4 %. Fees in range: data collection started 2026-11-27. |
| **Should I act?**                           | Explicit, testable rules for when to wait, re-centre or exit, and a record of how they performed.                                                                                    | Not started.                                                                                                                                                                                                                                                 |

The project is developed for Orca (Solana), with Uniswap v3 (Base) planned as the second
integration. Position and pool readings are validated against on-chain state; the
exit-time research runs on public Coinbase prices, and how far it transfers to a pool is
checked separately against the project's own pool snapshots.

## Status

Early. The math core (`src/math`) is implemented and tested against independently
computed expectations and public market data. A read-only Orca Whirlpool position
reader exists (`pnpm positions`,
[ADR-0004](./docs/adr/0004-orca-sdk-and-adapter-boundary.md)); it is tested offline
against synthetic chain state.
A first study of exit times on public prices with synthetic positions is in
[`docs/research/exit-time.md`](./docs/research/exit-time.md)
([ADR-0006](./docs/adr/0006-public-candles-for-research.md)): the model's expected
time in range is not yet reliable as a forecast.
Hourly fee snapshots of the public WBTC/SOL pools are collected for the fee study
([ADR-0007](./docs/adr/0007-fee-growth-snapshots.md)).
Persistence, alerts and the rule engine are not yet started.
See [`JOURNAL.md`](./JOURNAL.md) for the running log and
[`docs/adr`](./docs/adr) for design decisions.

## What this is not

- Not a trading bot. Nothing here signs transactions.
- Not a yield aggregator or a pool ranking. Pool-wide APR is an input, not an output.
- Not financial advice. The rules are hypotheses under test.

## Development

Requires Node ≥ 22 and pnpm ≥ 10 (`corepack enable`).

```sh
pnpm install
pnpm check          # typecheck + lint + format check + tests
pnpm test:watch

pnpm positions <wallet> [--quote <mint>]   # read-only; RPC from SOLANA_RPC_URL
pnpm record-fixture <wallet> <name>        # sanitised test fixture, no wallet stored
pnpm exit-time-study --from 2024-11-01 --to 2026-11-01 [--step minute]   # public prices
pnpm exit-time-diagnostics --from 2024-11-01 --to 2026-11-01 [--seeds 20]  # what explains it
pnpm exit-time-forecast --from 2024-11-01 --to 2026-11-01 --split 2025-11-01  # out-of-sample forecasts
```

All changes go through pull requests; `main` is protected. See
[`CONTRIBUTING.md`](./CONTRIBUTING.md).

## Conventions

- Prices are **quote per base** (e.g. SOL per WBTC in a WBTC/SOL pool) and carry the
  branded type `QuotePerBase`; obtain one with `quotePerBase(value)`. Ranges, positions
  and token amounts are built through `createRange`, `createPosition` and
  `tokenAmounts`, which validate once. Calculation functions trust the types.
- Fractions are plain numbers (`0.05` means 5 %), never percentages.
- The math is the continuous CLMM model; tick quantisation is ignored on purpose
  ([ADR-0002](./docs/adr/0002-continuous-float-model.md)).

## License

MIT
