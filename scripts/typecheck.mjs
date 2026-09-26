import { readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

function collect(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return collect(path);
    return /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

const roots = ['src', 'scripts', 'tests'].filter((directory) => {
  try {
    readdirSync(resolve(directory));
    return true;
  } catch {
    return false;
  }
});
const files = roots.flatMap((directory) => collect(resolve(directory))).sort();
if (files.length === 0) {
  console.error('No TypeScript files found under src/, scripts/, or tests/.');
  process.exit(1);
}
const result = spawnSync(process.execPath, [
  './node_modules/typescript/bin/tsc',
  '--noEmit',
  '--strict',
  '--target',
  'ES2022',
  '--module',
  'ESNext',
  '--moduleResolution',
  'Bundler',
  '--allowImportingTsExtensions',
  '--skipLibCheck',
  '--types',
  'node',
  ...files,
], { stdio: 'inherit' });
if (result.error) console.error('Could not start the pinned TypeScript compiler: ' + result.error.message);
process.exit(result.status ?? 1);
