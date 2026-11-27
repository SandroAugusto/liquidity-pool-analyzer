# Security

## What this repository is

Read-only decision-support tooling for concentrated-liquidity positions. It reads
public chain accounts over Solana JSON-RPC and public market candles over HTTPS,
and computes figures from them. It never holds a key, never signs and never sends
a transaction (ADR-0002). `AGENTS.md` states the conventions; this file states
what a security review looks for.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting (the repository's **Security** tab →
**Report a vulnerability**). Do not open a public issue, and do not include any
wallet address, position or transaction in a report.

## Security review guidelines

For automated and human security review of pull requests.

### Threat model

- **Assets, in order:**
  1. The read-only guarantee. Code that can sign or send is the path to losing
     funds.
  2. Privacy of positions. A wallet address, a position or NFT address, or a
     range together with a date is enough to find a position on chain and
     everything its owner holds.
  3. The RPC credential (`SOLANA_RPC_URL` may carry a token) and the workflow
     token of `fee-snapshots.yml`, which has `contents: write`.
  4. The integrity of the numbers. A wrong figure leads to a wrong financial
     decision; `AGENTS.md` covers this as correctness.
- **Trust boundaries:**
  - RPC responses and market-data responses: untrusted input, decoded and
    validated before use;
  - command-line arguments and environment variables (wallet, fixture name,
    output path, RPC URL);
  - pull requests from forks, npm dependencies and their install scripts, and
    the GitHub Actions used by the workflows.

### Accepted by design; do not report

- The public mainnet RPC endpoint as the default when `SOLANA_RPC_URL` is unset.
- Public protocol data in the repository: pool addresses, token mints, program
  ids, fee tiers and public price series.
- `fee-snapshots.yml` pushing to the `data/fee-growth` branch. It records public
  pool state and concerns no wallet.

### Flag a change that

**Read-only guarantee**

- Imports, re-exports or calls anything that builds, signs or sends a
  transaction, or handles a keypair, seed phrase or signer.
- Weakens the lint rules that enforce this (`no-restricted-imports`,
  `no-restricted-properties`, the ban on dynamic `import()` in `src`, the local
  boundary rules), narrows the files they cover, adds an `eslint-disable` for
  them, or changes `tests/lint-boundaries.test.ts` so a rule is no longer
  proven.
- Reaches a restricted API in a way lint cannot see: computed property access
  such as `rpc[name](…)`, a re-export through an adapter's `index.ts`, a string
  passed to `import()`, or a new package that wraps the same APIs.
- Adds an RPC method that is not a read, or a dependency whose purpose is
  building or sending transactions.
- Feeds a value from `src/math` (the continuous model) into anything that could
  become a transaction amount.

**Privacy of positions**

- Adds a wallet, position or NFT address, a range, an entry price, a deposit, a
  balance, fees, P&L, or a date tied to any of them, to code, tests, fixtures,
  documentation, commit messages or CI output. Tests use synthetic positions or
  public protocol and market data.
- Lets a recorded fixture be written inside the repository, or weakens a line of
  defence against committing one: `.gitignore`, `scripts/check-no-fixtures.mjs`,
  the hooks in `lefthook.yml`, the CI step that runs the guard, or
  `tests/fixture-privacy.test.ts`.
- Prints or logs a wallet address, a position address or a full RPC URL where
  the output can reach CI logs, an error message committed to a snapshot, or a
  file on the data branch.
- Makes a workflow read a wallet or a position. Workflows read pools only.
- Weakens the sanitising of recorded port traffic in
  `src/adapters/orca/fixture.ts`.

**Secrets**

- Commits an RPC URL with a token, an API key or any credential, or adds a
  `.env` file other than `.env.example`.
- Echoes `SOLANA_RPC_URL` or includes it in an error message or a written file.

**Untrusted input**

- Uses an RPC or market-data response without decoding and validating it at the
  adapter boundary, or lets a malformed response become `NaN`, `Infinity` or a
  silently clamped value instead of an error.
- Builds a file path from a command-line argument or an environment variable
  without constraining it. The fixture name is restricted to `[\w-]+`; keep
  that property for any new path.
- Fetches from a new host, or follows a URL taken from a response.

**Workflows and supply chain**

- Widens `permissions`, adds `pull_request_target`, or lets code from a fork run
  in a job that has a write token or a secret.
- Makes `fee-snapshots.yml` commit to `main`, commit anything other than the
  snapshot files, or run install scripts (it installs with `--ignore-scripts`).
- Interpolates `${{ … }}` event fields directly into a `run:` script.
- Adds a dependency with an install script, changes `pnpm-lock.yaml` in a way
  the change to `package.json` does not explain, or replaces
  `--frozen-lockfile` in CI. A new dependency is also an ADR (`AGENTS.md`).

### Severity

- **Critical:** any path to signing or sending a transaction; a key or seed
  phrase handled or committed.
- **High:** private position data or a wallet address committed or logged; an
  RPC credential exposed; code from a fork or a dependency running with a write
  token or a secret; a defence against committing fixtures removed.
- **Medium:** unvalidated external input reaching a calculation; an unexplained
  supply-chain change; a path built from unconstrained input.
- Everything listed under "Accepted by design" is not a finding.
