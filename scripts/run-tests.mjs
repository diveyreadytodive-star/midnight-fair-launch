import { readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

function collect(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return collect(path);
    return /\.(test|spec)\.(ts|js|mjs|cjs)$/.test(entry.name) ? [path] : [];
  });
}

const files = [...collect(resolve('tests')), ...collect(resolve('web'))].sort();
if (files.length === 0) {
  console.error('No test files found under tests/.');
  process.exit(1);
}
const result = spawnSync(process.execPath, ['--import', 'tsx', '--test', ...files], {
  stdio: 'inherit',
});
if (result.error) console.error('Could not start the pinned tsx test runner: ' + result.error.message);
process.exit(result.status ?? 1);
