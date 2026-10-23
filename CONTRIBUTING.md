# Contributing

This is a personal project with professional standards. The rules below exist so that
every change is reviewable, reversible and explained.

## Workflow

1. Branch from `main`: `feat/…`, `fix/…`, `docs/…`, `chore/…`.
2. Keep PRs small and single-purpose. If a PR needs the word "and" in its title, split it.
3. `pnpm check` must pass locally before opening the PR. CI runs the same command.
4. Every PR gets a review. Self-merging is allowed only for `docs/` and `chore/` changes
   that touch no source code.
5. Squash-merge. The squash message follows Conventional Commits.

## Commits

[Conventional Commits](https://www.conventionalcommits.org/):
`feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `chore:`, `ci:`.

The body explains **why**, not what. The diff already says what.

## Code

- TypeScript `strict` plus the additional checks in `tsconfig.json`. Do not weaken them.
- No `any`. No non-null assertions without a comment proving the invariant.
- Public functions have explicit return types and a doc comment stating units and
  conventions (price direction, fractions vs. percentages).
- Validate inputs at module boundaries and throw typed errors. Fail loudly on bad data;
  a wrong number that looks right is the worst outcome this project can produce.
- Prefer pure functions. Side effects (network, disk, time) live at the edges and are
  injected, so the core stays testable without mocks.

## Tests

- Every public function has tests. Coverage thresholds are enforced in
  `vitest.config.ts`; lowering them requires an ADR.
- Where possible, test against **real observed data** (an on-chain snapshot, a UI
  reading) and record the provenance in the test file. Synthetic fixtures are fine for
  edge cases.
- A failing test that turns out to encode a wrong expectation is a finding, not a
  nuisance. Fix the expectation, and write the lesson down in `JOURNAL.md`.

## Decisions

Anything that would be hard to reverse or that a future reader would question gets an
ADR in `docs/adr/`, numbered sequentially, using the template in `0000-template.md`.

## Journal

`JOURNAL.md` is the project's lab notebook: hypotheses, what the model predicted, what
happened, what was wrong. It is as much a deliverable as the code.
