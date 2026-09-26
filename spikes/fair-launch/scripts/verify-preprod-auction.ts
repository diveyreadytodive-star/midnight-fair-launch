import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { WebSocket } from 'ws';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import * as contract from '../generated/fair_launch/contract/index.js';

Reflect.set(globalThis as object, 'WebSocket', WebSocket);
setNetworkId('preprod');

const INDEXER = 'https://indexer.preprod.midnight.network/api/v4/graphql';
const INDEXER_WS = 'wss://indexer.preprod.midnight.network/api/v4/graphql/ws';
const stages = [
  ...Array.from({ length: 4 }, (_, slot) => [`mint-payment-${slot}`, `register-bid-${slot}`]).flat(),
  'settle-four-bids',
  ...Array.from({ length: 4 }, (_, slot) => `claim-refund-${slot}`),
  'claim-proceeds-0', 'claim-proceeds-1', 'claim-tokens-0', 'claim-tokens-1',
];
type Receipt = { txId: string; transactionHash: string; blockHeight: number; entryPoint: string };
type Setup = { network: 'preprod'; contractAddress: string; sourceHash: string; metadataCommitmentHex: string;
  config: { inventoryAtoms: string; reservePriceAtoms: string; depositLotAtoms: string; commitWindowSeconds: number };
  commitDeadline: string; openDeadline: string };
type AuctionEvidence = {
  network: 'preprod'; testAssetsOnly: true; operatorSignedAllActions: true;
  contractAddress: string; sourceHash: string;
  fixture: { inventoryAtoms: string; depositLotAtoms: string; registeredBidCount: number; clearingPriceAtoms: string;
    allocationsAtoms: string[]; refundsAtoms: string[]; totalDepositedAtoms: string; totalProceedsAtoms: string;
    finalPaymentWalletAtoms: string; finalSaleWalletAtoms: string };
  readback: { settled: boolean; cancelled: boolean; refundClaimed: boolean[]; proceedsClaimed: boolean[]; tokenClaimed: boolean[] };
  receipts: Record<string, Receipt>;
};

function entryPoint(stage: string): string {
  if (stage.startsWith('mint-payment-')) return 'mintTestPaymentCoin';
  if (stage.startsWith('register-bid-')) return 'registerBid';
  if (stage === 'settle-four-bids') return 'settle';
  if (stage.startsWith('claim-refund-')) return 'claimRefund';
  if (stage.startsWith('claim-proceeds-')) return 'claimProceeds';
  if (stage.startsWith('claim-tokens-')) return 'claimTokens';
  throw new Error('Unknown Preprod auction stage.');
}

async function verifyReceipt(stage: string, receipt: Receipt, address: string): Promise<void> {
  assert.match(receipt.txId, /^[0-9a-f]{66}$/i);
  assert.match(receipt.transactionHash, /^[0-9a-f]{64}$/i);
  assert.equal(receipt.entryPoint, entryPoint(stage));
  assert.ok(Number.isSafeInteger(receipt.blockHeight) && receipt.blockHeight > 0);
  const query = `query VerifyPreprodAuction { transactions(offset: { identifier: "${receipt.txId}" }) { hash block { height } ... on RegularTransaction { transactionResult { status } } contractActions { address ... on ContractCall { entryPoint } } } }`;
  const response = await fetch(INDEXER, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query }), signal: AbortSignal.timeout(20_000) });
  const body = await response.json() as { data?: { transactions?: Array<{ hash: string; block: { height: number };
    transactionResult?: { status: string }; contractActions: Array<{ address: string; entryPoint?: string }> }> }; errors?: unknown[] };
  assert.ok(response.ok && !body.errors?.length, `Indexer query failed for ${stage}.`);
  const transactions = body.data?.transactions;
  assert.ok(Array.isArray(transactions) && transactions.length === 1, `Receipt missing for ${stage}.`);
  const tx = transactions[0];
  assert.equal(tx.hash, receipt.transactionHash, `${stage} hash mismatch.`);
  assert.equal(tx.block.height, receipt.blockHeight, `${stage} block mismatch.`);
  assert.equal(tx.transactionResult?.status, 'SUCCESS', `${stage} did not succeed.`);
  assert.ok(tx.contractActions.some((action) => action.address === address && action.entryPoint === receipt.entryPoint),
    `${stage} lacks its expected contract call.`);
}

