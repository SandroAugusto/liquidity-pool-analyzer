# Journal

Engineering notebook for the project: predictions, outcomes, mistakes and the lessons
they taught. Newest entries at the bottom. Prices are SOL per WBTC unless stated
otherwise. "vs. hold" means position value + pending fees, compared with holding the
deposited tokens, both valued in the quote token at the current price.

The owner's own positions, readings and results are **not** recorded here. Where a
lesson came from real use, the lesson is kept and the figures are not.

---

## Before the repository

Lessons from building the continuous model, before and while the repository was
created:

- **Normalise to a daily rate before comparing anything.** A fee figure for part of a
  day was once reported as a daily rate, understating it.
- **A 24 h figure next to a large volume swing is not a baseline.** A single day of
  unusually high pool volume can make a fee rate look several times its normal level.
  Measure over 7-day windows.
- **Check pool-wide fee/TVL on the protocol's own UI, then look at the depth chart.** A
  third-party analytics site can report a TVL that is off by a large factor, which
  inflates the apparent fee rate of a pool. The depth chart then shows whether
  concentrating buys anything.

- **A rounded deposit is not a hold baseline.** A base deposit rounded to 4 dp shows a
  positive "divergence" at entry. The tests use the full-precision implied deposit.
- **Divergence to the edge grows linearly with the half-width, not with its square.**
  Full-range IL ∝ h², and concentration amplifies it by ~1/h. Doubling the range
  doubles the per-cycle loss (ratio measured: 1.99). Encoded as a test.

### Decision rules (hypotheses under test)

- **In range:** do nothing. Harvest only when re-centring or when pending fees exceed
  ~1–2 % of position value.
- **Out of range:** wait. Re-centre only when `days_out × fee_rate_7d` exceeds the
  cost of re-centring.
- **Exit the pool:** if `fee_rate_7d − amortised_divergence_cost` stays below
  ~0.04 %/day for 1–2 weeks.
- **Known weaknesses:** the re-centre threshold is a heuristic; σ over 30 days reacts
  slowly; `E[T]` ignores drift; nothing yet uses pool volume as a leading indicator.

### Review of PR #1 — what it found

Five findings, four of them the **same defect class**: validation was applied to
`range` and `price` but not to `liquidity`, `TokenAmounts` or the elements of a
series. `amountsAtPrice({ liquidity: -1, … })` returned negative balances;
`mean([1, NaN])` returned `NaN`; `logReturns([1e-300, 1e300])` overflowed to
`Infinity`.

Selective validation is worse than none. It reads as a protected boundary, so callers
stop checking, and the hole is exactly where no one is looking. The fix was mechanical;
the lesson is procedural: **when a module validates anything, enumerate every input of
every public function and decide each one explicitly.** Issue #3 will move this to
constructors so the enumeration happens once.

The fifth finding (CI did not run `pnpm build`) is the same pattern at the pipeline
level — a check that existed locally but not in the place that matters.

## 2026-10-23 (later) — Parse, don't validate (#3)

Review of PR #1 showed the weakness of per-call validation: it is easy to apply to
some inputs and forget others. The structural fix landed as a refactor:

- `QuotePerBase` is a branded `number`; `quotePerBase(x)` is the only way to get one.
  Passing `1200` directly where a price is expected is now a **compile error**.
- `PriceRange`, `Position` and `TokenAmounts` are branded too and can only be built
  through `createRange`, `createPosition`, `tokenAmounts`. Object literals do not
  type-check.
- Calculation functions lost all their `assert*` preambles. They validate only
  relationships between inputs (price strictly inside the range for liquidity
  recovery; non-empty deposit for divergence loss).

Every rejection path from the previous tests still exists; it moved from the
calculation function to the constructor. Three new tests use `@ts-expect-error` to
pin the type-level guarantees — if the compiler ever stops rejecting raw numbers, the
unused directive fails the typecheck.

