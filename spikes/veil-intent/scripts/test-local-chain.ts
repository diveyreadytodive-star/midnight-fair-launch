import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import {
  chmodSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync,
  readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WebSocket } from 'ws';
import {
  createCallTxOptions, createUnprovenDeployTx, submitCallTxAsync, submitTxAsync,
} from '@midnight-ntwrk/midnight-js-contracts';
import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { levelPrivateStateProvider } from '@midnight-ntwrk/midnight-js-level-private-state-provider';
import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import { CompiledContract } from '@midnight-ntwrk/midnight-js-protocol/compact-js';
import {
  encodeCoinPublicKey, encodeContractAddress, sampleSigningKey,
} from '@midnight-ntwrk/midnight-js-protocol/compact-runtime';
import { nativeToken } from '@midnight-ntwrk/midnight-js-protocol/ledger';
import { createKeystore, HDWallet, Roles } from '@midnight-ntwrk/wallet-sdk';

import { localTestNetwork } from '../../../src/chain/client.js';
import { createSilenceWallet } from '../../../src/chain/wallet.js';
import { assertFreshExecution } from './recovery-guard.ts';
import { createExclusiveRunnerLock } from './runner-lock.ts';

Reflect.set(globalThis as object, 'WebSocket', WebSocket);

const spikeDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const projectDir = resolve(spikeDir, '../..');
const artifactsDir = resolve(spikeDir, 'generated/veil_intent');
const recoveryRoot = resolve(projectDir, '.local/veil-intent-recovery');
const recoveryPath = join(recoveryRoot, 'recovery.json');
const runnerLockPath = join(recoveryRoot, 'runner.lock');
const evidencePath = resolve(spikeDir, 'docs/evidence/local-devnet-veil-intent.json');
const escrowAtoms = 150n;
const quoteQuantity = 50n;
const quoteUnitPriceTicks = 2_000_000n;
const quoteTotalAtoms = 100n;
const buyerChangeAtoms = 50n;
const network = localTestNetwork('veil-intent-recovery-only');

class SafeRunnerError extends Error {}
let runnerLockOwned = false;
let preserveRunnerLock = false;

type WalletContext = Awaited<ReturnType<typeof createSilenceWallet>> & {
  readonly unshieldedKeystore: ReturnType<typeof createKeystore>;
};
type CoinRecord = { readonly nonceHex: string; readonly colorHex: string; readonly valueAtoms: string };
type ActionReceipt = {
  readonly txId: string;
  readonly status: 'SucceedEntirely';
  readonly blockHeight: number;
  readonly durationMs: number;
  readonly transactionHash: string;
  readonly entryPoint: string;
};
type Pending = {
  readonly stage: string;
  readonly phase: 'building' | 'submitted';
  readonly startedAt: string;
  readonly txId?: string;
  readonly contractAddress?: string;
};
type Recovery = {
  readonly version: 1;
  readonly runId: string;
  readonly createdAt: string;
  status: 'prepared' | 'preflighted' | 'running' | 'complete' | 'recovery-required';
  readonly buyerSeedHex: string;
  readonly sellerSeedHex: string;
  readonly solverSeedHex: string;
  readonly buyerStoragePassword: string;
  readonly sellerStoragePassword: string;
  readonly solverStoragePassword: string;
  readonly networkDomainHex: string;
  readonly buyerSecretHex: string;
  readonly agentSecretHex: string;
  readonly sellerSecretHex: string;
  readonly maxUnitPriceTicks: string;
  readonly maxTotalSpendAtoms: string;
  readonly intentSaltHex: string;
  readonly buyerRecipientSaltHex: string;
  readonly sellerRecipientSaltHex: string;
  readonly nonceHex: string;
  actions: Record<string, ActionReceipt>;
  buyerCoin?: CoinRecord;
  contractAddress?: string;
  buyerKeyHex?: string;
  sellerKeyHex?: string;
  solverKeyHex?: string;
  pending?: Pending;
  preflight?: {
    readonly checkedAt: string;
    readonly ownerDustRaw: string;
    readonly ownerNativeRaw: string;
    readonly distinctShieldedKeys: boolean;
    readonly feeSponsor: 'buyer Local Devnet genesis wallet';
  };
  failureStage?: string;
  failureClass?: string;
};
type IndexedTransaction = {
  readonly hash: string;
  readonly raw: string;
  readonly block: { readonly height: number };
  readonly contractActions: readonly { readonly address?: string; readonly entryPoint?: string; readonly state?: string; readonly zswapState?: string }[];
};
type ContractModule = {
  readonly Contract: new (...args: unknown[]) => unknown;
  readonly pureCircuits: {
    readonly deriveAgentIdentityCommitment: (domain: Uint8Array, address: Uint8Array, secret: Uint8Array) => Uint8Array;
    readonly deriveSellerIdentityCommitment: (domain: Uint8Array, address: Uint8Array, secret: Uint8Array) => Uint8Array;
  };
  readonly ledger: (state: unknown) => {
    readonly networkDomain: Uint8Array;
    readonly intentCommitment: Uint8Array;
    readonly intentDeadline: bigint;
    readonly publicQuoteQuantity: bigint;
    readonly publicQuoteUnitPriceTicks: bigint;
    readonly publicQuoteTotalAtoms: bigint;
    readonly buyerEscrowCoin: { readonly value: bigint; readonly mt_index: bigint };
    readonly buyerRemainderCoin: { readonly value: bigint; readonly mt_index: bigint };
    readonly buyerRemainderClaimable: boolean;
    readonly intentOpen: boolean;
    readonly quoteSubmitted: boolean;
    readonly quoteApproved: boolean;
    readonly intentExecuted: boolean;
    readonly intentCancelled: boolean;
  };
};

