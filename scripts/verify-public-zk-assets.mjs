import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve('web/zk');
const manifest = JSON.parse(await readFile(resolve(root, 'manifest.json'), 'utf8'));
const evidence = JSON.parse(await readFile(resolve('docs/evidence/preprod-launch-2026-09-27.json'), 'utf8'));
const sourceHash = createHash('sha256').update(await readFile(resolve('spikes/fair-launch/contracts/fair_launch.compact'))).digest('hex');
const expectedPaths = ['keys/mintTestPaymentCoin.prover', 'keys/mintTestPaymentCoin.verifier',
  'keys/registerBid.prover', 'keys/registerBid.verifier',
  'zkir/mintTestPaymentCoin.bzkir', 'zkir/registerBid.bzkir'];

assert.equal(manifest.network, 'preprod');
assert.equal(manifest.sourceHash, sourceHash);
assert.equal(manifest.sourceHash, evidence.sourceHash);
assert.deepEqual(manifest.files.map((file) => file.path).sort(), expectedPaths.sort());
for (const file of manifest.files) {
  const bytes = await readFile(resolve(root, file.path));
  assert.equal(bytes.length, file.bytes, `${file.path} size mismatch`);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), file.sha256, `${file.path} hash mismatch`);
}
process.stdout.write(JSON.stringify({ status: 'public-zk-assets-match-preprod-source', sourceHash, files: manifest.files.length }) + '\n');
