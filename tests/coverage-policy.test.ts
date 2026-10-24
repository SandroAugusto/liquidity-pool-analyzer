/**
 * Guards the coverage policy (ADR-0003) against the two ways it can silently
 * stop applying:
 *
 * - A new directory under `src/` without its own glob threshold would only be
 *   held to the global backstop, averaged together with everything else.
 * - A global threshold above a per-directory floor would override that floor,
 *   because Vitest counts glob-matched files towards the global figure too.
 *
 * A glob that matches nothing passes Vitest's check vacuously, so a typo in a
 * glob is caught here as "directory without a threshold", not by Vitest.
 */

import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { coverageThresholds } from '../vitest.config.js';

const METRICS = ['lines', 'functions', 'branches', 'statements'] as const;

const srcDir = fileURLToPath(new URL('../src/', import.meta.url));

const directoryGlobs = Object.entries(coverageThresholds).filter(
  (entry): entry is [string, Record<(typeof METRICS)[number], number>] =>
    typeof entry[1] === 'object',
);

describe('coverage policy (ADR-0003)', () => {
  it('has a glob threshold for every directory under src/', () => {
    const directories = readdirSync(srcDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => `src/${entry.name}/**`);
    const globs = directoryGlobs.map(([glob]) => glob);

    expect(directories.length).toBeGreaterThan(0);
    for (const directory of directories) {
      expect(globs, `${directory} has no coverage threshold`).toContain(directory);
    }
  });

  it('keeps the global backstop at or below every per-directory floor', () => {
    expect(directoryGlobs.length).toBeGreaterThan(0);
    for (const [glob, floors] of directoryGlobs) {
      for (const metric of METRICS) {
        expect(coverageThresholds[metric], `global ${metric} exceeds ${glob}`).toBeLessThanOrEqual(
          floors[metric],
        );
      }
    }
  });
});