function assertLoopbackOnly(): void {
  const expected = [
    { name: 'indexer', value: network.indexer, protocol: 'http:', port: '28088', path: '/api/v4/graphql' },
    { name: 'indexer websocket', value: network.indexerWS, protocol: 'ws:', port: '28088', path: '/api/v4/graphql/ws' },
    { name: 'node websocket', value: network.node, protocol: 'ws:', port: '29944', path: '/' },
    { name: 'proof server', value: network.proofServer, protocol: 'http:', port: '26300', path: '/' },
  ];
  for (const endpoint of expected) {
    const url = new URL(endpoint.value);
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password ||
        url.protocol !== endpoint.protocol || url.port !== endpoint.port || url.pathname !== endpoint.path || url.search || url.hash) {
      throw new SafeRunnerError(`Refusing non-canonical loopback ${endpoint.name} endpoint.`);
    }
  }
}

function ensurePrivateDirectory(path: string): void {
  if (existsSync(path)) {
    const stat = lstatSync(path);
    assert.equal(stat.isSymbolicLink(), false, 'Refusing a symlink in protected recovery data.');
    assert.equal(stat.isDirectory(), true, 'Recovery path is not a directory.');
  } else mkdirSync(path, { mode: 0o700 });
  chmodSync(path, 0o700);
}

function acquireRunnerLock(): void {
  ensurePrivateDirectory(resolve(projectDir, '.local'));
  ensurePrivateDirectory(recoveryRoot);
  try {
    createExclusiveRunnerLock(runnerLockPath, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }) + '\n');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new SafeRunnerError('Runner lock already exists. It may be live or stale; inspect manually and never delete it automatically.');
    }
    throw error;
  }
  runnerLockOwned = true;
  protectAndCheckModesForLock();
}

function protectAndCheckModesForLock(): void {
  chmodSync(recoveryRoot, 0o700);
  chmodSync(runnerLockPath, 0o600);
  assert.equal(lstatSync(runnerLockPath).isSymbolicLink(), false, 'Runner lock cannot be a symlink.');
  assert.equal(lstatSync(runnerLockPath).mode & 0o777, 0o600, 'Runner lock must be mode 0600.');
}

function releaseOwnRunnerLock(): void {
  if (!runnerLockOwned) return;
  const stat = lstatSync(runnerLockPath);
  assert.equal(stat.isSymbolicLink(), false, 'Refusing to remove a replaced runner lock symlink.');
  assert.equal(stat.isFile(), true, 'Refusing to remove a non-file runner lock.');
  unlinkSync(runnerLockPath);
  runnerLockOwned = false;
}

function secureTree(path: string): void {
  if (!existsSync(path)) return;
  const stat = lstatSync(path);
  assert.equal(stat.isSymbolicLink(), false, 'Refusing a symlink in protected recovery data.');
  if (stat.isDirectory()) {
    chmodSync(path, 0o700);
    for (const name of readdirSync(path)) secureTree(join(path, name));
  } else chmodSync(path, 0o600);
}

function persist(document: Recovery): void {
  ensurePrivateDirectory(recoveryRoot);
  const temp = `${recoveryPath}.tmp-${process.pid}`;
  assert.equal(existsSync(temp), false, 'Recovery temp file exists; stop for manual reconciliation.');
  const fd = openSync(temp, 'wx', 0o600);
  try {
    writeFileSync(fd, JSON.stringify(document, null, 2) + '\n', 'utf8');
    fsyncSync(fd);
  } finally { closeSync(fd); }
  chmodSync(temp, 0o600);
  renameSync(temp, recoveryPath);
  chmodSync(recoveryPath, 0o600);
  const dir = openSync(recoveryRoot, 'r');
  try { fsyncSync(dir); } finally { closeSync(dir); }
}

