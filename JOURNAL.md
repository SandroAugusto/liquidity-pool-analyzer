# Journal

Engineering notebook for the project: predictions, outcomes, mistakes and the lessons
they taught. Newest entries at the bottom. Prices are SOL per WBTC unless stated
otherwise. "vs. hold" means position value + pending fees, compared with holding the
deposited tokens, both valued in the quote token at the current price.

Private position data (ranges, entries, deposits, readings, results) is never
recorded here (AGENTS.md, "No private position data").

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

## 2026-10-24 — Orca position reader (#5, ADR-0004)

`pnpm positions <wallet>` reads every open Whirlpool position from chain into a
protocol-neutral `PositionReading`. Built and tested offline: the Solana RPC hosts
are blocked in the environment this was written in, so **nothing here has been run
against real chain state yet**. Criteria 1 (CLI vs. UI) and 2–3 on live accounts
wait for `pnpm record-fixture` to be run where RPC is reachable.

### Wrong expectations

1. **"Fetch a position's accounts in one `getMultipleAccounts`, or pin calls with
   `minContextSlot`"** (my own wording in #5, criterion 7). The first is impossible:
   each address depends on the previous answer (NFT → position → pool → mints →
   tick arrays). The second would fail on almost every run, since sequential calls
   land on different slots. What works: discovery keeps only immutable facts, then
   one state call per group of positions holds everything mutable.
2. **"Don't assume WBTC is token A"** was the right warning about the wrong thing.
   SOL is token A in WBTC/SOL, so the pool-native price is WBTC per SOL, the inverse of what the UI shows;
   defaulting to "A is base" would have been just as wrong. The quote token is now
   chosen from an explicit preference list, and an unlisted pair is refused.
