# ADR-0003: Coverage policy — per-directory floors

- **Status:** Accepted
- **Date:** 2026-10-24

## Context

`vitest.config.ts` enforced one global threshold, 90/90/85/90
(lines/functions/branches/statements). `CONTRIBUTING.md` requires an ADR to lower a
threshold. Issue #4 asked for per-directory floors before the first on-chain adapter
lands (#5).

Coverage measures executed lines, not verified behaviour. A single global figure is
an average: a well-tested directory can hide an untested one, and a directory whose
code is genuinely hard to unit-test pushes everyone towards tests that only execute
lines.

Two facts shaped the decision:

1. **Vitest counts glob-matched files towards the global threshold too** (checked in
   the installed `vitest` 3.2.7, `resolveThresholds`: "Global threshold is for all
   files, even if they are included by glob patterns"). A global threshold higher
   than a per-directory floor therefore overrides that floor in practice.
2. **A glob that matches no file passes vacuously.** A typo in a glob, or a new
   directory nobody added a glob for, is never checked by Vitest itself.

Issue #4 originally proposed ~60 % for adapters, on the premise that adapter code
"only meaningfully runs against RPC". The design adopted in #5 removes most of that
premise: RPC access goes through an injected port, and adapters are tested offline
against committed fixtures of RPC responses. Those fixture-based tests run under
Vitest and count towards coverage. What remains untestable offline is the thin live
implementation of the port.

## Decision

- **`src/math/**`: 95** on all four metrics. Pure code; it sits at ~97 % today.
- **`src/adapters/**`: 80** lines/functions/statements, **75** branches. Active now,
  before any adapter exists (it passes vacuously until then), so the first adapter
  PR cannot forget it. The gap to 100 is room for the live port implementation, not
  for untested decoding or conversion code.
- **Global: a backstop at the lowest per-directory floor** (80/80/75/80). This lowers
  the previous global 90/90/85/90; it does not lower the bar for any existing code,
  because `src/math` is now held to 95 on its own.
- **Every directory under `src/` has its own glob**, added in the PR that creates the
  directory. `tests/coverage-policy.test.ts` enforces this, and enforces that the
  global backstop never exceeds a per-directory floor.

## Consequences

- An untested new directory can no longer hide behind `src/math`'s average.
- Adding a directory under `src/` requires choosing its floor — and, if it is below
  the backstop, revisiting this ADR.
- Coverage still does not prove behaviour. The project's real defences remain tests
  pinned to observed data, property tests (#7), and model-vs-chain checks (#5).
- Files directly in `src/` (today only the `index.ts` barrel) are held only by the
  global backstop. Acceptable while they are re-exports.

## Alternatives considered

- **Keep a single global threshold.** Averages hide untested directories, and the
  first adapter would either fail it or force tests that execute lines without
  checking anything.
- **Remove the global threshold.** Leaves root-level files unconstrained; keeping it
  at the lowest floor costs nothing.
- **Per-file thresholds (`perFile: true`).** Too blunt: one small module with an
  unreachable defensive branch would need its own exception.
- **Adapters at ~60 %, as first proposed in #4.** Premise no longer holds with the
  injected port and fixtures (see Context); 60 would leave room for untested
  decoding and unit conversion, exactly where a plausible wrong number would come
  from.
