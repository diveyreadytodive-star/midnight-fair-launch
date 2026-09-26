import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { levelPrivateStateProvider } from '@midnight-ntwrk/midnight-js-level-private-state-provider';
import { sampleContractAddress } from '@midnight-ntwrk/midnight-js-protocol/compact-runtime';

import { stablePrivateStoragePasswordProvider } from '../../src/chain/client.js';

test('private state survives provider recreation with the same caller-supplied password', async () => {
  const stateDirectory = mkdtempSync(join(tmpdir(), 'silence-private-state-restart-'));
  const password = 'Test-Only-Strong-Password-739201!';
  const privateStoragePasswordProvider = stablePrivateStoragePasswordProvider(password);
  const contractAddress = sampleContractAddress();

  const createProvider = () => levelPrivateStateProvider({
    accountId: 'test-account',
    midnightDbName: join(stateDirectory, 'db'),
    privateStateStoreName: 'private-states',
    signingKeyStoreName: 'signing-keys',
    privateStoragePasswordProvider,
  });

  try {
    const first = createProvider();
    first.setContractAddress(contractAddress);
    await first.set('owner-close-capability', {
      closeSecret: new Uint8Array(32).fill(71),
      recipientSalt: new Uint8Array(32).fill(73),
    });

    const reopened = createProvider();
    reopened.setContractAddress(contractAddress);
    const restored = await reopened.get('owner-close-capability');
    assert.ok(restored);
    assert.deepEqual(restored.closeSecret, new Uint8Array(32).fill(71));
    assert.deepEqual(restored.recipientSalt, new Uint8Array(32).fill(73));
    assert.equal(privateStoragePasswordProvider(), privateStoragePasswordProvider());
  } finally {
    rmSync(stateDirectory, { recursive: true, force: true });
  }
});
