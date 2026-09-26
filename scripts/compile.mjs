import { existsSync, mkdirSync } from 'node:fs';
import { delimiter, dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

// The direct native-binary launch pattern is adapted from the sibling
// BlindAid compile script (scripts/compile.mjs) to support paths containing
// spaces. The SILENCE contract, output path, and lifecycle are independent.
const version = '0.31.1';
const platform = process.platform === 'darwin'
  ? (process.arch === 'arm64' ? 'aarch64-darwin' : 'x86_64-darwin')
  : process.platform === 'linux'
    ? (process.arch === 'arm64' ? 'aarch64-linux' : 'x86_64-linux')
    : null;
const candidates = [
  process.env.COMPACTC?.trim(),
  platform ? resolve('.tools/compact-cache/versions', version, platform, 'compactc.bin') : undefined,
].filter(Boolean);
const compiler = candidates.find((candidate) => candidate && existsSync(candidate)) ?? 'compact';
const native = compiler === 'compact' ? undefined : resolve(dirname(compiler));
const output = resolve('contracts/managed/silence');
mkdirSync(dirname(output), { recursive: true });

const args = compiler === 'compact'
  ? ['compile', 'contracts/silence.compact', output]
  : [resolve('contracts/silence.compact'), output];
const result = spawnSync(compiler, args, {
  stdio: 'inherit',
  env: {
    ...process.env,
    PATH: native ? [native, process.env.PATH ?? ''].join(delimiter) : process.env.PATH,
  },
});
if (result.error) {
  console.error('Compact ' + version + ' compiler unavailable: ' + result.error.message + '. Set COMPACTC to its executable.');
}
process.exit(result.status ?? 1);
