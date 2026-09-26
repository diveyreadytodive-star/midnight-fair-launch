import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { access, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { WebSocket } from 'ws';
import { createCallTxOptions, submitCallTxAsync } from '@midnight-ntwrk/midnight-js-contracts';
import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { levelPrivateStateProvider } from '@midnight-ntwrk/midnight-js-level-private-state-provider';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import { CompiledContract } from '@midnight-ntwrk/midnight-js-protocol/compact-js';
import { encodeCoinPublicKey, encodeContractAddress } from '@midnight-ntwrk/midnight-js-protocol/compact-runtime';
import { createSilenceWallet } from '../../../src/chain/wallet.js';
import { fairLaunchMetadataCommitment, validateFairLaunchCreateRequest } from '../../../src/api/fair-launch-create.ts';
import * as module from '../generated/fair_launch/contract/index.js';
import type { BidOpening } from '../generated/fair_launch/contract/index.js';

Reflect.set(globalThis as object, 'WebSocket', WebSocket);

const INDEXER = 'https://indexer.preprod.midnight.network/api/v4/graphql';
const INDEXER_WS = 'wss://indexer.preprod.midnight.network/api/v4/graphql/ws';
const RPC = 'wss://rpc.preprod.midnight.network';
const PROVER = 'http://127.0.0.1:26300';
const artifactsDir = resolve('spikes/fair-launch/generated/fair_launch');
const deployRoot = resolve('.local/fair-launch-preprod-deploy');
const recoveryRoot = resolve('.local/fair-launch-preprod-auction');
const runnerLock = resolve(recoveryRoot, 'runner.lock');
const liveJudgeAddress = 'ef7cb50ea29a2ab3501dac80d3fa9f05f570294a2fc0107ad0fc5b76cefe3921';
const bids = [
  { maxPrice: 12n, quantity: 300n }, { maxPrice: 10n, quantity: 500n },
  { maxPrice: 8n, quantity: 400n }, { maxPrice: 8n, quantity: 200n },
] as const;
const expectedAllocations = [300n, 300n, 0n, 0n] as const;
const expectedRefunds = [2_000n, 2_000n, 5_000n, 5_000n] as const;
type Receipt = { txId: string; transactionHash: string; blockHeight: number; entryPoint: string };
type Coin = { nonceHex: string; colorHex: string; valueAtoms: string };
type StoredOpening = { maxPrice: string; quantity: string; recipientHex: string; saltHex: string };
type Evidence = {
  network: 'preprod'; testAssetsOnly: true; operatorSignedCreate: true;
  contractAddress: string; sourceHash: string; metadataCommitmentHex: string;
  metadata: unknown; config: { inventoryAtoms: string; reservePriceAtoms: string; depositLotAtoms: string; commitWindowSeconds: number; openWindowSeconds: number };
  commitDeadline: string; openDeadline: string;
};
type Manifest = {
  version: 1; network: 'preprod'; contractAddress: string; createdAt: string;
  status: 'running' | 'recovery-required' | 'complete'; stage: string;
  failureClass?: string;
  pending?: { stage: string; txId?: string; startedAt: string };
  privateStoragePassword: string; paymentCoins: Array<Coin | null>;
  openings: StoredOpening[]; receipts: Record<string, Receipt>;
};

const execute = process.argv.includes('--execute');
let manifest: Manifest | undefined;
let manifestPath = '';
let stage = 'preflight';

function bytes(hex: string): Uint8Array { return Uint8Array.from(Buffer.from(hex, 'hex')); }
function hex(value: Uint8Array): string { return Buffer.from(value).toString('hex'); }

function asCoin(value: unknown): Coin {
  const coin = value as { nonce?: Uint8Array; color?: Uint8Array; value?: bigint } | undefined;
  assert.ok(coin?.nonce instanceof Uint8Array && coin.color instanceof Uint8Array && typeof coin.value === 'bigint');
  return { nonceHex: hex(coin.nonce), colorHex: hex(coin.color), valueAtoms: String(coin.value) };
}

function opening(stored: StoredOpening): BidOpening {
  const recipient = { bytes: bytes(stored.recipientHex) };
  return { maxPrice: BigInt(stored.maxPrice), quantity: BigInt(stored.quantity),
    refundRecipient: recipient, tokenRecipient: recipient, salt: bytes(stored.saltHex) };
}

async function saveManifest(): Promise<void> {
  assert.ok(manifest && manifestPath);
  const temporary = `${manifestPath}.tmp-${randomUUID()}`;
  await writeFile(temporary, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  await rename(temporary, manifestPath);
}

async function requireAbsent(path: string, message: string): Promise<void> {
  try { await access(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  throw new Error(message);
}

async function discoverDemo(): Promise<{ evidence: Evidence; evidencePath: string; saleColorHex: string }> {
  const paths = await readdir(deployRoot, { withFileTypes: true });
  const matches: Array<{ evidence: Evidence; evidencePath: string; saleColorHex: string }> = [];
  for (const path of paths.filter((item) => item.isDirectory())) {
    const evidencePath = resolve(deployRoot, path.name, 'confirmed-public-evidence.json');
    let evidence: Evidence;
    try { evidence = JSON.parse(await readFile(evidencePath, 'utf8')) as Evidence; }
    catch { continue; }
    if (evidence.network !== 'preprod' || evidence.config?.commitWindowSeconds !== 10_800) continue;
    const protectedState = JSON.parse(await readFile(resolve(dirname(evidencePath), 'recovery.json'), 'utf8')) as {
      status?: string; contractAddress?: string; saleCoin?: Coin;
    };
    assert.equal(protectedState.status, 'complete', '3-hour deployment recovery is incomplete.');
    assert.equal(protectedState.contractAddress, evidence.contractAddress);
    assert.match(protectedState.saleCoin?.colorHex ?? '', /^[0-9a-f]{64}$/i);
    matches.push({ evidence, evidencePath, saleColorHex: protectedState.saleCoin!.colorHex });
  }
  assert.equal(matches.length, 1, 'Exactly one completed 3-hour Preprod launch is required.');
  const selected = matches[0];
  const { evidence } = selected;
  assert.equal(evidence.testAssetsOnly, true);
  assert.equal(evidence.operatorSignedCreate, true);
  assert.match(evidence.contractAddress, /^[0-9a-f]{64}$/i);
  assert.notEqual(evidence.contractAddress, liveJudgeAddress, 'The 24-hour judge contract must retain its empty slots.');
  const request = validateFairLaunchCreateRequest({ metadata: evidence.metadata, config: evidence.config });
  assert.equal(request.config.inventoryAtoms, '600');
  assert.equal(request.config.reservePriceAtoms, '8');
  assert.equal(request.config.depositLotAtoms, '5000');
  assert.equal(request.config.openWindowSeconds, 3600);
  assert.equal(fairLaunchMetadataCommitment(request), evidence.metadataCommitmentHex);
  assert.equal(createHash('sha256').update(await readFile(resolve('spikes/fair-launch/contracts/fair_launch.compact'))).digest('hex'), evidence.sourceHash);
  return selected;
}

async function chainTime(): Promise<bigint> {
  const response = await fetch(INDEXER, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: 'query FairLaunchTime { block { timestamp } }' }), signal: AbortSignal.timeout(20_000) });
  const data = await response.json() as { data?: { block?: { timestamp?: number } }; errors?: unknown[] };
  assert.ok(response.ok && !data.errors?.length && Number.isSafeInteger(data.data?.block?.timestamp));
  return BigInt(Math.floor(data.data!.block!.timestamp! / 1000));
}

async function receipt(provider: ReturnType<typeof indexerPublicDataProvider>, txId: string, entryPoint: string, address: string): Promise<Receipt> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const result = await Promise.race([
    provider.watchForTxData(txId),
    new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Preprod confirmation timeout')), 600_000); }),
  ]).finally(() => { if (timer) clearTimeout(timer); });
  assert.equal(result.status, 'SucceedEntirely');
  assert.equal(typeof result.blockHeight, 'number');
  assert.match(txId, /^[0-9a-f]{66}$/i);
  const query = `query AuctionReceipt { transactions(offset: { identifier: "${txId}" }) { hash block { height } ... on RegularTransaction { transactionResult { status } } contractActions { __typename address ... on ContractCall { entryPoint } } } }`;
  const response = await fetch(INDEXER, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query }), signal: AbortSignal.timeout(20_000) });
  const body = await response.json() as { data?: { transactions?: Array<{ hash: string; block: { height: number }; transactionResult?: { status: string };
    contractActions: Array<{ address: string; entryPoint?: string }> }> }; errors?: unknown[] };
  assert.ok(response.ok && !body.errors?.length);
  const tx = body.data?.transactions?.[0];
  assert.ok(tx && tx.block.height === result.blockHeight && tx.transactionResult?.status === 'SUCCESS');
  assert.ok(tx.contractActions.some((item) => item.address === address && item.entryPoint === entryPoint));
  return { txId, transactionHash: tx.hash, blockHeight: result.blockHeight, entryPoint };
}

