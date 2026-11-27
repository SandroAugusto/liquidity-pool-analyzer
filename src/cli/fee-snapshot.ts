/**
 * `pnpm fee-snapshot --out <file.jsonl>` — appends one fee snapshot per public
 * Orca WBTC/SOL Whirlpool to a JSON Lines file (ADR-0007). Read-only.
 *
 * Every pool of the pair on Orca's public fee tiers is read in one call, so the
 * snapshots of a run share a slot. Nothing here concerns any wallet or position:
 * the pools are public protocol accounts. Run hourly by
 * `.github/workflows/fee-snapshots.yml`.
 *
 * The RPC endpoint comes from `SOLANA_RPC_URL` (default, also when empty: the
 * public mainnet endpoint). Side effects (environment, network, clock, disk, output) are
 * injected into {@link main}.
 */

import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

import { createRpcPort, readPools, whirlpoolAddressesForPair } from '../adapters/orca/index.js';
import type { SolanaReadPort } from '../adapters/orca/index.js';
import { formatSnapshotLine } from '../research/fee-snapshots.js';
import { DEFAULT_RPC_URL } from './positions.js';

/** Public mints of the pair studied. Not secrets. */
export const PAIR = {
  WBTC: '3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh',
  SOL: 'So11111111111111111111111111111111111111112',
} as const;

const USAGE = 'usage: pnpm fee-snapshot --out <file.jsonl>';

export interface SnapshotDeps {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly createPort: (rpcUrl: string) => SolanaReadPort;
  readonly now: () => Date;
  /** Appends `text` to the file at `path`, creating it and its directory if needed. */
  readonly append: (path: string, text: string) => Promise<void>;
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
}

/** Runs the command; returns the process exit code. */
export async function main(argv: readonly string[], deps: SnapshotDeps): Promise<number> {
  const [flag, path, ...rest] = argv;
  if (flag !== '--out' || path === undefined || path.startsWith('-') || rest.length > 0) {
    deps.err(`${USAGE}\n`);
    return 2;
  }
  // An unset secret reaches a workflow as an empty string, not as undefined.
  const rpcUrl = deps.env.SOLANA_RPC_URL;
  const port = deps.createPort(rpcUrl === undefined || rpcUrl === '' ? DEFAULT_RPC_URL : rpcUrl);
  const pools = await whirlpoolAddressesForPair(PAIR.WBTC, PAIR.SOL);
  const readings = await readPools(port, pools);
  const observedAt = deps.now();
  if (readings.length === 0) {
    deps.err('No WBTC/SOL Whirlpool found; nothing written.\n');
    return 1;
  }
  const lines = readings.map((reading) => `${formatSnapshotLine({ observedAt, reading })}\n`);
  await deps.append(path, lines.join(''));
  const slot = readings[0]?.slot ?? 0n;
  deps.out(`${String(readings.length)} pools at slot ${slot.toString()} appended to ${path}\n`);
  return 0;
}

/* c8 ignore start -- process wiring; everything it calls is tested through main() */
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2), {
    env: process.env,
    createPort: createRpcPort,
    now: () => new Date(),
    append: async (path, text) => {
      await mkdir(dirname(path), { recursive: true });
      await appendFile(path, text, 'utf8');
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
