import { defineConfig } from 'vitest/config';

// Coverage policy: ADR-0003. Each directory under `src/` has its own floor; the
// global threshold is only a backstop and is kept at the lowest per-directory
// floor, because Vitest counts glob-matched files towards the global figure too
// and a higher global value would override the per-directory policy.
// tests/coverage-policy.test.ts fails if a directory under `src/` has no entry.
export const coverageThresholds = {
  lines: 80,
  functions: 80,
  branches: 75,
  statements: 80,
  'src/math/**': { lines: 95, functions: 95, branches: 95, statements: 95 },
  'src/adapters/**': { lines: 80, functions: 80, branches: 75, statements: 80 },
  'src/positions/**': { lines: 95, functions: 95, branches: 95, statements: 95 },
  'src/cli/**': { lines: 90, functions: 90, branches: 85, statements: 90 },
  'src/research/**': { lines: 95, functions: 95, branches: 90, statements: 95 },
};

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      reporter: ['text', 'lcov'],
      thresholds: coverageThresholds,
    },
  },
});