Open question, deliberately deferred: `logReturns`/`dailyVolatility` still take
`readonly number[]`. Price series come from external sources and the ratio is
constructed on the fly; branding the series adds ceremony with little protection.
Revisit when the on-chain adapter produces the series (#5).

## 2026-10-23 (evening) — Property-based tests (#7)

Three review rounds had found the same defect class — valid, finite inputs producing
a non-finite result — one instance at a time. Added fast-check and, for every public
function in `src/math`, a property over the **full** range the constructors accept
(denormals to `Number.MAX_VALUE`).

### What the suite found before any code was changed

Seven failures in under a second, in functions no review had reached:

| Function                                    | Defect                                                               |
| ------------------------------------------- | -------------------------------------------------------------------- |
| `distanceToBounds`                          | `upper / price − 1` overflows to `Infinity`                          |
| `valueInQuote`                              | `base · price` overflows                                             |
| `divergenceLoss`                            | overflow in the ratio when `hold` is a denormal (passes `hold <= 0`) |
| `expectedDaysToExit`, `halfWidthForHorizon` | overflow / **underflow to 0**                                        |
| `amortisedDivergenceCostPerDay`             | overflow                                                             |
| `liquidityFromBase`                         | **underflow to 0** from a positive deposit                           |

Underflow to zero is a new class: a positive deposit yielding liquidity `0` is as
wrong as `Infinity`, and no earlier review had looked for it. Fixed with two shared
guards (`ensureFinite`, `ensurePositiveFinite`) in `src/math/errors.ts`.

### Proof the tests have teeth

Reverted three historical fixes one at a time and re-ran the properties:

- `geometricCentre` product overflow (PR #6) — **caught**.
- `logReturns` quotient overflow (PR #1) — **caught**.
- `mean` running-sum overflow (PR #1) — **not caught** at first: the series generator
  stopped at ±1e300. Widened to ±`MAX_VALUE`; then caught — and the widened generator
  also showed that the _fixed_ incremental mean (`mu += (v − mu)/n`) still overflows
  when `v` and `mu` have opposite signs near `MAX_VALUE`. Replaced with
  `mu += v/n − mu/n`, which never forms a quantity larger than its inputs.

### Three wrong expectations of my own, caught by the process

1. I first wrote `divergenceLoss(pos, deposit, p) ≤ 0` for an _arbitrary_ deposit. The
   property only holds for the position's own deposit; with an unrelated deposit the
   sign is unconstrained. The example-based test had used the right deposit; the
   property did not.
2. I asserted sign properties at denormal scale, where a double has one significant
   bit and `5e-324 × 2.5` rounds to `1.5e-323`. That is not a statement about the
   formulas. Split the suite into **representation** properties (full range) and
   **mathematical** properties (realistic magnitudes, ranges ≥ 1 tick).
3. "Finite or typed error" was too lenient for functions whose result is
   mathematically guaranteed representable — `geometricCentre`, `mean`, `logReturns`.
   For those, _throwing_ is the bug, and the harness let it pass. Those three now use
   `mustBeFinite` (no escape clause); that is what made the revert test bite.

Lesson: a property test is only as strong as its generator and its oracle. The first
version of this file would have passed with the bugs it was written to catch.

## 2026-10-24 — Coverage policy (#4, ADR-0003)

Replaced the single global threshold with per-directory floors: `src/math` 95,
`src/adapters` 80/75 (active before any adapter exists), global as a backstop at the
lowest floor.

### Wrong expectations

1. **"Adapters can only reach ~60 %."** Written in #4 when adapter tests meant
   mocking the SDK. The design later adopted in #5 (injected RPC port, committed
   fixtures of RPC responses) makes almost all adapter code testable offline, and
   those tests count towards coverage. 60 would have left room for untested decoding
   and unit conversion — exactly where a plausible wrong number would come from.
2. **Per-directory globs are independent of the global threshold.** They are not:
   checked in the installed Vitest (3.2.7), the global figure includes glob-matched
   files. A global 90 would have overridden an adapter floor of 80. Recorded in the
   ADR and asserted by `tests/coverage-policy.test.ts`.
3. **A threshold on a glob is a check.** A glob that matches nothing passes
   vacuously — a typo, or a new directory with no glob, is never checked. The policy
   test fails when a directory under `src/` has no glob of its own.

### Proof the policy test has teeth

- Created `src/positions/x.ts` with no glob → fails with
  `src/positions/** has no coverage threshold`. Removed.
- Raised global `lines` to 90 → fails with
  `global lines exceeds src/adapters/**: expected 90 to be less than or equal to 80`.
  Reverted.

## 2026-10-24 — Module boundaries in lint (#11)

ADR-0002 ("`src/math` never feeds a signer") and AGENTS.md ("read-only against
chains") were prose. Now `eslint.config.js` bans signing and transaction-construction
APIs everywhere, keeps `src/math` importing only from itself, and forces consumers to
reach adapters through their `index.js`. Core ESLint rules only — no new dependency.

### Wrong expectations

1. **"Lint can enforce ADR-0002."** It cannot: it sees imports, not data flow. What it
   enforces is weaker — no signer exists for math output to reach while the repo is
   read-only.
2. **`no-restricted-imports` covers every way in.** Probed before writing the rules:
   it catches static imports, `import type`, `import * as` and `export … from`, but
   not dynamic `import()`, and a method call like `rpc.sendTransaction()` is not an
   import at all. Added `no-restricted-syntax` (no `import()` in `src`) and
   `no-restricted-properties` (send/sign methods). Computed access
   (`rpc[name](…)`) still gets through; recorded in AGENTS.md as a review item.
3. **Blocks for the same rule add up.** In flat config a later block _replaces_ the
   options of an earlier one for overlapping files. A `src/math` block with only the
   purity pattern would have silently dropped the signing ban there. Every block
   repeats the signing patterns.

### Proof the tests have teeth

`tests/lint-boundaries.test.ts` resolves the effective options from the real config
per path, so globs and block order are under test. Each mutation was applied, run,
and reverted:

- typo in the `src/math` glob → 5 failures;
- signing patterns dropped from every block → 33 failures;
- deep-import regex loosened to match nothing → 4 failures;
- `src/math` block moved before the consumer block → 5 failures;
- signing patterns dropped from the consumer block only (the override trap) → 11
  failures.

### Review of #13 — a regex on the specifier is not a boundary

The independent review (codex) found that the `src/math` rule checked the _shape_ of
the specifier (`^(?!\./)`), not where it lands. Reproduced: in `src/math/example.ts`,
`./../adapters/orca/index.js` resolves to `src/adapters/orca/index.js` and was
**allowed**; in `src/math/nested/example.ts`, `../price.js` resolves to
`src/math/price.js` and was **rejected**.

Both destination rules (math stays inside, adapters via index) are now small local
ESLint rules that resolve the specifier against the importing file. Fixing it exposed
a wrong expectation in my own test: it asserted that `./adapters/orca/decode.js` from
`src/cli/example.ts` must be rejected — but that resolves to `src/cli/adapters/…`,
which is not an adapter. The old regex rejected it by accident, and the test pinned
the accident. Lesson: a test written against a text-matching rule inherits the rule's
model of the world; the cases have to be stated in terms of the property (where the
import lands), not the mechanism.

Mutations re-run after the fix, each reverted: math rule back to a prefix check → 4
failures; typo in the math glob → 9; adapter rule disabled → 6; signing ban dropped → 33.
