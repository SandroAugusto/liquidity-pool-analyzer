# ADR-0002: Continuous CLMM model in floating point

- **Status:** Accepted
- **Date:** 2026-10-23

## Context

Real CLMMs quantise price into ticks (Orca: `tickSpacing` per pool) and store
`sqrt(price)` as a Q64.64 fixed-point integer. Token amounts are integers in base
units. An exact replica of on-chain arithmetic requires `bigint` and tick-aware
formulas.

This project's purpose is **analysis and decision support**: value vs. hold, divergence
loss, range sizing, signals. It does not construct transactions.

## Decision

`src/math` implements the continuous model (`quote = L·(√P − √Pa)`,
`base = L·(1/√P − 1/√Pb)`) using JavaScript `number` (float64), with prices as plain
decimals in quote-per-base.

Tick quantisation is ignored.

## Consequences

- Simple, readable formulas that match the literature; easy to test and to explain.
- Relative error from ignoring ticks is on the order of the tick spacing (basis
  points), far below the uncertainty in any decision this project supports.
- **This module must never be used to compute amounts for a transaction.** Any
  future write-path (ADR to come) must use the protocol SDK's own math.
- Float64 has ~15–16 significant digits. Position values here are in the range of
  10⁻³ to 10⁶ in token units; precision is not a practical concern. If it ever is,
  the module boundary makes a swap to a decimal library contained.

## Alternatives considered

- **Bigint fixed-point mirroring the on-chain program.** Exact, but verbose, harder
  to review, and solves a problem (transaction construction) this project does not
  have yet. Deferred until a write-path exists.
- **Reuse the SDK's math for analysis.** Couples the analysis core to a specific
  protocol SDK and its dependency graph; defeats the goal of a protocol-agnostic
  core with thin adapters.
