// @ts-check
import path from 'node:path';

import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

// Module boundaries (#11). Lint sees imports and property names, not data flow:
// these rules stop accidents, not a determined bypass (computed property access,
// a variable passed to import()). tests/lint-boundaries.test.ts proves each one
// fires where it should.
//
// - The signing ban (`no-restricted-imports`) is configured once. Flat config
//   does not merge options of the same rule across blocks — a later block
//   replaces an earlier one for overlapping files — so no other block may set
//   `no-restricted-imports` without repeating `signingImportPatterns`.
// - Rules about *where* an import lands (math stays inside, adapters via index)
//   are local rules that resolve the specifier against the importing file. A
//   regex on the specifier text is fooled by `./../x` and misfires on a
//   legitimate `../` from a subfolder (review of #13).

const READ_ONLY = 'The repository is read-only against chains (AGENTS.md; ADR-0002).';

/**
 * Signing, sending and transaction-construction APIs. Names cover both
 * `@solana/web3.js` and `@solana/kit` (and its `@solana/*` subpackages) plus
 * the Whirlpools SDK's position/pool/swap builders; revisit against the SDK
 * actually installed by #5. Quote functions stay allowed: they are pure reads.
 */
const signingImportPatterns = [
  {
    group: ['@solana/*'],
    importNamePattern:
      '^(Keypair|Transaction|VersionedTransaction|TransactionMessage|SystemProgram' +
      '|sendAndConfirm.*|send.*Transaction.*|(sign|partiallySign)[A-Z].*|signAndSend.*' +
      '|.*KeyPairSigner.*|(generate|create)KeyPair.*|createTransactionMessage|compileTransaction)$',
    message: `Signing / transaction-construction API. ${READ_ONLY}`,
  },
  {
    group: ['@orca-so/*'],
    importNamePattern:
      '^(?!.*Quote)(.*Instructions?|swap.*|openPosition.*|openFullRangePosition.*' +
      '|increaseLiquidity.*|decreaseLiquidity.*|closePosition.*|harvest.*|create.*Pool.*' +
      '|send.*|buildTransaction.*)$',
    message: `Whirlpools transaction builder. ${READ_ONLY}`,
  },
];

/**
 * Each import / re-export source in the file, resolved to a path relative to
 * the working directory (POSIX separators), or `null` for a bare specifier.
 */
const importDestinations = Object.freeze({
  /**
   * @param {import('eslint').Rule.RuleContext} context
   * @param {(node: import('estree').Node, destination: string | null) => void} check
   */
  visitors(context, check) {
    return Object.freeze({
      /** @param {import('estree').Node & { source?: import('estree').Literal | null }} node */
      'ImportDeclaration, ExportAllDeclaration, ExportNamedDeclaration'(node) {
        const specifier = node.source?.value;
        if (typeof specifier !== 'string') {
          return;
        }
        const fromDir = path.dirname(path.resolve(context.cwd, context.filename));
        const destination = specifier.startsWith('.')
          ? path.relative(context.cwd, path.resolve(fromDir, specifier)).split(path.sep).join('/')
          : null;
        check(node, destination);
      },
    });
  },
});

const localPlugin = Object.freeze({
  rules: {
    /** `src/math` imports nothing outside itself (ADR-0002: protocol-agnostic core). */
    'math-imports-stay-inside': {
      meta: { type: 'problem', schema: [] },
      /** @param {import('eslint').Rule.RuleContext} context */
      create(context) {
        return importDestinations.visitors(context, (node, destination) => {
          if (destination === null || !destination.startsWith('src/math/')) {
            context.report({
              node,
              message:
                'src/math may import only from within src/math ' +
                '(ADR-0002: protocol-agnostic core).',
            });
          }
        });
      },
    },
    /** Consumers reach an adapter only through its public index (#5, criterion 8). */
    'adapters-via-index': {
      meta: { type: 'problem', schema: [] },
      /** @param {import('eslint').Rule.RuleContext} context */
      create(context) {
        return importDestinations.visitors(context, (node, destination) => {
          const inAdapter = destination?.match(/^src\/adapters\/[^/]+\/(.+)$/);
          if (inAdapter && inAdapter[1] !== 'index.js') {
            context.report({
              node,
              message:
                'Import adapters only through src/adapters/<name>/index.js; consumers ' +
                'depend on the protocol-neutral output, not on adapter internals (#5).',
            });
          }
        });
      },
    },
  },
});

const signingOnly = { patterns: signingImportPatterns };

export default tseslint.config(
  { ignores: ['dist/**', 'coverage/**', 'node_modules/**'] },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/explicit-function-return-type': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-magic-numbers': 'off',
      eqeqeq: ['error', 'always'],
      'no-console': 'error',
      'no-restricted-imports': ['error', signingOnly],
      'no-restricted-properties': [
        'error',
        ...[
          'sendTransaction',
          'sendRawTransaction',
          'sendEncodedTransaction',
          'sendAndConfirmTransaction',
          'signTransaction',
          'signAllTransactions',
        ].map((property) => ({ property, message: READ_ONLY })),
      ],
    },
  },
  {
    files: ['src/**/*.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: 'ImportExpression',
          message: 'No dynamic import() in src: the import-boundary rules cannot see it.',
        },
      ],
    },
  },
  {
    files: ['src/**/*.ts'],
    ignores: ['src/adapters/**', 'src/math/**'],
    plugins: { local: localPlugin },
    rules: { 'local/adapters-via-index': 'error' },
  },
  {
    files: ['src/math/**/*.ts'],
    plugins: { local: localPlugin },
    rules: { 'local/math-imports-stay-inside': 'error' },
  },
  {
    files: ['tests/**/*.ts'],
    rules: {
      '@typescript-eslint/explicit-function-return-type': 'off',
    },
  },
  {
    files: ['eslint.config.js', 'vitest.config.ts', 'commitlint.config.js'],
    ...tseslint.configs.disableTypeChecked,
  },
  prettier,
);
