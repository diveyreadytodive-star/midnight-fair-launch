import { chmodSync, closeSync, fsyncSync, openSync, writeFileSync } from 'node:fs';

/** Atomic exclusive creation makes concurrent runners fail closed. Stale locks require manual review. */
export function createExclusiveRunnerLock(path: string, contents: string): void {
  const fd = openSync(path, 'wx', 0o600);
  try {
    writeFileSync(fd, contents, 'utf8');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  chmodSync(path, 0o600);
}
