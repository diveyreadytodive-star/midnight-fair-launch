import assert from 'node:assert/strict';
import test from 'node:test';
import { decryptBidRecovery, encryptBidRecovery, type BidRecovery } from '../../src/browser/bid-backup.js';

const address = 'a'.repeat(64);
const walletCoinPublicKey = 'test-wallet-public-key';
const passphrase = 'judge-recovery-passphrase';
const recovery: BidRecovery = {
  network: 'preprod', contractAddress: address, walletCoinPublicKey, slot: 1, mintTxId: '00' + 'b'.repeat(64),
  opening: { maxPrice: 12n, quantity: 300n,
    refundRecipient: { bytes: new Uint8Array(32).fill(3) },
    tokenRecipient: { bytes: new Uint8Array(32).fill(3) }, salt: new Uint8Array(32).fill(4) },
  paymentCoin: { nonce: new Uint8Array(32).fill(5), color: new Uint8Array(32).fill(6), value: 5000n },
};

test('encrypted bid recovery restores exact opening and coin after a page restart', async () => {
  const serialized = await encryptBidRecovery(recovery, passphrase);
  assert.doesNotMatch(serialized, /"maxPrice"|"paymentCoin"|"nonce"/);
  const restored = await decryptBidRecovery(serialized, passphrase, { contractAddress: address, walletCoinPublicKey });
  assert.deepEqual(restored, recovery);
});

test('wrong passphrase, wrong wallet, and modified public slot cannot reveal a bid', async () => {
  const serialized = await encryptBidRecovery(recovery, passphrase);
  await assert.rejects(decryptBidRecovery(serialized, 'wrong-passphrase-123', { contractAddress: address, walletCoinPublicKey }));
  await assert.rejects(decryptBidRecovery(serialized, passphrase, { contractAddress: address, walletCoinPublicKey: 'other-wallet' }), /does not match/);
  const tampered = JSON.parse(serialized);
  tampered.slot = 2;
  await assert.rejects(decryptBidRecovery(JSON.stringify(tampered), passphrase, { contractAddress: address, walletCoinPublicKey }));
});

test('short passphrase and malformed opening are rejected before export', async () => {
  await assert.rejects(encryptBidRecovery(recovery, 'too-short'), /12 characters/);
  await assert.rejects(encryptBidRecovery({ ...recovery, opening: { ...recovery.opening, salt: new Uint8Array(31) } }, passphrase), /Invalid bid recovery/);
});
