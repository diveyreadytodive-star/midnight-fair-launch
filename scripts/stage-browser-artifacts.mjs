import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const source = resolve('spikes/fair-launch/generated/fair_launch');
const destination = resolve('.local/browser-build/zk');
const circuits = ['mintTestPaymentCoin', 'registerBid'];
const extensions = [['keys', 'prover'], ['keys', 'verifier'], ['zkir', 'bzkir']];
const files = [];

for (const [directory, extension] of extensions) {
  await mkdir(resolve(destination, directory), { recursive: true, mode: 0o700 });
  for (const circuit of circuits) {
    const name = `${circuit}.${extension}`;
    const bytes = await readFile(resolve(source, directory, name));
    if (bytes.length === 0) throw new Error(`Empty browser artifact: ${directory}/${name}`);
    await copyFile(resolve(source, directory, name), resolve(destination, directory, name));
    files.push({ path: `${directory}/${name}`, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
  }
}

await writeFile(resolve(destination, 'manifest.json'), JSON.stringify({ network: 'preprod', source: 'local Compact compile', files }, null, 2) + '\n', { mode: 0o600 });
process.stdout.write(JSON.stringify({ destination, files: files.map(({ path, bytes }) => ({ path, bytes })) }) + '\n');
