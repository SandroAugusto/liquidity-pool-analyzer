# ADR-0001: TypeScript as the single runtime

- **Status:** Accepted
- **Date:** 2026-10-23

## Context

The math behind this project was first prototyped in Python. The on-chain integrations the project needs (Orca
Whirlpools on Solana, later Uniswap v3 on Base) ship first-class TypeScript SDKs.
The author's professional background is TypeScript/Node.

One of the project's purposes is to serve as a portfolio piece for work in the
DeFi/crypto space.

## Decision

TypeScript is the only language in the repository. The Python prototype is ported,
not kept alongside. Node ≥ 22 with ESM, `pnpm` for package management, `vitest` for
tests, `eslint` (type-checked rules) and `prettier` for consistency.

## Consequences

- One toolchain, one CI pipeline, one set of conventions.
- Numerical work uses IEEE-754 doubles (see ADR-0002). If arbitrary precision is
  ever needed, `decimal.js` or `bigint`-based fixed point are available in-language.
- Analysis notebooks are not a first-class artefact. If exploratory analysis is
  needed later, it exports CSV/JSON for external tools rather than adding a runtime.
- The portfolio signal is "TypeScript engineer who understands CLMM mechanics", which
  is the intended one.

## Alternatives considered

- **Python for math, TypeScript for chain I/O.** Two runtimes, two test suites, and a
  serialisation boundary through the most important module. Rejected.
- **Python only.** No official Orca SDK; would mean raw RPC and re-implementing tick
  math. Adds a weaker-skill language to the portfolio for no gain. Rejected.
