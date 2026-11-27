#!/usr/bin/env node
/**
 * Fails if a position fixture is staged, tracked, or anywhere in the history
 * being checked. Real position fixtures are private position data (AGENTS.md)
 * and must never reach the repository; `pnpm record-fixture` writes them
 * outside it. This is the backstop for a fixture copied in by hand or added
 * with `git add -f`.
 *
 * Usage: node scripts/check-no-fixtures.mjs <staged|tree|history> [rev-range]
 */

import { execFileSync } from 'node:child_process';

/** Paths that may hold recorded chain traffic. */
export const FORBIDDEN = [/^tests\/fixtures\//, /(^|\/)[^/]*fixture[^/]*\.json$/i];

const git = (...args) =>
  execFileSync('git', args, { encoding: 'utf8' })
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

const mode = process.argv[2];
const range = process.argv[3] ?? 'HEAD';
const paths = {
  staged: () => git('diff', '--cached', '--name-only', '--diff-filter=ACMR'),
  tree: () => git('ls-files'),
  history: () => git('log', '--format=', '--name-only', '--diff-filter=ACMR', range),
}[mode];

if (paths === undefined) {
  process.stderr.write('usage: check-no-fixtures.mjs <staged|tree|history> [rev-range]\n');
  process.exit(2);
}

const found = [...new Set(paths().filter((p) => FORBIDDEN.some((re) => re.test(p))))];
if (found.length > 0) {
  process.stderr.write(
    `Position fixtures must never be committed (AGENTS.md, "No private position data"):\n${found
      .map((p) => `  ${p}`)
      .join('\n')}\nRemove them from the index and history before pushing.\n`,
  );
  process.exit(1);
}
