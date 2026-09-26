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
const compactCli = resolve(projectDir, '.tools/compact');
const cachedCompiler = platform
  ? resolve(projectDir, '.tools/compact-cache/versions/0.31.1', platform, 'compactc.bin')
  : undefined;
const compiler = process.env.COMPACTC?.trim() ||
  (cachedCompiler && existsSync(cachedCompiler) ? cachedCompiler : undefined) ||
  (existsSync(compactCli) ? compactCli : undefined) ||
  'compact';
const compilerName = compiler.split('/').at(-1);
const isCli = compilerName === 'compact';
const nativeDir = isCli ? undefined : dirname(compiler);
const output = resolve(spikeDir, 'generated/fair_launch');
mkdirSync(dirname(output), { recursive: true });

const args = isCli
  ? ['compile', 'contracts/fair_launch.compact', output]
  : ['contracts/fair_launch.compact', output];
const result = spawnSync(compiler, args, {
  cwd: spikeDir,
  stdio: 'inherit',
  env: {
    ...process.env,
    PATH: nativeDir ? [nativeDir, process.env.PATH ?? ''].join(delimiter) : process.env.PATH,
  },
});
if (result.error) console.error(`Compact compiler unavailable: ${result.error.message}`);
process.exit(result.status ?? 1);