3. **The lint ban list I wrote from memory (#11) had holes and false positives.**
   Against the installed SDK: `get*InstructionAsync` builders and kit's message
   builders (`appendTransactionMessageInstructions`, `setTransactionMessageFeePayerSigner`,
   `createSignerFromKeyPair`) were allowed; `parse*Instruction` (read-side, needed
   by #10) was banned. A test now enumerates the client's real exports.
4. **`getTickArrayDecoder()` sounds like the tick-array decoder.** It decodes
   _fixed_ arrays only; `decodeTickArray` handles fixed and dynamic. The wrong one
   would turn a dynamic array into plausible wrong fees.
5. **"Use the current SDK" meant `@orca-so/whirlpools`.** That package depends on a
   transaction sender and fetches accounts itself. The adapter uses its two
   building blocks instead (client: decoders; core: pure math).
6. **Adapter coverage would be ~60 % (#4).** It is ~97 % lines / ~90 % branches:
   with the port injected, nearly all adapter code runs offline.

### Wrong expectations in my own tests

- The misaligned-response test passed with the alignment guard removed: reversing
  _every_ response tripped other checks first. It now scrambles only the mint lookup,
  where an unguarded reader would silently swap SOL and WBTC decimals.
- The fixture round-trip compared a replay against a _different_ live run, so the
  slots differed. It now compares against the recorded run.
- The random-pool property generated positions holding more than u64::MAX of a
  token; the SDK correctly refuses. Those impossible states are now discarded.

### Proof the tests have teeth

Each mutation applied, run, reverted; failures in `tests/adapters`:

- liquidity scaled without the square root → 2; by one token's decimals only → 2;
- range not inverted when the base is token B → 3;
- amounts not swapped when the base is token B → 5;
- fixed-only tick decoder → 1 (the dynamic-array fee test);
- alignment guard removed → 1 (the misaligned mint lookup);
- instruction-builder ban without `Async` (lint) → 4.

### Review of #14 — one premise wrong, one state missed

The independent review (codex) found three defects; all reproduced here with the real
SDK before fixing.

1. **"A position's tick bounds are immutable"** — mine, in the reader and in
   ADR-0004. `reset_position_range` and `reposition_liquidity_v2` rewrite them. A
   change between discovery and the state call made the reader take fee growth from
   the old ticks while amounts and range used the new ones. The reviewer could only
   show the mismatched inputs; with the real SDK it is a number: **24 SOL of fees
   reported, 40 correct**, no error. That is the P1 shape (a plausible wrong number),
   reached only through a race. Bounds are now a plan, re-checked in the state call;
   a moved position is re-planned and re-read, and refused after three moves.
2. **Every open position has tick arrays.** `open_position` does not create them; a
   never-funded position has none, and one such position aborted the whole wallet
   read. Zero-liquidity positions are now read from their own fields.
3. **Discovery is one call.** It is chunked by 100; the fixture sanitiser only
   filtered the first chunk, leaking later foreign-NFT lookups and breaking replay.
4. **"Keep the positions the run returned"** (second review round). A position that
   exists in discovery and closes before the state call is skipped by the reader, but
   the rest of the trace still holds its requests; dropping it broke replay. The
   sanitiser now keeps every NFT whose discovery lookup found a Whirlpool position,
   decided from the recorded accounts rather than from the readings.

Lesson: the synthetic chain only produces the states I thought of. Every position it
built had tick arrays and fixed bounds, so the tests could not disagree with my
assumptions. Each fix came with a synthetic-chain capability (moving a range,
skipping tick arrays, >100 candidates) and a test that failed before the fix — one of
them, "re-plans into other tick arrays", first passed for the wrong reason (the old
arrays were still there) until the test deleted them.

### Verification method

To verify the reader outside the test suite, compare it with an independent decoder
of the raw Position and Whirlpool accounts (written from the IDL, no shared code with
the SDK) and with the protocol UI, on accounts that are never committed. Fees owed
come from the tick-array
fee-growth path rather than the stored `fee_owed` fields, which lag until the next
liquidity change. Committed tests use synthetic chain state (AGENTS.md, "No private
position data").

One diagnostics gap: behind an HTTPS proxy the CLI fails with a bare
`TypeError: fetch failed`, because Node's built-in `fetch` ignores `HTTPS_PROXY`
unless `NODE_USE_ENV_PROXY=1` is set (Node ≥ 22.21).

## 2026-10-24 (night) — Rebalance economics (ADR-0005)

Built the re-centre economics model: a new module, `src/math/rebalance.ts`, with the
swap cost as an explicit input and a fee model whose fee/cost ratio does not depend on
the range width. The fee model is a hypothesis until it is validated on public data
(ADR-0005).

### Wrong expectations

1. **Valuing a position closed out of range at the edge price is close enough.** It
   understates divergence, because the real price was beyond the edge.
2. **An optimum width can be read off σ alone.** Under the fee model the fee/cost
   ratio does not depend on width; width only scales the result. A rule of thumb that
   picks a width from σ mixes up the absolute margin with the ratio.
3. **`logHalfWidth` always succeeds for a valid range.** The property suite found the
   counterexample on its first run: for bounds a few ulps apart, both logs round to
   the same double and the half-width underflows to zero. The typed error is the
   right outcome; the expectation was wrong.
4. **The swap cost is negligible, so leave it out.** Left out without a decision. It
   is small at realistic widths (a few percent of the cost at ±4 %) but it is the only
   term that makes width matter, so it is now an explicit input.

### Proof the tests have teeth

Each mutation applied to `src/math/rebalance.ts`, run against `tests/math`, reverted:

- half-width without the `/ 2` → 8 failures;
- swap dropped from the cost → 5;
- E[T] using the distance to one bound twice → 4;
- k inverted (fee · σ / hL) → 2;
- cost per day linear in σ instead of quadratic → 4.

## 2026-11-26 — Position fixtures leave the repository

Review of #1 found that `pnpm record-fixture` would write position fixtures to
`tests/fixtures/orca/`, inside the repository and not ignored by git, so a recorded
fixture would be one `git add -A` away from being committed. Two doc comments
also contradicted AGENTS.md, calling position addresses "public on-chain data". A
position leads to its NFT and to the wallet, so leaving the wallet out of the file
does not hide it.

### Wrong expectations

1. **"Review the file before committing it" is a control.** It is a reminder, and the
   rule it stands in for says real fixtures are never committed at all. A rule that
   depends on someone remembering it fails on the first tired evening.
2. **Sanitising the wallet out of a fixture makes it safe to share.** It removes one
   identifier; the position addresses in the same file lead back to it.

### What changed

Four independent lines of defence, each tested:

- the CLI writes to `$LPA_FIXTURE_DIR`, or under `$HOME`, never inside the repository,
  and refuses to record when neither is known;
- `.gitignore` covers `tests/fixtures/` and `*.fixture.json`;
- `scripts/check-no-fixtures.mjs` rejects a staged fixture on commit and one anywhere
  in the pushed history on push (it catches `git add -f`, and a fixture committed and
  then deleted);
- CI runs the same guard on the tree.

### Proof the tests have teeth

Each mutation applied, `tests/fixture-privacy.test.ts` run, reverted:

- `tests/fixtures/` removed from `.gitignore` → 2 failures;
- the guard's forbidden patterns emptied → 2 failures.

## 2026-11-26 (night) — Exit times on public prices (ADR-0005 criterion 2, ADR-0006)

Synthetic centred positions on public SOL per BTC prices (Coinbase candles), opened
daily over two years of hourly closes and 120 days of minute closes, compared with the
survival function of the exit time from the centre. Report:
`docs/research/exit-time.md`.

### Wrong expectations

1. **That the late exits were the market's.** On hourly data a ±1 % range exited at a
   median of 1.89 · E[T] against 0.757 over two years. Much of that is the sampling: an
   exit is only seen at a close. Over the same 120 days, hourly closes give 1.77 and
   minute closes 1.29: still late, but less. The Broadie–Glasserman–Kou correction brings hourly
   figures closer to minute ones with the 30-day σ from ±1 % to ±4 % (at ±8 % it is
   small and moves them slightly apart), but it is rough at ±1 % on hourly
   data, so minute data is the evidence for narrow ranges.
2. **That this would settle the σ window.** ADR-0005 recommended a recent window
   because volatility clusters. Over two years the 7-day and 30-day windows give
   medians within 0.04; over 120 days the two open different positions, so their
   tables are not a like-for-like comparison. Neither says anything
   about lag, which needs exit times conditioned on a change of regime. That part of
   criterion 2 is still open.
3. **That the daily σ window was complete.** It accepted a window with a missing daily
   close, which would treat a two-day return as a daily one (and threw on a window with
   only one return). A test with a gap found it; it now requires every close. No study
   result changed: none of the windows used had a gap.
4. **That the censoring was neutral.** The first version counted a position watched
   for less than c · E[T] if it had exited and dropped it if it had not, which selects
   on the outcome. An independent review found it; over 120 days of hourly data with the
   30-day σ it had turned the ±8 % cell at 2 · E[T] from 90.9 % (33 positions) into 95.8 % (71). Only positions watched
   for c · E[T] now count, and every cell shows its n. The same review caught prose
   that generalised one table cell ("tails wider at every width") to all of them.

### Proof the tests have teeth

- Treating a sample exactly on a bound as still in range fails
  `counts a sample exactly on a bound as an exit`.
- Counting an early exit of a position not watched for c · E[T] fails
  `counts only positions watched for c·E[T], exited or not`.
- Ignoring the discretely monitored E[T] fails
  `measures against the discretely monitored E[T] when asked`.
- Using Δt instead of √Δt in the correction fails both the independent value and the
  seeded Monte Carlo of the mean exit time.
- A separate Python script, outside the repository, reproduced the medians to two
  decimals.

## 2026-11-26 (late night) — What explains the exit-time differences

`pnpm exit-time-diagnostics` adds variance ratios against a sign-randomised null,
surrogate paths (signs randomised, returns shuffled, Gaussian walk; 40 seeds each),
tails against the same surrogates, the two σ windows on the same opening dates, and
trailing σ against the σ of the following week. Results in the report's diagnostics
section.

### Wrong expectations

1. **That mean reversion explained the narrow ranges.** Variance ratios below 1
   made it the obvious candidate. At ±1 % on hourly data, randomising the signs of
   returns leaves the median at 1.15 (1.10 with the actual σ) against an actual 1.14,
   shuffled returns give 1.02 and a Gaussian walk 0.77: the sizes of moves matter most
   there. At ±2 % and on minute data the result depends on how σ is estimated on the
   altered paths, so direction is not ruled out.
2. **That a first draft of these diagnostics was ready to publish.** An independent
   review found it overstated four causes: clustering as the cause when fat tails could
   explain as much, mean reversion "at every horizon" without a null, a shift of the model's median
   under the estimator that was inside the noise, and "calm periods" for what was a
   fall in volatility. The fixes added a null for the variance ratio, a second σ
   convention for the surrogates, and a tail table. A second review then found the
   revised claims still broader than the tables at other widths and on minute data;
   they now say what is and is not separated.
3. **That 120 days of minute data were the better evidence.** For the measurement at
   ±1 % they are, but across seeds the Gaussian walk's ±1 % median spans 0.62–1.00
   (10th–90th percentile) on 120 days: too short for most conclusions.
4. **That a long window lags when volatility rises.** It overshoots after volatility
   falls, by about 30 %; after a rise it is nearly unbiased and the 7-day window
   overshoots by about 45 %, probably partly regression to the mean of its own noise
   (not tested).

### Proof the tests have teeth

- Never flipping a sign fails
  `sign flipping keeps each return size in place and the first price and times`.
- Pairing returns by position instead of by time fails `never bridges a gap`.
- Ignoring `sigmaFrom` fails `can take σ from another series with the same times`.

## 2026-11-27 — Forecasting time in range out of sample

`pnpm exit-time-forecast` fits four forecasts of the 10th, 50th and 90th percentiles of
T on one year and tests them on the other, in both directions, with a 30-day embargo:
the model's quantiles, quantiles measured per width, the same per volatility regime,
and quantiles measured per width with E[T] from the geometric mean of the 7-day and
30-day σ. Results in the report's forecasting section.

### Wrong expectations

1. **That conditioning on the volatility regime would be the improvement.** Regime
   buckets beat the baseline at two widths when training on the first year and at none
   the other way. The blended σ beat it at ±1 % and ±2 % in both directions, though
   only borderline when training on the second year.
2. **That a bootstrap band around each score would compare methods.** A mean of
   absolute errors is biased upward under resampling, so the point estimates sat at
   the bottom of their own bands. Scoring every method on the same resamples and
   reporting the band of the difference from a baseline cancels most of that.
3. **That the coverage counting was obviously right.** A first version of the test
   would have passed with early exits of positions not watched long enough counted
   as covered, the same outcome selection fixed earlier in calibration. A case for it
   is now in the test.

### Proof the tests have teeth

- Counting an exited position that was not watched long enough fails
  `counts a test case for a quantile only if it was watched that long`.
- Dropping the embargo fails `keeps an embargo before the split, in both directions`.

## 2026-11-27 — Fees without an indexer

`pnpm fee-snapshot` reads every public WBTC/SOL Whirlpool in one call and appends a
snapshot per pool; a workflow runs it hourly and commits to the `data/fee-growth`
branch ([ADR-0007](./docs/adr/0007-fee-growth-snapshots.md)).

### Wrong expectations

1. **That the fee study needed liquidity by tick over time.** ADR-0006 and the
   exit-time report said so, and pointed to an indexer or a paid API. A position's fees
   are its liquidity times the fee growth inside its range, and that inside growth
   changes exactly as the pool's global growth while the price stays in range. For
   synthetic centred positions, snapshots of one public account suffice.
2. **That the free SQL services over Solana history were an option.** The one
   checked now offers a trial only; free access is view-only.

### Proof the tests have teeth

- Dropping the √(10^dB / 10^dA) factor fails the comparison with the SDK's
  `collectFeesQuote` on the recorded public pool.
- Valuing the position at `√P · h` instead of `2√P · (1 − e^(−h/2))` fails
  `matches src/math amounts` at h = 0.5.
- Counting the interval in which an exit is seen fails
  `stops at the first reading beyond a bound and does not count that interval`.
- Treating an empty `SOLANA_RPC_URL` as an endpoint fails
  `treats an empty SOLANA_RPC_URL (an unset workflow secret) as unset`.