async function main(): Promise<void> {
  assert.equal(process.argv.length, 4,
    'Usage: node --import tsx verify-preprod-auction.ts <setup-public-evidence.json> <auction-public-evidence.json>');
  const setup = JSON.parse(await readFile(resolve(process.argv[2]), 'utf8')) as Setup;
  const auction = JSON.parse(await readFile(resolve(process.argv[3]), 'utf8')) as AuctionEvidence;
  assert.equal(setup.network, 'preprod');
  assert.equal(auction.network, 'preprod');
  assert.equal(auction.testAssetsOnly, true);
  assert.equal(auction.operatorSignedAllActions, true);
  assert.match(auction.contractAddress, /^[0-9a-f]{64}$/i);
  assert.equal(auction.contractAddress, setup.contractAddress);
  assert.equal(auction.sourceHash, setup.sourceHash);
  assert.equal(setup.config.commitWindowSeconds, 10_800);
  const sourceHash = createHash('sha256').update(await readFile(resolve('spikes/fair-launch/contracts/fair_launch.compact'))).digest('hex');
  assert.equal(auction.sourceHash, sourceHash);
  assert.deepEqual(Object.keys(auction.receipts).sort(), [...stages].sort(), 'The complete 17-call auction is required.');
  assert.deepEqual(auction.fixture.allocationsAtoms, ['300', '300', '0', '0']);
  assert.deepEqual(auction.fixture.refundsAtoms, ['2000', '2000', '5000', '5000']);
  assert.equal(auction.fixture.inventoryAtoms, setup.config.inventoryAtoms);
  assert.equal(auction.fixture.depositLotAtoms, setup.config.depositLotAtoms);
  assert.equal(auction.fixture.registeredBidCount, 4);
  assert.equal(auction.fixture.clearingPriceAtoms, '10');
  assert.equal(auction.fixture.totalDepositedAtoms, '20000');
  assert.equal(auction.fixture.totalProceedsAtoms, '6000');
  assert.equal(auction.fixture.finalPaymentWalletAtoms, '20000');
  assert.equal(auction.fixture.finalSaleWalletAtoms, '600');
  assert.equal(auction.readback.settled, true);
  assert.equal(auction.readback.cancelled, false);
  assert.deepEqual(auction.readback.refundClaimed, [true, true, true, true]);
  assert.deepEqual(auction.readback.proceedsClaimed, [true, true, false, false]);
  assert.deepEqual(auction.readback.tokenClaimed, [true, true, false, false]);

  let previousBlock = 0;
  for (const stage of stages) {
    const receipt = auction.receipts[stage];
    assert.ok(receipt.blockHeight >= previousBlock, 'Transaction order changed.');
    await verifyReceipt(stage, receipt, auction.contractAddress);
    previousBlock = receipt.blockHeight;
  }
  const provider = indexerPublicDataProvider(INDEXER, INDEXER_WS);
  const state = await provider.queryContractState(auction.contractAddress as never);
  assert.ok(state, 'Preprod auction contract state is unavailable.');
  const ledger = contract.ledger(((state as { data?: unknown }).data ?? state) as never);
  assert.equal(Buffer.from(ledger.networkDomain).toString('hex'), setup.metadataCommitmentHex);
  assert.equal(ledger.saleInventoryFunded, true);
  assert.equal(ledger.saleInventory, BigInt(setup.config.inventoryAtoms));
  assert.equal(ledger.reservePrice, BigInt(setup.config.reservePriceAtoms));
  assert.equal(ledger.depositLot, BigInt(setup.config.depositLotAtoms));
  assert.equal(ledger.commitDeadline, BigInt(setup.commitDeadline));
  assert.equal(ledger.openDeadline, BigInt(setup.openDeadline));
  assert.equal(ledger.registeredBidCount, 4n);
  assert.equal(ledger.settled, true);
  assert.equal(ledger.cancelled, false);
  assert.equal(ledger.clearingPrice, 10n);
  const allocations = [ledger.allocated0, ledger.allocated1, ledger.allocated2, ledger.allocated3];
  const refunds = [ledger.refund0, ledger.refund1, ledger.refund2, ledger.refund3];
  assert.deepEqual(allocations.map(String), auction.fixture.allocationsAtoms);
  assert.deepEqual(refunds.map(String), auction.fixture.refundsAtoms);
  assert.equal(refunds.reduce((sum, value) => sum + value, 0n) + ledger.clearingPrice * ledger.saleInventory, 20_000n);
  assert.deepEqual([ledger.refundClaimed0, ledger.refundClaimed1, ledger.refundClaimed2, ledger.refundClaimed3], [true, true, true, true]);
  assert.deepEqual([ledger.proceedsClaimed0, ledger.proceedsClaimed1, ledger.proceedsClaimed2, ledger.proceedsClaimed3], [true, true, false, false]);
  assert.deepEqual([ledger.tokenClaimed0, ledger.tokenClaimed1, ledger.tokenClaimed2, ledger.tokenClaimed3], [true, true, false, false]);
  assert.equal(ledger.inventoryRemainderAvailable, false);
  process.stdout.write(JSON.stringify({ status: 'independently-verified-preprod-four-slot-auction',
    contractAddress: auction.contractAddress, receiptCount: stages.length, lastBlock: previousBlock,
    clearingPriceAtoms: String(ledger.clearingPrice), allocationsAtoms: allocations.map(String), refundsAtoms: refunds.map(String) }) + '\n');
}

main().catch((error: unknown) => {
  process.stderr.write(`Preprod auction verification failed: ${error instanceof Error ? error.message : 'Unknown error'}\n`);
  process.exitCode = 1;
});
