/**
 * `pnpm positions <wallet> [--quote <mint>]` — prints every open Orca Whirlpool
 * position of a wallet. Read-only.
 *
 * The RPC endpoint comes from `SOLANA_RPC_URL` (default: the public mainnet
 * endpoint). Neither the wallet nor the endpoint is stored anywhere.
 *
 * Side effects (environment, network, output) are injected into {@link main},
 * so the whole command is testable offline.
 */

import { pathToFileURL } from 'node:url';

import { DEFAULT_QUOTE_PREFERENCE, createRpcPort, readPositions } from '../adapters/orca/index.js';
import type { SolanaReadPort } from '../adapters/orca/index.js';
import { distanceToBounds } from '../math/index.js';
import { AmbiguousQuoteError } from '../positions/index.js';
import type { PositionReading, TokenInfo } from '../positions/index.js';

export const DEFAULT_RPC_URL = 'https://api.mainnet-beta.solana.com';

/** Display names for well-known mints. Presentation only; readings carry mints. */
const SYMBOLS: Readonly<Record<string, string>> = {
  So11111111111111111111111111111111111111112: 'SOL',
  '3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh': 'WBTC',
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: 'USDC',
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: 'USDT',
};

const USAGE = 'usage: pnpm positions <wallet> [--quote <mint>]';

export interface CliDeps {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly createPort: (rpcUrl: string) => SolanaReadPort;
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
}

/** Runs the command; returns the process exit code. */
export async function main(argv: readonly string[], deps: CliDeps): Promise<number> {
  const args = parseArgs(argv);
  if (args === null) {
    deps.err(`${USAGE}\n`);
    return 2;
  }
  const port = deps.createPort(deps.env.SOLANA_RPC_URL ?? DEFAULT_RPC_URL);
  const quotePreference =
    args.quote === undefined ? DEFAULT_QUOTE_PREFERENCE : [args.quote, ...DEFAULT_QUOTE_PREFERENCE];
  try {
    const readings = await readPositions(port, args.wallet, { quotePreference });
    deps.out(formatReadings(readings));
    return 0;
  } catch (error) {
    if (error instanceof AmbiguousQuoteError) {
      deps.err(`${error.message}: --quote <mint>\n`);
      return 1;
    }
    throw error;
  }
}

function parseArgs(argv: readonly string[]): { wallet: string; quote?: string } | null {
  const [wallet, flag, quote, ...rest] = argv;
  if (wallet === undefined || wallet.startsWith('-') || rest.length > 0) {
    return null;
  }
  if (flag === undefined) {
    return { wallet };
  }
  return flag === '--quote' && quote !== undefined ? { wallet, quote } : null;
}

/**
 * One block per position. Percentages appear only here, at the presentation
 * boundary; readings carry fractions.
 */
export function formatReadings(readings: readonly PositionReading[]): string {
  if (readings.length === 0) {
    return 'No open Orca Whirlpool positions.\n';
  }
  return readings.map(formatReading).join('\n');
}

function formatReading(r: PositionReading): string {
  const base = symbol(r.pair.base);
  const quote = symbol(r.pair.quote);
  const unit = `${quote}/${base}`;
  const { toLower, toUpper } = distanceToBounds(r.price, r.position.range);
  const inRange = toLower <= 0 && toUpper >= 0;
  return [
    `${base}/${quote}  fee ${percent(r.feeRate, 2)}  pool ${r.source.pool}`,
    `  position  ${r.source.position}`,
    `  range     ${num(r.position.range.lower)} – ${num(r.position.range.upper)} ${unit}`,
    `  price     ${num(r.price)} ${unit}  ${inRange ? 'in range' : 'OUT OF RANGE'}` +
      `  (to lower ${percent(toLower, 2)}, to upper ${percent(toUpper, 2)})`,
    `  amounts   ${num(r.amounts.base)} ${base} + ${num(r.amounts.quote)} ${quote}`,
    `  fees owed ${num(r.feesOwed.base)} ${base} + ${num(r.feesOwed.quote)} ${quote}`,
    `  slot      ${r.slot.toString()}`,
    '',
  ].join('\n');
}

function symbol(token: TokenInfo): string {
  return SYMBOLS[token.mint] ?? `${token.mint.slice(0, 4)}…${token.mint.slice(-4)}`;
}

/** Six significant figures: enough to compare with the protocol UI. */
function num(value: number): string {
  return value.toPrecision(6);
}

function percent(fraction: number, digits: number): string {
  return `${(fraction * 100).toFixed(digits)} %`;
}

/* c8 ignore start -- process wiring; everything it calls is tested through main() */
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2), {
    env: process.env,
    createPort: createRpcPort,
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
