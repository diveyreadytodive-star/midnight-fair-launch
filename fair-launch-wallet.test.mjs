import assert from 'node:assert/strict';
import test from 'node:test';
import { compatibleWallets, dustLabel } from './fair-launch-wallet.js';

test('only recognized API v4 wallet providers are offered', () => {
  const connect = async () => ({});
  const found = compatibleWallets({ mnLace: { name: 'Lace', apiVersion: '4.0.1', connect }, fake: { name: 'Unknown', apiVersion: '4.0.1', connect }, oldLace: { name: 'Lace', apiVersion: '3.0.0', connect } });
  assert.equal(found.length, 1);
  assert.equal(found[0].key, 'mnLace');
});

test('DUST display uses exact integer units', () => {
  assert.equal(dustLabel(1_000_000_000_000_000n), '1 tDUST');
  assert.equal(dustLabel(1_500_000_000_000_000n), '1.5 tDUST');
  assert.throws(() => dustLabel(-1n), RangeError);
});
