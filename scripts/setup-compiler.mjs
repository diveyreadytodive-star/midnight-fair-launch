import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

// The isolated install flow is adapted from blindaid/scripts/setup-compiler.mjs.
// It keeps the same official Compact installer and 0.31.1 pin, with no shared
// cache or state directory.
const toolDir = resolve('.tools');
mkdirSync(toolDir, { recursive: true });
const compact = resolve(toolDir, 'compact');
if (!existsSync(compact)) {
  const url = 'https://github.com/midnightntwrk/compact/releases/download/compact-v0.5.2/compact-installer.sh';
  const response = await fetch(url);
  if (!response.ok) throw new Error('Official Compact installer download failed (' + response.status + ').');
  const installer = resolve(toolDir, 'compact-installer.sh');
  writeFileSync(installer, await response.text(), { mode: 0o600 });
  const install = spawnSync('sh', [installer], {
    stdio: 'inherit',
    env: {
      ...process.env,
      COMPACT_UNMANAGED_INSTALL: toolDir,
      COMPACT_NO_MODIFY_PATH: '1',
    },
  });
  if (install.status !== 0) process.exit(install.status ?? 1);
}
const update = spawnSync(
  compact,
  ['--directory', resolve(toolDir, 'compact-cache'), 'update', '0.31.1'],
  { stdio: 'inherit' },
);
process.exit(update.status ?? 1);
