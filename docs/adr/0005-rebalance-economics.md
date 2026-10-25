# ADR-0005: Rebalance economics — swap cost, fee constant and breakeven volatility

- **Status:** Proposed
- **Date:** 2026-10-24

## Context

A re-centring strategy compares the fees earned per day with the expected cost of
re-centring on exit. Until now that cost came from `src/math/volatility.ts`:
divergence loss from the centre to the edge, amortised over E[T] = h² / σ², with σ from
a trailing window. Three things were missing or untested:

1. **The swap.** Re-centring after an exit means swapping about half the position.
   The cost was left out without a decision to do so.
2. **The starting point.** A position opened away from the centre exits sooner;
   `expectedDaysToExit` assumes the centre.
3. **A fee model.** A fee rate measured for one position cannot be compared across
   positions of different widths or periods of different volatility.

Model (derivation in `src/math/rebalance.ts`): with L the divergence loss from the
centre to the edge and s the swap cost, the fee-to-cost ratio is
k · hL / (σ · (L + s)), where fees while in range are modelled as k · σ / hL. Because
L ≈ hL / 4 for ranges up to a few tens of percent, with s = 0 the ratio is ≈ 4k / σ:
**the width cancels**, and whether re-centring pays depends on σ against a breakeven
σ\* = k · hL / (L + s).

The empirical parts, whether fees scale as σ / hL and what k is, are **not yet
validated**. They are to be measured on public data only: hourly public prices and
public pool volume and fee data, with synthetic positions (AGENTS.md, "No owner
position data").

## Decision

- Add `src/math/rebalance.ts`:
  - `expectedDaysToExitFrom(price, range, σ)`: ln(P/lower) · ln(upper/P) / σ².
  - `costPerRemount(range, s)` and `remountCostPerDay({ range, sigmaPerDay, swapCostPerRemount })`:
    (L + s) · σ² / hL², with L computed exactly by `divergenceLossToEdgeFromCentre`.
  - `feeToCostRatio(feeRatePerDay, inputs)`, `feeConstant(fee, range, σ)` and
    `breakevenVolatility(k, range, s)` = k · hL / (L + s).
  - All take ranges, not half-widths, so log vs relative half-width cannot be mixed
    up by the caller.
- **The decision variable is σ against σ\***, not price and not width. σ should come
  from a recent window: volatility clusters, so a long trailing average lags.
- **The swap cost is an explicit input.** Order of magnitude: half the position through
  a 0.05 % pool is about 0.025 % of position value, plus slippage.
- `volatility.ts` stays as it is for now. Its `expectedDaysToExit` uses the relative
  half-width (h, not ln(1 + h)), which overstates E[T] by a factor of about 1 + h
  (4 % for h = 4 %).
  Changing a public function's meaning belongs in its own PR; tracked as a follow-up.

## Consequences

- Width only scales the result. A narrower range earns more per day when σ < σ\* and
  loses more per day when σ > σ\*: it is leverage on the volatility regime, not an
  edge. The swap cost is what penalises very narrow ranges (it matters below ≈ 1 %
  half-width).
- k becomes a tracked quantity, and σ\* scales with it: σ\* ≈ 4k for any realistic
  width when the swap is free.
- **Acceptance criteria to move this ADR to Accepted:** on public data and synthetic
  positions, (1) the fee rate while in range is proportional to σ / hL within a stated
  tolerance across volatility regimes, with k estimated with a confidence interval;
  (2) exit times simulated on real hourly price paths match E[T] when σ is taken from
  a recent window, and the lag of a trailing window is quantified.

## Alternatives considered

- **Keep comparing a measured fee rate with a cost, per position.** Correct for one
  position at one time, but it cannot say whether a different width would do better or
  carry the result across regimes. Rejected: it hid the width cancellation.
- **Drift-aware exit time** (E[T] = (h/μ) · tanh(hμ/σ²)). Drift estimates over short
  windows are noisy; deferred until the public-data validation shows whether drift
  matters at the horizons involved.
- **Full exit-time distribution** (survival function) for probabilities rather than
  means. Not needed by any decision rule yet.