function vectors(ledger: ReturnType<typeof module.ledger>) {
  return {
    allocations: [ledger.allocated0, ledger.allocated1, ledger.allocated2, ledger.allocated3],
    refunds: [ledger.refund0, ledger.refund1, ledger.refund2, ledger.refund3],
    slotFunded: [ledger.slot0Funded, ledger.slot1Funded, ledger.slot2Funded, ledger.slot3Funded],
    commitments: [ledger.slot0Commitment, ledger.slot1Commitment, ledger.slot2Commitment, ledger.slot3Commitment],
    refundClaimed: [ledger.refundClaimed0, ledger.refundClaimed1, ledger.refundClaimed2, ledger.refundClaimed3],
    proceedsClaimed: [ledger.proceedsClaimed0, ledger.proceedsClaimed1, ledger.proceedsClaimed2, ledger.proceedsClaimed3],
    tokenClaimed: [ledger.tokenClaimed0, ledger.tokenClaimed1, ledger.tokenClaimed2, ledger.tokenClaimed3],
  };
}

async function main(): Promise<void> {
  if (process.argv.some((item) => item.startsWith('--') && item !== '--execute')) throw new Error('Only --execute is supported.');
  await access(resolve(artifactsDir, 'keys/settle.prover'));
  const prover = await fetch(`${PROVER}/version`, { signal: AbortSignal.timeout(5_000) });
  assert.ok(prover.ok && (await prover.text()).trim());
  const rpcResponse = await fetch('https://rpc.preprod.midnight.network', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'system_chain', params: [], id: 1 }),
    signal: AbortSignal.timeout(15_000),
  });
  const rpcIdentity = await rpcResponse.json() as { result?: string };
  assert.ok(rpcResponse.ok && rpcIdentity.result === 'Midnight Preprod', 'RPC network identity mismatch.');
  const { evidence, saleColorHex } = await discoverDemo();
  const address = evidence.contractAddress;
  const publicDataProvider = indexerPublicDataProvider(INDEXER, INDEXER_WS);
  async function readLedger() {
    const state = await publicDataProvider.queryContractState(address as never);
    assert.ok(state);
    return module.ledger(((state as { data?: unknown }).data ?? state) as never);
  }
  const initial = await readLedger();
  assert.equal(initial.saleInventoryFunded, true);
  assert.equal(initial.registeredBidCount, 0n, 'Another bidder already occupies the demo contract.');
  assert.equal(initial.settled, false);
  assert.equal(initial.cancelled, false);
  assert.equal(hex(initial.networkDomain), evidence.metadataCommitmentHex);
  assert.equal(initial.commitDeadline, BigInt(evidence.commitDeadline));
  assert.equal(initial.openDeadline, BigInt(evidence.openDeadline));
  const remaining = initial.commitDeadline - await chainTime();
  assert.ok(remaining > 2_400n, 'Insufficient chain-time margin to synchronize and register bids.');
  process.stdout.write(JSON.stringify({ mode: execute ? 'execute' : 'preflight', network: 'preprod', contractAddress: address,
    remainingCommitSeconds: String(remaining), sourceHash: evidence.sourceHash }) + '\n');
  if (!execute) return;
  await requireAbsent(runnerLock, 'Existing Preprod auction runner lock requires reconciliation.');
  await requireAbsent(resolve(recoveryRoot, address), 'This Preprod auction already has protected recovery state.');

  const saved = JSON.parse(await readFile(resolve('.local/preprod-dev-wallet.json'), 'utf8')) as {
    network?: unknown; seedHex?: unknown; unshieldedAddress?: unknown;
  };
  assert.equal(saved.network, 'preprod');
  assert.match(String(saved.seedHex ?? ''), /^(?:[0-9a-f]{2}){16,64}$/i);
  const wallet = await createSilenceWallet(saved.seedHex as string, {
    networkId: 'preprod', indexer: INDEXER, indexerWS: INDEXER_WS, node: RPC, proofServer: PROVER,
  });
  try {
    assert.equal(wallet.accountId, saved.unshieldedAddress);
    stage = 'wallet-sync';
    const synced = await wallet.wallet.waitForSyncedState();
    assert.ok(synced.dust.balance(new Date()) > 0n, 'Development wallet has no tDUST.');
    assert.ok(initial.commitDeadline - await chainTime() > 1_200n, 'Commit window too short after wallet sync.');
    assert.equal((await readLedger()).registeredBidCount, 0n);
    assert.equal(synced.shielded.balances[saleColorHex] ?? 0n, 0n, 'Funded sale inventory remains in the wallet.');

    await requireAbsent(runnerLock, 'Another Preprod auction runner started during wallet sync.');
    await requireAbsent(resolve(recoveryRoot, address), 'Recovery state appeared during wallet sync.');

    await mkdir(recoveryRoot, { recursive: true, mode: 0o700 });
    await writeFile(runnerLock, JSON.stringify({ contractAddress: address, startedAt: new Date().toISOString() }) + '\n', { flag: 'wx', mode: 0o600 });
    const runDirectory = resolve(recoveryRoot, address);
    await mkdir(runDirectory, { mode: 0o700 });
    manifestPath = resolve(runDirectory, 'recovery.json');
    const recipientHex = hex(encodeCoinPublicKey(wallet.shieldedSecretKeys.coinPublicKey));
    manifest = {
      version: 1, network: 'preprod', contractAddress: address, createdAt: new Date().toISOString(),
      status: 'running', stage: 'prepared', privateStoragePassword: randomBytes(32).toString('hex'),
      paymentCoins: [null, null, null, null],
      openings: bids.map((bid) => ({ maxPrice: String(bid.maxPrice), quantity: String(bid.quantity), recipientHex,
        saltHex: randomBytes(32).toString('hex') })),
      receipts: {},
    };
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    const zkConfigProvider = new NodeZkConfigProvider(artifactsDir);
    const privateStateProvider = levelPrivateStateProvider({
      accountId: wallet.accountId, midnightDbName: resolve(runDirectory, 'midnight-level-db'),
      privateStateStoreName: 'fair-launch-preprod-auction-private-state',
      signingKeyStoreName: 'fair-launch-preprod-auction-signing-keys',
      privateStoragePasswordProvider: () => manifest!.privateStoragePassword,
    });
    privateStateProvider.setContractAddress(address as never);
    const walletProvider = {
      getCoinPublicKey: () => wallet.shieldedSecretKeys.coinPublicKey,
      getEncryptionPublicKey: () => wallet.shieldedSecretKeys.encryptionPublicKey,
      async balanceTx(tx: unknown, ttl?: Date) {
        const recipe = await wallet.wallet.balanceUnboundTransaction(tx as never,
          { shieldedSecretKeys: wallet.shieldedSecretKeys, dustSecretKey: wallet.dustSecretKey },
          { ttl: ttl ?? new Date(Date.now() + 30 * 60_000), tokenKindsToBalance: 'all' });
        return wallet.wallet.finalizeRecipe(recipe);
      },
      submitTx: (tx: unknown) => wallet.wallet.submitTransaction(tx as never),
    };
    const providers = { privateStateProvider, publicDataProvider, zkConfigProvider,
      proofProvider: httpClientProofProvider(PROVER, zkConfigProvider), walletProvider, midnightProvider: walletProvider };
    const compiled = CompiledContract.make('fair-launch', module.Contract as never).pipe(
      CompiledContract.withWitnesses({ quotientRemainder(context: { readonly privateState: unknown }, numerator: bigint, denominator: bigint) {
        return [context.privateState, { quotient: numerator / denominator, remainder: numerator % denominator }];
      } } as never),
      CompiledContract.withCompiledFileAssets(artifactsDir),
    );

    async function call(name: string, circuit: keyof module.ImpureCircuits<unknown>, args: readonly unknown[]): Promise<unknown> {
      assert.ok(manifest);
      stage = name; manifest.stage = name; manifest.pending = { stage: name, startedAt: new Date().toISOString() }; await saveManifest();
      const options = createCallTxOptions(compiled as never, circuit as never, address as never, undefined, undefined, [...args] as never);
      const submitted = await submitCallTxAsync(providers as never, options as never);
      manifest.pending.txId = submitted.txId; await saveManifest();
      manifest.receipts[name] = await receipt(publicDataProvider, submitted.txId, circuit, address);
      manifest.pending = undefined; await saveManifest();
      return (submitted.callTxData as { private?: { result?: unknown } }).private?.result;
    }

    const contractBytes = encodeContractAddress(address as never);
    let paymentColorHex = '';
    for (let slot = 0; slot < 4; slot += 1) {
      const state = await readLedger();
      assert.equal(state.registeredBidCount, BigInt(slot), 'A registered slot changed unexpectedly.');
      assert.ok(state.commitDeadline - await chainTime() > 60n, 'Commit window expired before all bids.');
      const minted = await call(`mint-payment-${slot}`, 'mintTestPaymentCoin', [5_000n, randomBytes(32)]);
      const coin = asCoin(minted);
      assert.equal(coin.valueAtoms, '5000');
      if (paymentColorHex) assert.equal(coin.colorHex, paymentColorHex); else paymentColorHex = coin.colorHex;
      manifest!.paymentCoins[slot] = coin; await saveManifest();
      const afterMint = await wallet.wallet.waitForSyncedState();
      assert.equal(afterMint.shielded.balances[paymentColorHex] ?? 0n, 5_000n);
      const bidOpening = opening(manifest!.openings[slot]);
      const commitment = module.pureCircuits.computeBidCommitment(state.networkDomain, contractBytes, BigInt(slot), bidOpening);
      await call(`register-bid-${slot}`, 'registerBid', [BigInt(slot), bidOpening,
        { nonce: bytes(coin.nonceHex), color: bytes(coin.colorHex), value: BigInt(coin.valueAtoms) }]);
      const registered = await readLedger();
      assert.equal(registered.registeredBidCount, BigInt(slot + 1));
      assert.equal(vectors(registered).slotFunded[slot], true);
      assert.equal(hex(vectors(registered).commitments[slot]), hex(commitment));
      const afterBid = await wallet.wallet.waitForSyncedState();
      assert.equal(afterBid.shielded.balances[paymentColorHex] ?? 0n, 0n);
    }

    stage = 'await-commit'; manifest!.stage = stage; await saveManifest();
    while (await chainTime() <= initial.commitDeadline) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 15_000));
    }
    assert.ok(await chainTime() < initial.openDeadline - 120n, 'Not enough time remains for settlement.');
    const openings = manifest!.openings.map(opening);
    await call('settle-four-bids', 'settle', [true, 10n, ...expectedAllocations, ...openings]);
    let settled = await readLedger();
    assert.equal(settled.registeredBidCount, 4n);
    assert.equal(settled.settled, true);
    assert.equal(settled.cancelled, false);
    assert.equal(settled.clearingPrice, 10n);
    assert.deepEqual(vectors(settled).allocations, [...expectedAllocations]);
    assert.deepEqual(vectors(settled).refunds, [...expectedRefunds]);
    assert.equal(vectors(settled).refunds.reduce<bigint>((sum, value) => sum + value, 0n) + settled.clearingPrice * settled.saleInventory, 20_000n);

    let refundTotal = 0n;
    for (let slot = 0; slot < 4; slot += 1) {
      await call(`claim-refund-${slot}`, 'claimRefund', [BigInt(slot), openings[slot]]);
      refundTotal += expectedRefunds[slot];
      const state = await wallet.wallet.waitForSyncedState();
      assert.equal(state.shielded.balances[paymentColorHex] ?? 0n, refundTotal);
    }
    let proceedsTotal = refundTotal;
    for (const slot of [0, 1]) {
      await call(`claim-proceeds-${slot}`, 'claimProceeds', [BigInt(slot)]);
      proceedsTotal += 3_000n;
      const state = await wallet.wallet.waitForSyncedState();
      assert.equal(state.shielded.balances[paymentColorHex] ?? 0n, proceedsTotal);
    }
    let claimedSale = 0n;
    for (const slot of [0, 1]) {
      await call(`claim-tokens-${slot}`, 'claimTokens', [BigInt(slot), openings[slot]]);
      claimedSale += expectedAllocations[slot];
      const state = await wallet.wallet.waitForSyncedState();
      assert.equal(state.shielded.balances[saleColorHex] ?? 0n, claimedSale);
    }
    settled = await readLedger();
    const final = vectors(settled);
    assert.deepEqual(final.refundClaimed, [true, true, true, true]);
    assert.deepEqual(final.proceedsClaimed, [true, true, false, false]);
    assert.deepEqual(final.tokenClaimed, [true, true, false, false]);
    assert.equal(settled.inventoryRemainderAvailable, false);
    assert.equal(proceedsTotal, 20_000n);
    assert.equal(claimedSale, 600n);
    const publicEvidence = {
      network: 'preprod', testAssetsOnly: true, operatorSignedAllActions: true,
      contractAddress: address, sourceHash: evidence.sourceHash,
      setupEvidencePath: 'docs/evidence/preprod-launch-3h-setup.json',
      fixture: { inventoryAtoms: '600', depositLotAtoms: '5000', registeredBidCount: 4,
        clearingPriceAtoms: '10', allocationsAtoms: expectedAllocations.map(String),
        refundsAtoms: expectedRefunds.map(String), totalDepositedAtoms: '20000',
        totalProceedsAtoms: '6000', finalPaymentWalletAtoms: String(proceedsTotal), finalSaleWalletAtoms: String(claimedSale) },
      readback: { settled: true, cancelled: false, refundClaimed: final.refundClaimed,
        proceedsClaimed: final.proceedsClaimed, tokenClaimed: final.tokenClaimed },
      receipts: manifest!.receipts,
    };
    await writeFile(resolve(runDirectory, 'confirmed-public-evidence.json'), JSON.stringify(publicEvidence, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    manifest!.status = 'complete'; manifest!.stage = 'complete'; manifest!.pending = undefined; await saveManifest();
    process.stdout.write(JSON.stringify({ status: 'verified-preprod-four-slot-auction', contractAddress: address,
      receiptCount: Object.keys(manifest!.receipts).length, evidencePath: resolve(runDirectory, 'confirmed-public-evidence.json') }) + '\n');
  } catch (error) {
    if (manifest) {
      manifest.status = 'recovery-required'; manifest.stage = stage;
      manifest.failureClass = error instanceof Error ? error.name : 'UnknownError';
      await saveManifest();
    }
    throw error;
  } finally { await wallet.stop(); }
}

main().catch((error: unknown) => {
  const reason = error instanceof Error ? execute ? error.name : error.message : 'UnknownError';
  process.stderr.write(`Preprod auction ${execute ? 'execute' : 'preflight'} stopped at ${stage}: ${reason}\n`);
  process.exitCode = 1;
});
