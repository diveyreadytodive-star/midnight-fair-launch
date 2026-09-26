import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  RecoveryStore,
  readRecoveryManifest,
  recoveryFileMode,
  refuseExistingRecovery,
} from './recovery-manifest.js';

const scratch = mkdtempSync(join(tmpdir(), 'silence-recovery-preflight-'));
const directory = join(scratch, 'run');
const marker = (value: string) => new Uint8Array(Buffer.from(value.padEnd(32, '!')));

try {
  const store = RecoveryStore.create(directory, {
    version: 1,
    runId: 'preflight-only',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    phase: 'prepared',
    contractAddress: null,
    contractMaintenanceSigningKey: null,
    ownerSeedHex: Buffer.from(marker('owner-test-only')).toString('hex'),
    operatorSeedHex: Buffer.from(marker('operator-test-only')).toString('hex'),
    privateStoragePassword: 'preflight-test-only-password',
    terms: {
      side: true,
      notionalAtoms: '10',
      entryPriceTicks: '20',
      guardBufferAtoms: '1',
    },
    positionSaltHex: Buffer.from(marker('position-salt')).toString('hex'),
    ownerCloseSecretHex: Buffer.from(marker('owner-close')).toString('hex'),
    operatorCloseSecretHex: Buffer.from(marker('operator-close')).toString('hex'),
    ownerRecipientCoinPublicKeyHex: 'ab'.repeat(32),
    operatorCoinPublicKeyHex: 'cd'.repeat(32),
    recipientSaltHex: Buffer.from(marker('recipient-salt')).toString('hex'),
    mintNonceHex: Buffer.from(marker('mint-nonce')).toString('hex'),
    pendingOperation: null,
    pendingTxId: null,
    receipts: {},
    negativeChecks: [],
  });

  const permissions = recoveryFileMode(directory);
  assert.equal(permissions.directory, 0o700);
  assert.equal(permissions.file, 0o600);
  assert.equal(readRecoveryManifest(directory).phase, 'prepared');
  chmodSync(directory, 0o755);
  assert.throws(() => refuseExistingRecovery(directory), /directory permissions must be owner-only/);
  chmodSync(directory, 0o700);
  chmodSync(join(directory, 'recovery.json'), 0o644);
  assert.throws(() => refuseExistingRecovery(directory), /permissions must be owner read\/write only/);
  chmodSync(join(directory, 'recovery.json'), 0o600);
  assert.throws(() => refuseExistingRecovery(directory), /refusing to start another run/);
  store.beginOperation('preflight-no-transaction');
  assert.equal(readRecoveryManifest(directory).pendingOperation, 'preflight-no-transaction');

  process.stdout.write('PASS: recovery directory is 0700, manifest is 0600, and an existing recovery record blocks a restart; no chain APIs are imported or called.\n');
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
