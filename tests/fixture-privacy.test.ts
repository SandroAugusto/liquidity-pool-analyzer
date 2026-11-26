/**
 * Real position fixtures are private position data (AGENTS.md) and must never be
 * committed. These tests prove each line of defence works: the path is ignored,
 * and the guard script rejects a fixture that is staged anyway.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '..');
const SCRIPT = join(ROOT, 'scripts/check-no-fixtures.mjs');

function sandbox(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lpa-privacy-'));
  const git = (...args: string[]): void => {
    execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  };
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');
  writeFileSync(join(dir, 'README.md'), 'x\n');
  git('add', 'README.md');
  git('commit', '-qm', 'init');
  return dir;
}

function guard(dir: string, mode: string): number | null {
  return spawnSync('node', [SCRIPT, mode], { cwd: dir, encoding: 'utf8' }).status;
}

describe('position fixtures never reach the repository', () => {
  it.each(['tests/fixtures/orca/live.json', 'tests/fixtures/anything.json', 'wbtc.fixture.json'])(
    '.gitignore covers %s',
    (path) => {
      const result = spawnSync('git', ['check-ignore', '-q', path], { cwd: ROOT });
      expect(result.status).toBe(0);
    },
  );

  it('the guard passes a clean index and rejects a force-added fixture', () => {
    const dir = sandbox();
    expect(guard(dir, 'staged')).toBe(0);

    mkdirSync(join(dir, 'tests/fixtures/orca'), { recursive: true });
    writeFileSync(join(dir, 'tests/fixtures/orca/live.json'), '{}\n');
    execFileSync('git', ['add', '-f', 'tests/fixtures/orca/live.json'], { cwd: dir });

    expect(guard(dir, 'staged')).toBe(1);
  });

  it('the guard finds a fixture committed and then deleted, in history', () => {
    const dir = sandbox();
    const git = (...args: string[]): void => {
      execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
    };
    writeFileSync(join(dir, 'live.fixture.json'), '{}\n');
    git('add', '-f', 'live.fixture.json');
    git('commit', '-qm', 'oops');
    git('rm', '-q', 'live.fixture.json');
    git('commit', '-qm', 'remove');

    expect(guard(dir, 'tree')).toBe(0);
    expect(guard(dir, 'history')).toBe(1);
  });

  it('the guard passes this repository as it stands', () => {
    expect(guard(ROOT, 'tree')).toBe(0);
  });
});
