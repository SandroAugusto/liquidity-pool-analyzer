/**
 * Proves the module-boundary lint rules (#11) fire where they should — and only
 * there. Without this, a typo in a glob or a regex silently disables a rule and
 * nothing notices.
 *
 * The effective rule options for each path are resolved from the real
 * `eslint.config.js` (so block order and file globs are under test), then run on
 * small snippets with the TypeScript parser and no type information. Snippets
 * are linted as if they lived at the given path, so relative specifiers resolve
 * exactly as they would in a real file there.
 */

import { ESLint, Linter } from 'eslint';
import tseslint from 'typescript-eslint';
import { describe, expect, it } from 'vitest';

const BOUNDARY_RULES = [
  'no-restricted-imports',
  'no-restricted-properties',
  'no-restricted-syntax',
] as const;

const root = new URL('..', import.meta.url).pathname;
const eslint = new ESLint({ cwd: root });
const linter = new Linter({ configType: 'flat', cwd: root });

async function boundaryErrors(filePath: string, code: string): Promise<string[]> {
  const resolved = (await eslint.calculateConfigForFile(filePath)) as {
    rules?: Record<string, Linter.RuleEntry>;
    plugins?: Record<string, ESLint.Plugin>;
  };
  const rules: Linter.RulesRecord = {};
  for (const [name, entry] of Object.entries(resolved.rules ?? {})) {
    if ((BOUNDARY_RULES as readonly string[]).includes(name) || name.startsWith('local/')) {
      rules[name] = entry;
    }
  }
  const plugins = resolved.plugins?.local ? { local: resolved.plugins.local } : {};
  return linter
    .verify(
      code,
      [{ files: ['**/*.ts'], languageOptions: { parser: tseslint.parser }, plugins, rules }],
      { filename: filePath },
    )
    .map((message) => message.message);
}

const MATH = 'src/math/example.ts';
const MATH_NESTED = 'src/math/nested/example.ts';
const CONSUMER = 'src/cli/example.ts';
const SRC_ROOT_FILE = 'src/example.ts';
const ADAPTER = 'src/adapters/orca/example.ts';
const TEST = 'tests/example.test.ts';

describe('src/math is pure', () => {
  it.each([
    "import { x } from './errors.js';",
    "import type { QuotePerBase } from './price.js';",
    "export * from './clmm.js';",
  ])('allows %s', async (code) => {
    expect(await boundaryErrors(MATH, code)).toEqual([]);
  });

  it.each([
    "import { readPositions } from '../adapters/orca/index.js';",
    "import { x } from '../positions/reading.js';",
    "import fc from 'fast-check';",
    "import { readFileSync } from 'node:fs';",
    "export * from '../adapters/orca/index.js';",
    // Escapes src/math although it starts with './' (review of #13).
    "import { readPositions } from './../adapters/orca/index.js';",
    "import { x } from './nested/../../positions/reading.js';",
  ])('rejects %s', async (code) => {
    expect(await boundaryErrors(MATH, code)).not.toEqual([]);
  });

  // Destination, not specifier shape: '../' that stays inside src/math is fine.
  it.each([
    "import { quotePerBase } from '../price.js';",
    "import { x } from './helper.js';",
    "import { x } from '../../math/clmm.js';",
  ])(`allows in ${MATH_NESTED}: %s`, async (code) => {
    expect(await boundaryErrors(MATH_NESTED, code)).toEqual([]);
  });

  it.each(["import { x } from '../../adapters/orca/index.js';", "import fc from 'fast-check';"])(
    `rejects in ${MATH_NESTED}: %s`,
    async (code) => {
      expect(await boundaryErrors(MATH_NESTED, code)).not.toEqual([]);
    },
  );
});

