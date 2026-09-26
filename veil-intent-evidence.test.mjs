import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const webDir = dirname(fileURLToPath(import.meta.url));
const webEvidence = JSON.parse(readFileSync(resolve(webDir, 'veil-intent-evidence.json'), 'utf8'));
const canonicalEvidence = JSON.parse(readFileSync(
  resolve(webDir, '../spikes/veil-intent/docs/evidence/local-devnet-veil-intent.json'),
  'utf8',
));

test('web demo evidence matches canonical verified receipts and balances', () => {
  assert.equal(webEvidence.contractAddress, canonicalEvidence.contractAddress);
  assert.equal(webEvidence.network, 'Midnight Local Devnet');
  assert.deepEqual(webEvidence.blockRange, { first: 4222, last: 4246 });
  assert.equal(webEvidence.publicEscrowAtoms, canonicalEvidence.expectedVsReadback.publicEscrowAtoms);
  assert.deepEqual(webEvidence.publicQuote, canonicalEvidence.expectedVsReadback.publicQuote);
  assert.deepEqual(webEvidence.finalReadback, {
    intentExecuted: canonicalEvidence.expectedVsReadback.finalIntentExecuted,
    buyerRemainderClaimable: canonicalEvidence.expectedVsReadback.finalBuyerRemainderClaimable,
    sellerShieldedBalanceAtoms: canonicalEvidence.expectedVsReadback.sellerShieldedBalanceAtoms,
    buyerShieldedBalanceAtoms: canonicalEvidence.expectedVsReadback.buyerRemainderBalanceAtoms,
    buyerChangeCoinMtIndexBeforeClaim: canonicalEvidence.expectedVsReadback.buyerChangeCoinMtIndexBeforeClaim,
  });
  assert.deepEqual(webEvidence.receipts, canonicalEvidence.receipts.map(({ stage, txId, transactionHash, blockHeight }) => ({ stage, txId, transactionHash, blockHeight })));
});

test('public demo evidence does not contain exact private maximum fields', () => {
  assert.equal(Object.hasOwn(webEvidence, 'maxTotalSpendAtoms'), false);
  assert.equal(Object.hasOwn(webEvidence, 'maxUnitPriceTicks'), false);
  assert.equal(Object.hasOwn(webEvidence, 'privateMaxBudgetAtoms'), false);
  assert.equal(Object.hasOwn(webEvidence, 'privateMaxUnitPriceTicks'), false);
});
