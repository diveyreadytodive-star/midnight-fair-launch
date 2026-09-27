import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { validFullPreprodEvidence, validLocalEvidence } from './onchain-demo.js';

const local = JSON.parse(readFileSync(new URL('./fair-launch-evidence.json', import.meta.url), 'utf8'));
const preprodSetup = JSON.parse(readFileSync(new URL('./preprod-launch-evidence.json', import.meta.url), 'utf8'));

test('the complete Local Devnet record is accepted, but a missing bid receipt is not', () => {
  assert.equal(validLocalEvidence(local), true);
  const incomplete = structuredClone(local);
  incomplete.receipts.splice(incomplete.receipts.findIndex((receipt) => receipt.stage === 'register-bid-2'), 1);
  assert.equal(validLocalEvidence(incomplete), false);
});

test('three Preprod setup receipts cannot be promoted to a completed auction', () => {
  assert.equal(validFullPreprodEvidence(preprodSetup, preprodSetup), false);
});
