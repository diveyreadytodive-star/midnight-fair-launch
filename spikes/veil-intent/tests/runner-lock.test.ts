import assert from 'node:assert/strict';
import { lstatSync, mkdtempSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createExclusiveRunnerLock } from '../scripts/runner-lock.ts';

test('runner lock is private and atomic; a second process fails without deleting it', () => {
  const directory = mkdtempSync(join(tmpdir(), 'veil-intent-lock-'));
  const lockPath = join(directory, 'runner.lock');
  try {
    createExclusiveRunnerLock(lockPath, 'test lock\n');
    assert.equal(lstatSync(lockPath).mode & 0o777, 0o600);
    assert.throws(() => createExclusiveRunnerLock(lockPath, 'replacement\n'), (error: unknown) =>
      (error as NodeJS.ErrnoException).code === 'EEXIST');
    assert.equal(lstatSync(lockPath).mode & 0o777, 0o600);
  } finally {
    if (lstatSync(directory).isDirectory()) {
      try { unlinkSync(lockPath); } catch { /* first lock attempt may not have completed */ }
      rmSync(directory, { recursive: true, force: true });
    }
  }
});
