/**
 * `pnpm record-fixture <wallet> <name>` — reads the wallet's positions from the
 * live chain and writes the sanitised port traffic to `<dir>/<name>.json`
 * (see `src/adapters/orca/fixture.ts`).
 *
 * A fixture of real positions is private position data (AGENTS.md): it names
 * the positions read, and a position leads to its NFT and to the wallet on
 * chain. It is therefore written **outside the repository**: to
 * `$LPA_FIXTURE_DIR`, or by default to {@link DEFAULT_FIXTURE_SUBDIR} under the
 * home directory. It must never be committed; `scripts/check-no-fixtures.mjs`
 * enforces that on commit, push and CI.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { createRpcPort, readPositions, recordingPort } from '../adapters/orca/index.js';
import type { SolanaReadPort } from '../adapters/orca/index.js';
import { DEFAULT_RPC_URL } from './positions.js';

/** Default fixture directory, relative to the home directory. */
export const DEFAULT_FIXTURE_SUBDIR = '.local/share/liquidity-pool-analyzer/fixtures/orca';

const USAGE = 'usage: pnpm record-fixture <wallet> <name>   (name: letters, digits, - and _)';

export interface RecordDeps {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly createPort: (rpcUrl: string) => SolanaReadPort;
  readonly writeFile: (path: string, contents: string) => Promise<void>;
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
}

/** Runs the command; returns the process exit code. */
export async function main(argv: readonly string[], deps: RecordDeps): Promise<number> {
  const [wallet, name, ...rest] = argv;
  if (wallet === undefined || name === undefined || rest.length > 0 || !/^[\w-]+$/.test(name)) {
    deps.err(`${USAGE}\n`);
    return 2;
  }
  const dir = fixtureDir(deps.env);
  if (dir === undefined) {
    deps.err('Set LPA_FIXTURE_DIR or HOME: fixtures are written outside the repository.\n');
    return 2;
  }
  const recorder = recordingPort(deps.createPort(deps.env.SOLANA_RPC_URL ?? DEFAULT_RPC_URL));
  const readings = await readPositions(recorder.port, wallet);
  const fixture = await recorder.toFixture();
  const path = join(dir, `${name}.json`);
  await deps.writeFile(path, `${JSON.stringify(fixture, null, 2)}\n`);
  deps.out(`Wrote ${path}: ${String(readings.length)} position(s) at slot(s) ${slots(readings)}\n`);
  return 0;
}

/** Where fixtures go: `$LPA_FIXTURE_DIR`, else under `$HOME`; never the repository. */
export function fixtureDir(env: Readonly<Record<string, string | undefined>>): string | undefined {
  if (env.LPA_FIXTURE_DIR !== undefined && env.LPA_FIXTURE_DIR !== '') {
    return env.LPA_FIXTURE_DIR;
  }
  if (env.HOME !== undefined && env.HOME !== '') {
    return join(env.HOME, DEFAULT_FIXTURE_SUBDIR);
  }
  return undefined;
}

function slots(readings: readonly { readonly slot: bigint }[]): string {
  return [...new Set(readings.map((r) => r.slot.toString()))].join(', ') || '—';
}

/* c8 ignore start -- process wiring; everything it calls is tested through main() */
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2), {
    env: process.env,
    createPort: createRpcPort,
    writeFile: async (path, contents) => {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, contents);
    },
    out: (text) => process.stdout.write(text),
    err: (text) => process.stderr.write(text),
  }).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      process.stderr.write(`${String(error)}\n`);
      process.exitCode = 1;
    },
  );
}
/* c8 ignore stop */