describe('signing and transaction-construction APIs are banned everywhere', () => {
  const banned = [
    "import { Keypair } from '@solana/web3.js';",
    "import type { Transaction } from '@solana/web3.js';",
    "import { sendAndConfirmTransaction } from '@solana/web3.js';",
    "import * as web3 from '@solana/web3.js';",
    "import { createKeyPairSignerFromBytes } from '@solana/kit';",
    "import { signTransactionMessageWithSigners } from '@solana/kit';",
    "import { sendAndConfirmTransactionFactory } from '@solana/kit';",
    "import { signTransaction } from '@solana/transactions';",
    "import { openPositionInstructions } from '@orca-so/whirlpools';",
    "import { harvestPositionInstructions } from '@orca-so/whirlpools';",
    "export { swapInstructions } from '@orca-so/whirlpools';",
    'rpc.sendTransaction(tx);',
    'const { sendRawTransaction } = connection;',
    'wallet.signTransaction(tx);',
  ];

  for (const path of [MATH, CONSUMER, ADAPTER, TEST]) {
    it.each(banned)(`rejects in ${path}: %s`, async (code) => {
      expect(await boundaryErrors(path, code)).not.toEqual([]);
    });
  }

  // Read-side APIs #5 and #10 need must stay allowed.
  it.each([
    "import { Connection, PublicKey } from '@solana/web3.js';",
    "import type { VersionedTransactionResponse } from '@solana/web3.js';",
    "import { createSolanaRpc, address } from '@solana/kit';",
    "import type { Signature } from '@solana/keys';",
    "import { fetchPositionsForOwner } from '@orca-so/whirlpools';",
    "import { decreaseLiquidityQuote, collectFeesQuote } from '@orca-so/whirlpools-core';",
    "import { getPositionDecoder } from '@orca-so/whirlpools-client';",
    'await rpc.getMultipleAccounts(addresses).send();',
  ])(`allows in ${ADAPTER}: %s`, async (code) => {
    expect(await boundaryErrors(ADAPTER, code)).toEqual([]);
  });
});

describe('consumers reach adapters only through their index', () => {
  it.each([
    "import { readPositions } from '../adapters/orca/index.js';",
    "import type { PositionReading } from '../positions/reading.js';",
    "import { readPositions } from '../adapters/orca/sub/../index.js';",
  ])('allows %s', async (code) => {
    expect(await boundaryErrors(CONSUMER, code)).toEqual([]);
  });

  it.each([
    "import { decodePosition } from '../adapters/orca/decode.js';",
    "import type { OrcaPosition } from '../adapters/orca/internal/types.js';",
    "export { toModelLiquidity } from '../adapters/orca/liquidity.js';",
    "import { decodePosition } from './../adapters/orca/decode.js';",
    "import { decodePosition } from '../adapters/./orca/decode.js';",
  ])('rejects %s', async (code) => {
    expect(await boundaryErrors(CONSUMER, code)).not.toEqual([]);
  });

  // './adapters/…' reaches an adapter only from a file directly in src/; from
  // src/cli/ it resolves to src/cli/adapters/…, which is not an adapter.
  it('allows the index from a file directly in src/', async () => {
    const code = "import { readPositions } from './adapters/orca/index.js';";
    expect(await boundaryErrors(SRC_ROOT_FILE, code)).toEqual([]);
  });

  it('rejects internals from a file directly in src/', async () => {
    const code = "import { decodePosition } from './adapters/orca/decode.js';";
    expect(await boundaryErrors(SRC_ROOT_FILE, code)).not.toEqual([]);
  });

  it('does not mistake a same-named folder elsewhere for an adapter', async () => {
    const code = "import { x } from './adapters/orca/decode.js';";
    expect(await boundaryErrors(CONSUMER, code)).toEqual([]);
  });

  it('lets an adapter import its own internals', async () => {
    expect(await boundaryErrors(ADAPTER, "import { decode } from './decode.js';")).toEqual([]);
  });

  it('lets tests import adapter internals', async () => {
    const code = "import { decode } from '../src/adapters/orca/decode.js';";
    expect(await boundaryErrors(TEST, code)).toEqual([]);
  });
});

describe('dynamic import() in src', () => {
  it.each([MATH, CONSUMER, ADAPTER])('is rejected in %s', async (path) => {
    expect(await boundaryErrors(path, "await import('@solana/web3.js');")).not.toEqual([]);
  });
});
