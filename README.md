# liquidity-pool-analyzer

Decision-support tooling for concentrated-liquidity (CLMM) positions.

Most LP dashboards show an APR. This project answers the questions the APR hides:

- **Am I beating hold?** Position value plus collected fees, measured against simply
  holding the deposited tokens — in the pool's own price ratio, not in USD, so that
  market beta is not mistaken for pool performance.
- **What is this range actually costing me?** Divergence loss per re-centre cycle,
  amortised over the expected time in range given the pair's realised volatility.
- **Should I act?** Explicit, testable rules for when to wait, re-centre or exit —
  and a record of how those rules performed.

The project is developed for Orca (Solana), with Uniswap v3
(Base) planned as the second integration. Everything here is validated against
on-chain state before it is trusted.

## Status

Early. The math core (`src/math`) is implemented and tested against independently
computed expectations and public market data. On-chain readers, persistence, alerts and the rule engine are not yet started.
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
```

All changes go through pull requests; `main` is protected. See
[`CONTRIBUTING.md`](./CONTRIBUTING.md).

## Conventions

- Prices are **quote per base** (e.g. SOL per WBTC in a WBTC/SOL pool).
- Fractions are plain numbers (`0.05` means 5 %), never percentages.
- The math is the continuous CLMM model; tick quantisation is ignored on purpose
  ([ADR-0002](./docs/adr/0002-continuous-float-model.md)).

## License

MIT
