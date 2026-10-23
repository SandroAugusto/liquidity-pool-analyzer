# Instructions for agents working on this repository

This file is read by coding and reviewing agents (Codex, Claude Code, and similar).
Humans should read `CONTRIBUTING.md`; this file assumes you have.

## What this project is

Decision-support tooling for concentrated-liquidity positions. The core risk is not
a crash — it is a **plausible wrong number**. A divergence figure off by a sign, a
price quoted in the inverse direction, a percentage treated as a fraction: each
produces output that looks right and leads to a bad financial decision. Optimise your
attention for that failure mode.

## Conventions you must enforce

- **Price direction:** always _quote per base_ (SOL per WBTC in a WBTC/SOL pool).
  Any function taking or returning a price must say so in its doc comment. Flag any
  place where the direction is ambiguous or inverted.
- **Fractions, not percentages:** `0.05` means 5 %. Multiplying by 100 happens only
  at presentation boundaries. Flag any arithmetic that mixes the two.
- **Units in names and docs:** `days`, `perDay`, `inQuote`, `halfWidth`. A bare
  `rate` or `amount` without a unit is a defect.
- **Validation at construction boundaries:** prices, ranges, positions and token
  amounts are built through constructors (`quotePerBase`, `createRange`,
  `createPosition`, `tokenAmounts`) that validate once and return branded types.
  Calculation functions trust those types and only check relationships between
  inputs. A raw `number` where a price is expected, or an object literal where a
  validated type is expected, must be a compile error. Silent clamping or `NaN`
  propagation is a defect.
- **Continuous model only:** `src/math` must never be used to compute transaction
  amounts (ADR-0002). Flag any code path that could feed it into a signer.
- **No secrets:** no private keys, RPC URLs with tokens, or wallet addresses in the
  repository. Addresses belong in local config or env.

## Review priorities, in order

1. **Correctness of the math and its assumptions.** Does the formula match the
   documented model? Are edge cases (price at or beyond a bound, zero liquidity,
   empty series) handled and tested?
2. **Convention violations** listed above.
3. **Missing or weak tests.** Prefer tests pinned to real observed data with provenance
   noted. A test that only re-states the implementation is not a test.
4. **Decisions without an ADR** when they would be hard to reverse (new dependency,
   persistence format, external API, change to coverage thresholds).
5. **Readability**, only after the above. Do not comment on naming or style unless it
   causes one of the issues above or violates the lint config.

## How to report

- Lead with the most severe finding. One finding per comment, anchored to a line.
- State the failure scenario concretely: _input X → output Y, expected Z_.
- Do not pad with praise or summaries of what the diff does. The author knows.
- If you find nothing above priority 5, say so in one line and stop.
- End every comment and review with a signature line, e.g.
  `— automated review (codex)`. Agents post with the owner's GitHub identity; the
  signature is the only way the history shows which judgement was not human.

### Severity is assigned only after reproduction

A finding's severity, and whether it blocks merge, is decided **after** you have
reproduced the failure, not before. Reasoning about code is how you find a
candidate; running it is how you confirm one.

- **Reproduce first.** Run the failing input against the code at the PR head (a
  one-off script, a REPL, or a temporary test) and observe the wrong output. Quote
  the actual output in the finding.
- **Unreproduced is not blocking.** If you could not run it, or it did not fail, say
  so explicitly and mark the finding `unverified`. An unverified finding is never
  above P3 and never blocks merge.
- **Severity scale:**
  - **P1** — reproduced; produces a wrong number, a silent `NaN`/`Infinity`, or
    accepts invalid input in a reachable path. Blocks merge.
  - **P2** — reproduced; wrong behaviour at numerical or input extremes outside the
    realistic domain, or a missing guard that a future change could expose. Should
    be fixed in the PR or tracked in an issue before merge.
  - **P3** — maintainability, diagnostics, or test-harness clarity. Never blocks.
- **The review verdict must match the findings.** Do not summarise a review as
  "changes required" unless at least one reproduced P1 remains. If you downgrade a
  finding after posting, edit the original comment and the review summary — do not
  leave a blocking summary next to a non-blocking correction.

## When writing code

- Follow `CONTRIBUTING.md` and the lint config; do not weaken either.
- Keep PRs single-purpose. If the task needs an ADR, write it in the same PR.
- Record wrong expectations you discover (yours or the project's) in `JOURNAL.md`.
- Never sign, broadcast, or construct transactions. Read-only against chains until an
  ADR says otherwise.
