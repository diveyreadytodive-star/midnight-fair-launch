import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { WebSocket } from 'ws';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import { fairLaunchMetadataCommitment, validateFairLaunchCreateRequest } from '../../../src/api/fair-launch-create.ts';
import * as contract from '../generated/fair_launch/contract/index.js';

Reflect.set(globalThis as object, 'WebSocket', WebSocket);
setNetworkId('preprod');

const INDEXER = 'https://indexer.preprod.midnight.network/api/v4/graphql';
const INDEXER_WS = 'wss://indexer.preprod.midnight.network/api/v4/graphql/ws';
const RPC = 'https://rpc.preprod.midnight.network';

type Receipt = { txId: string; transactionHash: string; blockHeight: number; entryPoint: string };
type Evidence = {
  network: 'preprod'; testAssetsOnly: true; operatorSignedCreate: true;
  metadata: { name: string; ticker: string; imageUrl: string | null; description: string };
  config: { inventoryAtoms: string; reservePriceAtoms: string; depositLotAtoms: string; commitWindowSeconds: number; openWindowSeconds: number };
  metadataCommitmentHex: string; sourceHash: string; contractAddress: string;
  commitDeadline: string; openDeadline: string;
  receipts: { deploy: Receipt; mint: Receipt; fund: Receipt };
};

async function postGraphql(query: string): Promise<{ data?: { transactions?: Array<{
  hash: string; block: { height: number }; transactionResult?: { status: string };
  contractActions: Array<{ __typename: string; address: string; entryPoint?: string }>;
}> }; errors?: unknown[] }> {
  const response = await fetch(INDEXER, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query }), signal: AbortSignal.timeout(20_000) });
  const result = await response.json() as Awaited<ReturnType<typeof postGraphql>>;
  assert.ok(response.ok && !result.errors?.length, 'Preprod indexer rejected a receipt query.');
  return result;
}

async function verifyReceipt(receipt: Receipt, address: string, circuit: 'deploy' | 'mintTestSaleCoin' | 'fundSaleInventory'): Promise<void> {
  assert.match(receipt.txId, /^[0-9a-f]{66}$/i);
  assert.match(receipt.transactionHash, /^[0-9a-f]{64}$/i);
  assert.equal(receipt.entryPoint, circuit);
  assert.ok(Number.isSafeInteger(receipt.blockHeight) && receipt.blockHeight > 0);
  const query = `query VerifyFairLaunchReceipt { transactions(offset: { identifier: "${receipt.txId}" }) { hash block { height } ... on RegularTransaction { transactionResult { status } } contractActions { __typename address ... on ContractCall { entryPoint } } } }`;
  const result = await postGraphql(query);
  const transactions = result.data?.transactions;
  assert.ok(Array.isArray(transactions) && transactions.length === 1, 'Receipt is missing or ambiguous on Preprod.');
  const transaction = transactions[0];
  assert.equal(transaction.hash, receipt.transactionHash, 'Receipt hash changed.');
  assert.equal(transaction.block.height, receipt.blockHeight, 'Receipt block changed.');
  assert.equal(transaction.transactionResult?.status, 'SUCCESS', 'Receipt did not succeed.');
  assert.ok(transaction.contractActions.some((action) => action.address === address &&
    (circuit === 'deploy' ? action.__typename === 'ContractDeploy' : action.__typename === 'ContractCall' && action.entryPoint === circuit)),
  `Receipt does not contain ${circuit} on the expected contract.`);
}

async function main(): Promise<void> {
  assert.equal(process.argv.length, 3, 'Usage: node --import tsx verify-preprod-launch.ts <confirmed-public-evidence.json>');
  const evidence = JSON.parse(await readFile(resolve(process.argv[2]), 'utf8')) as Evidence;
  assert.equal(evidence.network, 'preprod');
  assert.equal(evidence.testAssetsOnly, true);
  assert.equal(evidence.operatorSignedCreate, true);
  assert.match(evidence.contractAddress, /^[0-9a-f]{64}$/i);
  assert.match(evidence.metadataCommitmentHex, /^[0-9a-f]{64}$/i);
  assert.match(evidence.sourceHash, /^[0-9a-f]{64}$/i);
  const request = validateFairLaunchCreateRequest({ metadata: evidence.metadata, config: evidence.config });
  assert.equal(fairLaunchMetadataCommitment(request), evidence.metadataCommitmentHex);
  const localSourceHash = createHash('sha256').update(await readFile(resolve('spikes/fair-launch/contracts/fair_launch.compact'))).digest('hex');
  assert.equal(localSourceHash, evidence.sourceHash, 'The local Compact source does not match the deployed evidence.');
  assert.ok(BigInt(evidence.commitDeadline) < BigInt(evidence.openDeadline));

  const networkResponse = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'system_chain', params: [], id: 1 }), signal: AbortSignal.timeout(15_000) });
  const network = await networkResponse.json() as { result?: string };
  assert.ok(networkResponse.ok && network.result === 'Midnight Preprod', 'RPC network mismatch.');

  await verifyReceipt(evidence.receipts.deploy, evidence.contractAddress, 'deploy');
  await verifyReceipt(evidence.receipts.mint, evidence.contractAddress, 'mintTestSaleCoin');
  await verifyReceipt(evidence.receipts.fund, evidence.contractAddress, 'fundSaleInventory');
  assert.ok(evidence.receipts.deploy.blockHeight <= evidence.receipts.mint.blockHeight &&
    evidence.receipts.mint.blockHeight <= evidence.receipts.fund.blockHeight, 'Setup receipt order is invalid.');

  const provider = indexerPublicDataProvider(INDEXER, INDEXER_WS);
  const state = await provider.queryContractState(evidence.contractAddress as never);
  assert.ok(state, 'Funded contract state is missing from Preprod.');
  const ledger = contract.ledger(((state as { data?: unknown }).data ?? state) as never);
  assert.equal(ledger.saleInventoryMinted, true);
  assert.equal(ledger.saleInventoryFunded, true);
  assert.equal(ledger.saleInventory, BigInt(request.config.inventoryAtoms));
  assert.equal(ledger.reservePrice, BigInt(request.config.reservePriceAtoms));
  assert.equal(ledger.depositLot, BigInt(request.config.depositLotAtoms));
  assert.equal(ledger.commitDeadline, BigInt(evidence.commitDeadline));
  assert.equal(ledger.openDeadline, BigInt(evidence.openDeadline));
  assert.equal(Buffer.from(ledger.networkDomain).toString('hex'), evidence.metadataCommitmentHex);
  assert.ok(ledger.registeredBidCount >= 0n && ledger.registeredBidCount <= 4n);
  process.stdout.write(JSON.stringify({ status: 'independently-verified-preprod-launch',
    contractAddress: evidence.contractAddress, receipts: Object.fromEntries(Object.entries(evidence.receipts).map(([stage, value]) => [stage, value.transactionHash])),
    registeredBidCount: String(ledger.registeredBidCount), commitDeadline: String(ledger.commitDeadline),
    openDeadline: String(ledger.openDeadline), settled: ledger.settled, cancelled: ledger.cancelled }) + '\n');
}

main().catch((error: unknown) => {
  process.stderr.write(`Preprod launch verification failed: ${error instanceof Error ? error.message : 'Unknown error'}\n`);
  process.exitCode = 1;
});
