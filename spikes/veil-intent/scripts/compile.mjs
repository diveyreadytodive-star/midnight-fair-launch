import { existsSync, mkdirSync } from 'node:fs';
import { delimiter, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const spikeDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const projectDir = resolve(spikeDir, '../..');
const platform = process.platform === 'darwin'
  ? (process.arch === 'arm64' ? 'aarch64-darwin' : 'x86_64-darwin')
  : process.platform === 'linux'
    ? (process.arch === 'arm64' ? 'aarch64-linux' : 'x86_64-linux')
    : null;
const cached = platform ? resolve(projectDir, '.tools/compact-cache/versions/0.31.1', platform, 'compactc.bin') : undefined;
const compiler = process.env.COMPACTC?.trim() ||
  (cached && existsSync(cached) ? cached : undefined) ||
  (existsSync(resolve(projectDir, '.tools/compact')) ? resolve(projectDir, '.tools/compact') : undefined) ||
  'compact';
const cli = compiler.split('/').at(-1) === 'compact';
const nativeDir = cli ? undefined : dirname(compiler);
const output = resolve(spikeDir, 'generated/veil_intent');
mkdirSync(dirname(output), { recursive: true });
const result = spawnSync(compiler, cli
  ? ['compile', 'contracts/veil_intent.compact', 'generated/veil_intent']
  : [resolve(spikeDir, 'contracts/veil_intent.compact'), output], {
  cwd: spikeDir,
  stdio: 'inherit',
  env: { ...process.env, PATH: nativeDir ? [nativeDir, process.env.PATH ?? ''].join(delimiter) : process.env.PATH },
});
if (result.error) console.error('Compact 0.31.1 compiler unavailable: ' + result.error.message);
process.exit(result.status ?? 1);