function protectAndCheckModes(): void {
  secureTree(recoveryRoot);
  assert.equal(lstatSync(recoveryRoot).mode & 0o777, 0o700, 'Recovery directory must be mode 0700.');
  assert.equal(lstatSync(recoveryPath).mode & 0o777, 0o600, 'Recovery manifest must be mode 0600.');
}

function currentPendingStage(document: Recovery): string | undefined {
  return document.pending?.stage;
}

function loadOrCreateRecovery(): Recovery {
  ensurePrivateDirectory(resolve(projectDir, '.local'));
  ensurePrivateDirectory(recoveryRoot);
  if (existsSync(recoveryPath)) {
    assert.equal(lstatSync(recoveryPath).isSymbolicLink(), false, 'Recovery manifest cannot be a symlink.');
    chmodSync(recoveryPath, 0o600);
    const document = JSON.parse(readFileSync(recoveryPath, 'utf8')) as Recovery;
    assert.equal(document.version, 1, 'Unsupported VeilIntent recovery version.');
    return document;
  }
  const buyerSeed = process.env.VEIL_INTENT_LOCAL_TEST_SEED?.trim() ?? '';
  delete process.env.VEIL_INTENT_LOCAL_TEST_SEED;
  if (!/^(?:[0-9a-fA-F]{2}){32}$/.test(buyerSeed)) {
    throw new SafeRunnerError('Set VEIL_INTENT_LOCAL_TEST_SEED to the 32-byte valueless Local Devnet test genesis seed. No Preprod wallet file is read.');
  }
  const document: Recovery = {
    version: 1,
    runId: randomUUID(),
    createdAt: new Date().toISOString(),
    status: 'prepared',
    buyerSeedHex: buyerSeed,
    sellerSeedHex: randomBytes(32).toString('hex'),
    solverSeedHex: randomBytes(32).toString('hex'),
    buyerStoragePassword: randomBytes(32).toString('hex'),
    sellerStoragePassword: randomBytes(32).toString('hex'),
    solverStoragePassword: randomBytes(32).toString('hex'),
    networkDomainHex: createHash('sha256').update(`VEIL-INTENT/LOCAL-DEVNET/v1/${randomUUID()}`).digest('hex'),
    buyerSecretHex: randomBytes(32).toString('hex'),
    agentSecretHex: randomBytes(32).toString('hex'),
    sellerSecretHex: randomBytes(32).toString('hex'),
    maxUnitPriceTicks: (2_000_001n + BigInt(randomBytes(4).readUInt32BE(0) % 1_000_000)).toString(),
    maxTotalSpendAtoms: (101 + randomBytes(1)[0] % 20).toString(),
    intentSaltHex: randomBytes(32).toString('hex'),
    buyerRecipientSaltHex: randomBytes(32).toString('hex'),
    sellerRecipientSaltHex: randomBytes(32).toString('hex'),
    nonceHex: randomBytes(32).toString('hex'),
    actions: {},
  };
  persist(document);
  protectAndCheckModes();
  return document;
}

function bytes(hex: string): Uint8Array { return Uint8Array.from(Buffer.from(hex, 'hex')); }
function asCoin(value: unknown): CoinRecord {
  const coin = value as { readonly nonce?: Uint8Array; readonly color?: Uint8Array; readonly value?: bigint } | undefined;
  assert.ok(coin?.nonce instanceof Uint8Array && coin.color instanceof Uint8Array && typeof coin.value === 'bigint', 'Test mint produced no shielded coin.');
  return { nonceHex: Buffer.from(coin.nonce).toString('hex'), colorHex: Buffer.from(coin.color).toString('hex'), valueAtoms: coin.value.toString() };
}

async function makeWallet(seedHex: string, role: string, storagePassword: string): Promise<WalletContext> {
  const directory = join(recoveryRoot, `${role}-wallet`);
  ensurePrivateDirectory(directory);
  const config = { ...localTestNetwork(storagePassword), privateStateDir: join(directory, 'private-state') };
  ensurePrivateDirectory(config.privateStateDir);
  const context = await createSilenceWallet(seedHex, config);
  const hd = HDWallet.fromSeed(Buffer.from(seedHex, 'hex'));
  if (hd.type !== 'seedOk') throw new SafeRunnerError(`${role} test wallet seed could not be derived.`);
  const derived = hd.hdWallet.selectAccount(0).selectRoles([Roles.Zswap, Roles.NightExternal, Roles.Dust]).deriveKeysAt(0);
  if (derived.type !== 'keysDerived') { hd.hdWallet.clear(); throw new SafeRunnerError(`${role} wallet role keys could not be derived.`); }
  const keyStore = createKeystore(derived.keys[Roles.NightExternal], config.networkId);
  hd.hdWallet.clear();
  assert.equal(keyStore.getBech32Address().toString(), context.accountId);
  secureTree(directory);
  return { ...context, unshieldedKeystore: keyStore };
}

