# ADR-0004: Orca SDK and the adapter boundary

- **Status:** Accepted
- **Date:** 2026-10-24

## Context

#5 adds the first on-chain adapter: read every open Orca Whirlpool position of a
wallet and hand `src/math` its inputs. Three constraints shape it:

1. **Read-only** (AGENTS.md; ADR-0002). Nothing may build, sign or send a
   transaction.
2. **Consistent reads** (#5, criterion 7). Price, liquidity, amounts and fees of a
   position must come from one slot; combining accounts from different slots
   produces a state that never existed.
3. **Protocol-neutral output** (#5, criterion 8). Consumers depend on
   `PositionReading`, never on Orca types.

Orca ships the current SDK generation as three packages on `@solana/kit`:
`@orca-so/whirlpools` (high level), `@orca-so/whirlpools-client` (account
decoders, PDAs, instruction builders) and `@orca-so/whirlpools-core` (Rust compiled
to WASM: tick/price conversions, fee and liquidity quotes). The legacy
`@orca-so/whirlpools-sdk` is on `@solana/web3.js` 1.x.

## Decision

**Use `@orca-so/whirlpools-client` and `@orca-so/whirlpools-core` directly, not the
high-level `@orca-so/whirlpools`.**

- The high-level package depends on `@orca-so/tx-sender` and the
  `@solana-program/*` instruction builders: its purpose is building and sending
  transactions. Its read helpers (`fetchPositionsForOwner`) fetch accounts
  themselves, so the reader could not control which slot each account comes from.
- `whirlpools-core` functions are pure: `collectFeesQuote` and
  `decreaseLiquidityQuote` take decoded account data as arguments. That makes the
  two-phase read below possible. Pending fees are computed from the tick arrays
  read-side; no `updateFeesAndRewards` transaction is simulated.
- Lint bans `@orca-so/whirlpools` and `@orca-so/tx-sender` outright, and every
  instruction builder of `whirlpools-client` (`get*Instruction`, `…Async`,
  `…InstructionDataEncoder`); `tests/lint-boundaries.test.ts` checks the ban
  against the installed package's real exports.

**Adapter boundary.**

- **Port.** The adapter reaches the chain only through `SolanaReadPort`:
  `findNftMints(owner)` and `getAccounts(addresses)` (one `getMultipleAccounts`,
  ≤ 100 accounts, one slot). The live implementation uses `@solana/kit`'s RPC
  client; tests use a synthetic chain or a recorded fixture.
- **Two-phase read.** _Discovery_ (NFT mints → positions → pools → mints) keeps the
  immutable facts — a position's pool, a pool's mints and tick spacing, a mint's
  decimals — and each position's tick bounds **as a plan only**: bounds change
  with `reset_position_range` and `reposition_liquidity_v2`. _State_ is one
  `getAccounts` call per group of up to 25 positions holding each position, its
  pool and both tick arrays; every mutable figure comes from that response and
  carries its slot. A position whose bounds differ from its plan is re-planned
  (its tick arrays may be other accounts) and read again, up to three times, then
  refused with `InconsistentReadError`. A single `getMultipleAccounts` for
  everything is impossible (each address depends on the previous step), and
  pinning sequential calls to one slot would fail on almost every run at ~400 ms
  per slot.
- **Positions without liquidity** are read from their own fields: no tokens, and
  fees owed already settled on the last liquidity change. Their tick arrays may
  never have been created (`open_position` does not need them), so they are not
  required.
- **Response alignment is checked.** A port response with the wrong length or an
  account other than the one requested is refused; misaligned mint lookups would
  silently swap decimals.
- **Orientation is explicit.** Token A/B order is mint byte order. In WBTC/SOL, SOL
  is token A, so the pool-native price is WBTC per SOL. The quote token is chosen
  from a preference list (USDC, USDT, SOL, overridable with `--quote`); a pair with
  no listed token raises `AmbiguousQuoteError` instead of guessing.
- **Tick arrays** are decoded with `decodeTickArray`, which handles fixed and
  dynamic arrays. `getTickArrayDecoder()` decodes fixed arrays only and would
  misread a dynamic one into plausible wrong fees.
- **Output** is `PositionReading` (`src/positions/`): `src/math` types, mints and
  decimals, fee rate as a fraction, slot. Orca types stay inside the adapter.

**Version policy: exact pins** for `@orca-so/whirlpools-client` 7.0.0,
`@orca-so/whirlpools-core` 3.1.0 and `@solana/kit` 5.5.1, unlike the repository's
default of `^` ranges plus lockfile.

- The decoders define how account bytes are interpreted. A decoder change must be a
  deliberate PR that re-runs the fixture tests, not a side effect of a lockfile
  refresh.
- Orca releases client and core in lockstep and `@orca-so/whirlpools` itself pins
  them exactly; a caret on one could pair it with an incompatible other.
- `@solana/kit` is held at 5.x by the client's peer range (`^5.0.0`), although 8.x is
  current. Upgrading kit means upgrading the client first.

## Consequences

- The adapter needs no transaction-capable package at all; the read-only rule is
  enforced by the dependency graph as well as by lint.
- Every reading states the slot its figures come from, and the CLI prints it, so a
  comparison with the Orca UI can be pinned to a moment (#5, criterion 1b).
- Known limits, each a typed refusal or documented gap rather than a wrong number:
  - Pools with a Token-2022 mint throw `UnsupportedPositionError` (transfer fees not
    handled).
  - Position bundles are not read.
  - Rewards are not read; `feesOwed` is trading fees only.
  - For adaptive-fee pools, `feeRate` is the base fee rate, not the current dynamic
    fee.
- Upgrading the SDK is a manual, reviewed step (see version policy).
- Fixtures are recorded port traffic. The recorder drops non-position NFTs and
  their lookups from every discovery chunk and re-chunks the rest exactly as the
  reader will request them, so replay stays strict.

## Alternatives considered

- **`@orca-so/whirlpools` (high level).** Least code, but brings the transaction
  sender and fetches accounts on its own schedule; loses both the read-only
  dependency graph and the single-slot guarantee.
- **Legacy `@orca-so/whirlpools-sdk`.** Built on `@solana/web3.js` 1.x and
  Anchor; superseded by the packages above.
- **Decoding accounts by hand.** No dependency, but re-implements Orca's layouts and
  fixed-point math — the place a plausible wrong number would hide. The SDK is the
  reference the model is validated against.
- **One `getMultipleAccounts` for everything, or sequential calls pinned to one
  slot.** The first is impossible (addresses depend on earlier answers); the second
  fails most of the time. Discovery of immutable facts plus one state call per group
  gives the guarantee that matters.