function providers(actor: WalletContext, buyerSponsor: WalletContext, role: string, storagePassword: string) {
  const publicDataProvider = indexerPublicDataProvider(network.indexer, network.indexerWS);
  const zkConfigProvider = new NodeZkConfigProvider(artifactsDir);
  const sponsored = actor !== buyerSponsor;
  const walletProvider = {
    getCoinPublicKey: () => actor.shieldedSecretKeys.coinPublicKey,
    getEncryptionPublicKey: () => actor.shieldedSecretKeys.encryptionPublicKey,
    async balanceTx(tx: unknown, ttl?: Date) {
      const recipe = await buyerSponsor.wallet.balanceUnboundTransaction(
        tx as never,
        { shieldedSecretKeys: actor.shieldedSecretKeys, dustSecretKey: buyerSponsor.dustSecretKey },
        { ttl: ttl ?? new Date(Date.now() + 30 * 60 * 1000), tokenKindsToBalance: sponsored ? ['dust'] : 'all' },
      );
      return buyerSponsor.wallet.finalizeRecipe(recipe);
    },
    submitTx: (tx: unknown) => buyerSponsor.wallet.submitTransaction(tx as never),
  };
  const privateStateProvider = levelPrivateStateProvider({
    accountId: actor.unshieldedKeystore.getBech32Address().toString(),
    midnightDbName: join(recoveryRoot, `${role}-wallet`, 'midnight-level-db'),
    privateStateStoreName: 'veil-intent-private-state',
    signingKeyStoreName: 'veil-intent-signing-keys',
    privateStoragePasswordProvider: () => storagePassword,
  });
  return {
    providers: { privateStateProvider, publicDataProvider, zkConfigProvider, proofProvider: httpClientProofProvider(network.proofServer, zkConfigProvider), walletProvider, midnightProvider: walletProvider },
    publicDataProvider, zkConfigProvider, walletProvider, privateStateProvider,
  };
}

async function tokenBalance(wallet: WalletContext, colorHex: string): Promise<bigint> {
  const state = await wallet.wallet.waitForSyncedState();
  return state.shielded.balances[colorHex] ?? 0n;
}

async function finalized(provider: ReturnType<typeof indexerPublicDataProvider>, txId: string) {
  const result = await provider.watchForTxData(txId);
  assert.equal(result.status, 'SucceedEntirely', 'Transaction did not finalize successfully.');
  assert.equal(typeof result.blockHeight, 'number');
  return { txId, status: 'SucceedEntirely' as const, blockHeight: result.blockHeight! };
}

async function queryTransaction(txId: string, blockHeight: number): Promise<IndexedTransaction> {
  const identifier = txId.replace(/^0x/i, '');
  assert.match(identifier, /^[0-9a-fA-F]{66}$/, 'Unexpected transaction identifier format.');
  const query = 'query VeilIntentTransaction { transactions(offset: { identifier: ' + JSON.stringify(identifier) +
    ' }) { hash raw block { height } contractActions { __typename ... on ContractCall { address entryPoint state zswapState } } } }';
  const response = await fetch(network.indexer, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query }) });
  if (!response.ok) throw new SafeRunnerError('Loopback indexer transaction read failed.');
  const body = await response.json() as { readonly data?: { readonly transactions?: readonly IndexedTransaction[] }; readonly errors?: readonly unknown[] };
  if (body.errors?.length) throw new SafeRunnerError('Loopback indexer rejected transaction query.');
  const transaction = body.data?.transactions?.[0];
  assert.ok(transaction && typeof transaction.raw === 'string', 'Indexed transaction raw fields are unavailable.');
  assert.equal(transaction.block.height, blockHeight, 'Receipt and indexer block height differ.');
  return transaction;
}

async function readLedger(provider: ReturnType<typeof indexerPublicDataProvider>, module: ContractModule, address: string) {
  const state = await provider.queryContractState(address as never);
  assert.ok(state, 'Public contract ledger is unavailable from loopback indexer.');
  return module.ledger((state as { readonly data?: unknown }).data ?? state);
}

function persistPending(document: Recovery, stage: string, contractAddress?: string): void {
  assert.equal(document.pending, undefined, 'Prior action is pending; stop for manual reconciliation.');
  document.status = 'running';
  document.pending = { stage, phase: 'building', startedAt: new Date().toISOString(), ...(contractAddress ? { contractAddress } : {}) };
  persist(document);
  protectAndCheckModes();
}

async function call(
  document: Recovery,
  stage: string,
  circuit: string,
  providerSet: ReturnType<typeof providers>,
  compiled: unknown,
  address: string,
  args: readonly unknown[],
): Promise<{ readonly result: unknown; readonly receipt: ActionReceipt; readonly transaction: IndexedTransaction }> {
  const startedAt = Date.now();
  persistPending(document, stage, address);
  try {
    const options = createCallTxOptions(compiled as never, circuit as never, address as never, undefined, undefined, [...args] as never);
    const submitted = await submitCallTxAsync(providerSet.providers as never, options as never);
    document.pending = { ...document.pending!, phase: 'submitted', txId: submitted.txId };
    persist(document);
    const receipt = await finalized(providerSet.publicDataProvider, submitted.txId);
    const transaction = await queryTransaction(submitted.txId, receipt.blockHeight);
    const action = transaction.contractActions.find((candidate) => candidate.entryPoint === circuit);
    assert.ok(action, `Indexer does not show expected circuit ${circuit}.`);
    if (action.address) assert.equal(action.address, address);
    const saved: ActionReceipt = { ...receipt, durationMs: Date.now() - startedAt, transactionHash: transaction.hash, entryPoint: circuit };
    document.actions[stage] = saved;
    document.pending = undefined;
    persist(document);
    protectAndCheckModes();
    return { result: (submitted.callTxData as { readonly private?: { readonly result?: unknown } }).private?.result, receipt: saved, transaction };
  } catch (error) {
    document.status = 'recovery-required';
    document.failureStage = stage;
    document.failureClass = error instanceof Error ? error.name : 'UnknownError';
    persist(document);
    protectAndCheckModes();
    throw new SafeRunnerError(`Proof/check, submission, receipt, or readback failed at ${stage}. Recovery is preserved; no retry is safe.`);
  }
}

async function deploy(
  document: Recovery,
  providerSet: ReturnType<typeof providers>,
  module: ContractModule,
  compiled: unknown,
): Promise<{ readonly address: string; readonly receipt: ActionReceipt; readonly transaction: IndexedTransaction }> {
  const startedAt = Date.now();
  persistPending(document, 'deploy');
  try {
    const domain = bytes(document.networkDomainHex);
    const deployment = await createUnprovenDeployTx(
      { zkConfigProvider: providerSet.zkConfigProvider, walletProvider: providerSet.walletProvider } as never,
      { compiledContract: compiled as never, args: [domain], signingKey: sampleSigningKey(), initialPrivateState: undefined } as never,
    );
    const address = String(deployment.public.contractAddress);
    document.contractAddress = address;
    document.pending = { ...document.pending!, contractAddress: address };
    persist(document);
    const txId = await submitTxAsync(providerSet.providers as never, { unprovenTx: deployment.private.unprovenTx } as never);
    document.pending = { ...document.pending!, phase: 'submitted', txId };
    persist(document);
    const receipt = await finalized(providerSet.publicDataProvider, txId);
    const transaction = await queryTransaction(txId, receipt.blockHeight);
    assert.ok(await providerSet.publicDataProvider.queryContractState(address as never), 'Deployed contract missing from loopback indexer.');
    const action: ActionReceipt = { ...receipt, durationMs: Date.now() - startedAt, transactionHash: transaction.hash, entryPoint: 'deploy' };
    document.actions.deploy = action;
    document.pending = undefined;
    persist(document);
    protectAndCheckModes();
    return { address, receipt: action, transaction };
  } catch (error) {
    document.status = 'recovery-required';
    document.failureStage = 'deploy';
    document.failureClass = error instanceof Error ? error.name : 'UnknownError';
    persist(document);
    protectAndCheckModes();
    throw new SafeRunnerError('Deployment proof/check, submission, receipt, or readback failed; preserve and reconcile before any retry.');
  }
}

function witnesses() {
  return {
    quotientRemainder(context: { readonly privateState: unknown }, numerator: bigint, denominator: bigint) {
      return [context.privateState, { quotient: numerator / denominator, remainder: numerator % denominator }];
    },
  };
}

async function main(): Promise<void> {
  assertLoopbackOnly();
  const modes = ['--prepare-only', '--preflight-only', '--execute'].filter((flag) => process.argv.includes(flag));
  if (modes.length > 1) throw new SafeRunnerError('Choose exactly one runner mode.');
  if (modes.length === 0) {
    process.stdout.write('Idle: select --prepare-only, --preflight-only, or --execute. No wallet or network activity occurred.\n');
    return;
  }
  acquireRunnerLock();
  const mode = modes[0];
  if (mode === '--prepare-only') {
    const document = loadOrCreateRecovery();
    protectAndCheckModes();
    process.stdout.write(`PASS: separate VeilIntent recovery prepared (run=${document.runId}, status=${document.status}, modes=0700/0600); no wallet/network/transaction/Docker activity.\n`);
    return;
  }
  if (!existsSync(recoveryPath)) throw new SafeRunnerError('Prepare the protected VeilIntent recovery manifest before wallet sync.');
  const document = loadOrCreateRecovery();
  protectAndCheckModes();
  if (document.pending || document.status === 'running' || document.status === 'recovery-required' || document.status === 'complete') {
    throw new SafeRunnerError('Manifest contains prior or unresolved activity; this runner has no resume path.');
  }
  if (mode === '--execute') {
    try { assertFreshExecution(document); }
    catch { throw new SafeRunnerError('Execution requires a pristine preflighted manifest; reconcile prior activity manually.'); }
  }

  let executionStarted = false;
  const wallets: WalletContext[] = [];
  try {
    const proofReady = await fetch(network.proofServer, { signal: AbortSignal.timeout(5_000) }).catch(() => null);
    const indexerReady = await fetch(network.indexer, { signal: AbortSignal.timeout(5_000) }).catch(() => null);
    if (!proofReady || !indexerReady) throw new SafeRunnerError('Loopback Local Devnet proof/indexer endpoint unavailable; no Docker action was attempted.');
    setNetworkId(network.networkId);
    const buyer = await makeWallet(document.buyerSeedHex, 'buyer', document.buyerStoragePassword); wallets.push(buyer);
    const seller = await makeWallet(document.sellerSeedHex, 'seller', document.sellerStoragePassword); wallets.push(seller);
    const solver = await makeWallet(document.solverSeedHex, 'solver', document.solverStoragePassword); wallets.push(solver);
    const keys = [buyer, seller, solver].map((wallet) => Buffer.from(encodeCoinPublicKey(wallet.shieldedSecretKeys.coinPublicKey)).toString('hex'));
    assert.equal(new Set(keys).size, keys.length, 'Buyer/seller/solver shielded keys must be distinct.');
    document.buyerKeyHex = keys[0]; document.sellerKeyHex = keys[1]; document.solverKeyHex = keys[2];
    const [buyerState, solverState] = await Promise.all([buyer.wallet.waitForSyncedState(), solver.wallet.waitForSyncedState()]);
    const buyerDust = buyerState.dust.balance(new Date());
    const buyerNative = buyerState.unshielded.balances[nativeToken().raw] ?? 0n;
    if (buyerDust <= 0n) throw new SafeRunnerError('Buyer test genesis wallet has no DUST for sponsorship; no transaction submitted.');
    if ((solverState.unshielded.balances[nativeToken().raw] ?? 0n) !== 0n) throw new SafeRunnerError('Fresh solver wallet unexpectedly holds native test token.');
    document.preflight = { checkedAt: new Date().toISOString(), ownerDustRaw: buyerDust.toString(), ownerNativeRaw: buyerNative.toString(), distinctShieldedKeys: true, feeSponsor: 'buyer Local Devnet genesis wallet' };
    document.status = 'preflighted';
    persist(document); protectAndCheckModes();
    if (mode === '--preflight-only') {
      process.stdout.write(`PASS: read-only VeilIntent loopback preflight; buyer DUST=${buyerDust}; buyer/seller/solver shielded keys distinct; recovery modes=0700/0600; no transaction submitted.\n`);
      return;
    }

    executionStarted = true;
    document.status = 'running'; persist(document); protectAndCheckModes();
    const module = await import(pathToFileURL(resolve(artifactsDir, 'contract/index.js')).href) as ContractModule;
    const compiled = CompiledContract.make('veil-intent', module.Contract as never).pipe(
      CompiledContract.withWitnesses(witnesses() as never),
      CompiledContract.withCompiledFileAssets(artifactsDir),
    );
    const buyerP = providers(buyer, buyer, 'buyer', document.buyerStoragePassword);
    const sellerP = providers(seller, buyer, 'seller', document.sellerStoragePassword);
    const solverP = providers(solver, buyer, 'solver', document.solverStoragePassword);
    const deployment = await deploy(document, buyerP, module, compiled);
    const address = deployment.address;
    for (const set of [buyerP, sellerP, solverP]) set.privateStateProvider.setContractAddress(address as never);

    const minted = await call(document, 'mint-public-escrow-lot', 'mintTestCoin', buyerP, compiled, address,
      [escrowAtoms, bytes(randomBytes(32).toString('hex'))]);
    document.buyerCoin = asCoin(minted.result); persist(document); protectAndCheckModes();
    assert.equal(BigInt(document.buyerCoin.valueAtoms), escrowAtoms);
    const tokenColorHex = document.buyerCoin.colorHex;
    assert.equal(await tokenBalance(buyer, tokenColorHex), escrowAtoms, 'Buyer should hold the minted valueless lot.');

    const buyerKey = encodeCoinPublicKey(buyer.shieldedSecretKeys.coinPublicKey);
    const sellerKey = encodeCoinPublicKey(seller.shieldedSecretKeys.coinPublicKey);
    const buyerTarget = { recipient: { bytes: buyerKey }, salt: bytes(document.buyerRecipientSaltHex) };
    const sellerTarget = { recipient: { bytes: sellerKey }, salt: bytes(document.sellerRecipientSaltHex) };
    const domain = bytes(document.networkDomainHex);
    const contractBytes = encodeContractAddress(address as never);
    const agentIdentity = module.pureCircuits.deriveAgentIdentityCommitment(domain, contractBytes, bytes(document.agentSecretHex));
    const sellerIdentity = module.pureCircuits.deriveSellerIdentityCommitment(domain, contractBytes, bytes(document.sellerSecretHex));
    const terms = {
      quantity: quoteQuantity,
      maxUnitPriceTicks: BigInt(document.maxUnitPriceTicks),
      maxTotalSpendAtoms: BigInt(document.maxTotalSpendAtoms),
      expiresAt: BigInt(Math.floor(Date.now() / 1000) + 3600),
      nonce: bytes(document.nonceHex),
    };
    const coin = { nonce: bytes(document.buyerCoin.nonceHex), color: bytes(document.buyerCoin.colorHex), value: BigInt(document.buyerCoin.valueAtoms) };
    const createIntent = await call(document, 'create-private-intent', 'createIntent', buyerP, compiled, address,
      [coin, terms, bytes(document.intentSaltHex), bytes(document.buyerSecretHex), agentIdentity, sellerIdentity,
        { bytes: sellerKey }, bytes(document.sellerRecipientSaltHex), buyerTarget]);
    let state = await readLedger(buyerP.publicDataProvider, module, address);
    assert.equal(state.intentOpen, true);
    assert.equal(state.buyerEscrowCoin.value, escrowAtoms);
    assert.ok(state.buyerEscrowCoin.mt_index > 0n, 'Buyer escrow must have a real shielded coin index.');
    await buyer.wallet.waitForSyncedState();
    assert.equal(await tokenBalance(buyer, tokenColorHex), 0n);

    const quote = { seller: { bytes: sellerKey }, quantity: quoteQuantity, unitPriceTicks: quoteUnitPriceTicks };
    const submittedQuote = await call(document, 'seller-submits-quote', 'submitQuote', sellerP, compiled, address,
      [quote, bytes(document.sellerSecretHex), sellerTarget]);
    state = await readLedger(sellerP.publicDataProvider, module, address);
    assert.equal(state.quoteSubmitted, true);
    assert.equal(state.publicQuoteQuantity, quoteQuantity);
    assert.equal(state.publicQuoteUnitPriceTicks, quoteUnitPriceTicks);
    assert.equal(state.publicQuoteTotalAtoms, quoteTotalAtoms);

    const approved = await call(document, 'agent-approves-private-policy', 'approveQuote', solverP, compiled, address,
      [terms, bytes(document.intentSaltHex), bytes(document.agentSecretHex)]);
    state = await readLedger(solverP.publicDataProvider, module, address);
    assert.equal(state.quoteApproved, true);
    assert.equal(await tokenBalance(seller, tokenColorHex), 0n, 'Approval is state-only; seller has not claimed yet.');

    const sellerClaim = await call(document, 'seller-wallet-claims-payment', 'sellerClaimPayout', sellerP, compiled, address,
      [bytes(document.sellerSecretHex), sellerTarget]);
    state = await readLedger(sellerP.publicDataProvider, module, address);
    assert.equal(state.intentExecuted, true);
    assert.equal(state.buyerRemainderClaimable, true);
    assert.equal(state.buyerRemainderCoin.value, buyerChangeAtoms);
    const buyerChangeMtIndex = state.buyerRemainderCoin.mt_index;
    assert.ok(buyerChangeMtIndex > 0n, 'Partial seller payment must preserve buyer change in a real shielded coin.');
    await seller.wallet.waitForSyncedState();
    assert.equal(await tokenBalance(seller, tokenColorHex), quoteTotalAtoms, 'Seller wallet must discover its claimed shielded payment.');

    const buyerClaim = await call(document, 'buyer-wallet-claims-remainder', 'claimBuyerRemainder', buyerP, compiled, address,
      [bytes(document.buyerSecretHex), buyerTarget]);
    state = await readLedger(buyerP.publicDataProvider, module, address);
    assert.equal(state.buyerRemainderClaimable, false);
    await buyer.wallet.waitForSyncedState();
    assert.equal(await tokenBalance(buyer, tokenColorHex), buyerChangeAtoms, 'Buyer wallet must discover the shielded remainder.');

    const actionStages = [deployment, minted, createIntent, submittedQuote, approved, sellerClaim, buyerClaim];
    const finalReceiptAudit = [];
    for (const actionResult of actionStages) {
      const action = actionResult.receipt;
      const indexed = await queryTransaction(action.txId, action.blockHeight);
      assert.equal(indexed.hash, action.transactionHash);
      finalReceiptAudit.push({ stage: action.entryPoint, txId: action.txId, transactionHash: indexed.hash, blockHeight: indexed.block.height, entryPoint: action.entryPoint });
    }
    const evidence = {
      checkedAt: new Date().toISOString(),
      mode: 'actual Local Devnet; valueless shielded test payment token; loopback endpoints only; no Docker start/reset',
      runId: document.runId,
      contractAddress: address,
      productBoundary: 'one buyer, one approved seller, one per-intent mandate; one-way payment only, not an atomic asset swap',
      roles: {
        buyerSellerSolverShieldedKeysDistinct: true,
        approvalCircuitInputsExcludeBuyerWalletSeed: true,
        runnerSharesFeeSponsorAndHoldsBuyerSellerSolverTestSeeds: true,
        feeSponsor: 'buyer Local Devnet genesis wallet; independent operational key separation remains unverified',
      },
      expectedVsReadback: {
        publicEscrowAtoms: escrowAtoms.toString(),
        perIntentPrivateLimits: 'Randomized per protected recovery bundle; exact values are not written to public evidence.',
        publicQuote: { quantity: quoteQuantity.toString(), unitPriceTicks: quoteUnitPriceTicks.toString(), totalAtoms: quoteTotalAtoms.toString() },
        buyerChangeCoinMtIndexBeforeClaim: buyerChangeMtIndex.toString(),
        sellerShieldedBalanceAtoms: (await tokenBalance(seller, tokenColorHex)).toString(),
        buyerRemainderBalanceAtoms: (await tokenBalance(buyer, tokenColorHex)).toString(),
        finalIntentExecuted: state.intentExecuted,
        finalBuyerRemainderClaimable: state.buyerRemainderClaimable,
      },
      publicDisclosure: [
        'The escrow lot, deadline, seller commitments, actual quantity/unit quote/total, and settlement status are public.',
        'The public 150 lot and quote total 100 reveal a range for the private maximum; no exact-max or full order-privacy claim is made.',
        'The buyer max unit price, max total budget, intent nonce and secrets are checked as absent from simulator public ledger fields only; this chain run does not establish raw-transaction/timing/recipient privacy.',
      ],
      receipts: finalReceiptAudit,
      feeSponsorDustRaw: document.preflight?.ownerDustRaw ?? 'unknown',
    };
    mkdirSync(dirname(evidencePath), { recursive: true, mode: 0o755 });
    writeFileSync(evidencePath, JSON.stringify(evidence, null, 2) + '\n', { mode: 0o644 });
    chmodSync(evidencePath, 0o644);
    document.status = 'complete'; document.pending = undefined; persist(document); protectAndCheckModes();
    process.stdout.write('PASS: seller wallet claimed 100 test units and buyer wallet claimed 50 change; receipts/indexer/ledger readback saved.\n');
  } catch (error) {
    if (executionStarted || document.pending) {
      preserveRunnerLock = true;
      document.status = 'recovery-required';
      document.failureStage = currentPendingStage(document) ?? 'preflight-or-acceptance';
      document.failureClass = error instanceof Error ? error.name : 'UnknownError';
      persist(document); protectAndCheckModes();
    } else {
      document.status = 'prepared';
      persist(document); protectAndCheckModes();
    }
    throw error instanceof SafeRunnerError ? error : new SafeRunnerError(`Runner failed at ${document.failureStage ?? 'preflight'}; protected recovery remains and no automatic retry will occur.`);
  } finally {
    await Promise.allSettled(wallets.map((wallet) => wallet.stop()));
    protectAndCheckModes();
  }
}

main().then(() => {
  releaseOwnRunnerLock();
}).catch((error: unknown) => {
  if (!preserveRunnerLock) releaseOwnRunnerLock();
  const message = error instanceof SafeRunnerError ? error.message : 'Unexpected runner failure; protected recovery was retained.';
  process.stderr.write(`VeilIntent runner stopped: ${message}\n`);
  process.exitCode = 1;
});
