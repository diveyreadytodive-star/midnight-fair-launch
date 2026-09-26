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
  createCallTxOptions, createUnprovenCallTx, createUnprovenDeployTx, submitCallTxAsync, submitTxAsync,
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
import type * as FairLaunch from '../generated/fair_launch/contract/index.js';

import { localTestNetwork } from '../../../src/chain/client.js';
import { createSilenceWallet } from '../../../src/chain/wallet.js';
import { assertFreshExecution } from './recovery-guard.ts';
import { sanitizeRunnerDiagnostic } from './runner-diagnostic.ts';
import { createExclusiveRunnerLock } from './runner-lock.ts';

Reflect.set(globalThis as object, 'WebSocket', WebSocket);

const spikeDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const projectDir = resolve(spikeDir, '../..');
const artifactsDir = resolve(spikeDir, 'generated/fair_launch');
const recoveryRoot = resolve(projectDir, '.local/fair-launch-recovery');
const recoveryPath = join(recoveryRoot, 'recovery.json');
const runnerLockPath = join(recoveryRoot, 'runner.lock');
const evidencePath = resolve(spikeDir, 'docs/evidence/local-devnet-fair-launch.json');
const network = localTestNetwork('fair-launch-local-devnet');
const inventory = 600n;
const reservePrice = 8n;
const depositLot = 5_000n;
const bids = [
  { maxPrice: 12n, quantity: 300n },
  { maxPrice: 10n, quantity: 500n },
  { maxPrice: 8n, quantity: 400n },
  { maxPrice: 8n, quantity: 200n },
] as const;
const expectedAllocations = [300n, 300n, 0n, 0n] as const;
const expectedRefunds = [2_000n, 2_000n, 5_000n, 5_000n] as const;
const commitWindowSeconds = 480;
const openWindowSeconds = 3_600;

class SafeRunnerError extends Error {}

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
type BidOpening = FairLaunch.BidOpening;
type ContractModule = typeof import('../generated/fair_launch/contract/index.js');
type CircuitName = keyof FairLaunch.ImpureCircuits<unknown>;
type CircuitArguments<Name extends CircuitName> =
  Parameters<FairLaunch.ImpureCircuits<unknown>[Name]> extends [unknown, ...infer Arguments] ? Arguments : never;
type DeployArguments = Parameters<InstanceType<ContractModule['Contract']>['initialState']> extends [unknown, ...infer Arguments]
  ? Arguments
  : never;
type Recovery = {
  readonly version: 1;
  readonly runId: string;
  readonly createdAt: string;
  status: 'prepared' | 'preflighted' | 'running' | 'complete' | 'recovery-required';
  readonly operatorSeedHex: string;
  readonly bidderSeedHexes: readonly [string, string, string, string];
  readonly operatorStoragePassword: string;
  readonly bidderStoragePasswords: readonly [string, string, string, string];
  readonly networkDomainHex: string;
  paymentTokenDomainHex?: string;
  saleTokenDomainHex?: string;
  readonly inventoryAuthoritySecretHex: string;
  readonly bidderOpenings: readonly [string, string, string, string];
  actions: Record<string, ActionReceipt>;
  paymentCoins?: readonly [CoinRecord, CoinRecord, CoinRecord, CoinRecord];
  saleCoin?: CoinRecord;
  contractAddress?: string;
  operatorKeyHex?: string;
  bidderKeyHexes?: readonly [string, string, string, string];
  bidCommitmentHexes?: readonly [string, string, string, string];
  commitDeadline?: string;
  openDeadline?: string;
  pending?: Pending;
  preflight?: {
    readonly checkedAt: string;
    readonly operatorDustRaw: string;
    readonly operatorNativeRaw: string;
    readonly distinctShieldedKeys: boolean;
    readonly feeSponsor: 'Local Devnet genesis operator wallet';
  };
  failureStage?: string;
  failureClass?: string;
  failureDiagnostic?: string;
};
type IndexedTransaction = {
  readonly hash: string;
  readonly raw: string;
  readonly block: { readonly height: number };
  readonly contractActions: readonly { readonly address?: string; readonly entryPoint?: string; readonly state?: string; readonly zswapState?: string }[];
};
type WalletContext = Awaited<ReturnType<typeof createSilenceWallet>> & {
  readonly unshieldedKeystore: ReturnType<typeof createKeystore>;
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

let runnerLockOwned = false;
let preserveRunnerLock = false;

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

function loadOrCreateRecovery(): Recovery {
  ensurePrivateDirectory(resolve(projectDir, '.local'));
  ensurePrivateDirectory(recoveryRoot);
  if (existsSync(recoveryPath)) {
    assert.equal(lstatSync(recoveryPath).isSymbolicLink(), false, 'Recovery manifest cannot be a symlink.');
    chmodSync(recoveryPath, 0o600);
    const document = JSON.parse(readFileSync(recoveryPath, 'utf8')) as Recovery;
    assert.equal(document.version, 1, 'Unsupported Fair Launch recovery version.');
    return document;
  }
  const operatorSeed = process.env.FAIR_LAUNCH_LOCAL_TEST_SEED?.trim() ?? '';
  delete process.env.FAIR_LAUNCH_LOCAL_TEST_SEED;
  if (!/^(?:[0-9a-fA-F]{2}){32}$/.test(operatorSeed)) {
    throw new SafeRunnerError('Set FAIR_LAUNCH_LOCAL_TEST_SEED to the 32-byte valueless Local Devnet genesis seed. No Preprod wallet file is read.');
  }
  const document: Recovery = {
    version: 1,
    runId: randomUUID(),
    createdAt: new Date().toISOString(),
    status: 'prepared',
    operatorSeedHex: operatorSeed,
    bidderSeedHexes: [0, 1, 2, 3].map(() => randomBytes(32).toString('hex')) as [string, string, string, string],
    operatorStoragePassword: randomBytes(32).toString('hex'),
    bidderStoragePasswords: [0, 1, 2, 3].map(() => randomBytes(32).toString('hex')) as [string, string, string, string],
    networkDomainHex: createHash('sha256').update(`FAIR-LAUNCH/LOCAL-DEVNET/v1/${randomUUID()}`).digest('hex'),
    inventoryAuthoritySecretHex: randomBytes(32).toString('hex'),
    bidderOpenings: [0, 1, 2, 3].map((slot) => JSON.stringify({
      maxPrice: bids[slot].maxPrice.toString(),
      quantity: bids[slot].quantity.toString(),
      saltHex: randomBytes(32).toString('hex'),
    })) as [string, string, string, string],
    actions: {},
  };
  persist(document);
  protectAndCheckModes();
  return document;
}

function readRecoveryForDiagnostic(): Recovery {
  assert.ok(existsSync(recoveryPath), 'A protected Fair Launch recovery manifest is required.');
  const stat = lstatSync(recoveryPath);
  assert.equal(stat.isSymbolicLink(), false, 'Recovery manifest cannot be a symlink.');
  assert.equal(stat.isFile(), true, 'Recovery path is not a file.');
  assert.equal(stat.mode & 0o777, 0o600, 'Recovery manifest must remain mode 0600.');
  const document = JSON.parse(readFileSync(recoveryPath, 'utf8')) as Recovery;
  assert.equal(document.version, 1, 'Unsupported Fair Launch recovery version.');
  assert.equal(document.status, 'recovery-required', 'Diagnostic mode requires a blocked recovery.');
  assert.equal(document.pending?.stage, 'register-bid-0', 'Diagnostic mode only reconstructs the first blocked bid registration.');
  assert.equal(document.pending?.phase, 'building', 'Blocked registration must not have submitted.');
  assert.equal(document.pending?.txId, undefined, 'A transaction ID exists; no diagnostic reconstruction is safe.');
  assert.equal(document.actions['register-bid-0'], undefined, 'Bid registration already has a receipt.');
  assert.ok(document.contractAddress && document.paymentCoins?.[0] && document.bidderKeyHexes?.[0]);
  return document;
}

function bytes(hex: string): Uint8Array { return Uint8Array.from(Buffer.from(hex, 'hex')); }
function asCoin(value: unknown): CoinRecord {
  const coin = value as { readonly nonce?: Uint8Array; readonly color?: Uint8Array; readonly value?: bigint } | undefined;
  assert.ok(coin?.nonce instanceof Uint8Array && coin.color instanceof Uint8Array && typeof coin.value === 'bigint', 'Test mint produced no shielded coin.');
  return { nonceHex: Buffer.from(coin.nonce).toString('hex'), colorHex: Buffer.from(coin.color).toString('hex'), valueAtoms: coin.value.toString() };
}

function openingFromRecovery(document: Recovery, slot: number, recipientKey: Uint8Array): BidOpening {
  const stored = JSON.parse(document.bidderOpenings[slot]) as {
    readonly maxPrice: string;
    readonly quantity: string;
    readonly saltHex: string;
  };
  return {
    maxPrice: BigInt(stored.maxPrice),
    quantity: BigInt(stored.quantity),
    salt: bytes(stored.saltHex),
    refundRecipient: { bytes: recipientKey },
    tokenRecipient: { bytes: recipientKey },
  };
}

async function makeWallet(seedHex: string, role: string, storagePassword: string, enforcePrivateModes = true): Promise<WalletContext> {
  const directory = join(recoveryRoot, `${role}-wallet`);
  if (enforcePrivateModes) ensurePrivateDirectory(directory);
  else assert.ok(lstatSync(directory).isDirectory() && !lstatSync(directory).isSymbolicLink(), 'Protected wallet directory is unavailable.');
  const config = { ...localTestNetwork(storagePassword), privateStateDir: join(directory, 'private-state') };
  if (enforcePrivateModes) ensurePrivateDirectory(config.privateStateDir);
  else assert.ok(lstatSync(config.privateStateDir).isDirectory() && !lstatSync(config.privateStateDir).isSymbolicLink(), 'Protected wallet state directory is unavailable.');
  const context = await createSilenceWallet(seedHex, config);
  const hd = HDWallet.fromSeed(Buffer.from(seedHex, 'hex'));
  if (hd.type !== 'seedOk') throw new SafeRunnerError(`${role} test wallet seed could not be derived.`);
  const derived = hd.hdWallet.selectAccount(0).selectRoles([Roles.Zswap, Roles.NightExternal, Roles.Dust]).deriveKeysAt(0);
  if (derived.type !== 'keysDerived') { hd.hdWallet.clear(); throw new SafeRunnerError(`${role} wallet role keys could not be derived.`); }
  const keyStore = createKeystore(derived.keys[Roles.NightExternal], config.networkId);
  hd.hdWallet.clear();
  assert.equal(keyStore.getBech32Address().toString(), context.accountId);
  if (enforcePrivateModes) secureTree(directory);
  return { ...context, unshieldedKeystore: keyStore };
}

async function balanceActorShieldedThenOperatorDust(
  actor: WalletContext,
  operator: WalletContext,
  tx: unknown,
  ttl: Date,
  onPhase?: (phase: string) => void,
): Promise<unknown> {
  onPhase?.('bidder-shielded-balance');
  const actorRecipe = await actor.wallet.balanceUnboundTransaction(
    tx as never,
    { shieldedSecretKeys: actor.shieldedSecretKeys, dustSecretKey: actor.dustSecretKey },
    { ttl, tokenKindsToBalance: ['shielded'] },
  );
  const actorBalancedTx = await actor.wallet.finalizeRecipe(actorRecipe);
  onPhase?.('operator-dust-balance');
  const sponsoredRecipe = await operator.wallet.balanceFinalizedTransaction(
    actorBalancedTx as never,
    { shieldedSecretKeys: actor.shieldedSecretKeys, dustSecretKey: operator.dustSecretKey },
    { ttl, tokenKindsToBalance: ['dust'] },
  );
  return operator.wallet.finalizeRecipe(sponsoredRecipe);
}

function providers(actor: WalletContext, operator: WalletContext, role: string, storagePassword: string) {
  const publicDataProvider = indexerPublicDataProvider(network.indexer, network.indexerWS);
  const zkConfigProvider = new NodeZkConfigProvider(artifactsDir);
  const sponsored = actor !== operator;
  let balanceActorShieldedAssets = false;
  const walletProvider = {
    getCoinPublicKey: () => actor.shieldedSecretKeys.coinPublicKey,
    getEncryptionPublicKey: () => actor.shieldedSecretKeys.encryptionPublicKey,
    async balanceTx(tx: unknown, ttl?: Date) {
      const balanceTtl = ttl ?? new Date(Date.now() + 30 * 60 * 1000);
      if (sponsored && balanceActorShieldedAssets) {
        return balanceActorShieldedThenOperatorDust(actor, operator, tx, balanceTtl);
      }
      const recipe = await operator.wallet.balanceUnboundTransaction(
        tx as never,
        { shieldedSecretKeys: actor.shieldedSecretKeys, dustSecretKey: operator.dustSecretKey },
        {
          ttl: balanceTtl,
          tokenKindsToBalance: sponsored ? ['dust'] : 'all',
        },
      );
      return operator.wallet.finalizeRecipe(recipe);
    },
    submitTx: (tx: unknown) => operator.wallet.submitTransaction(tx as never),
  };
  const privateStateProvider = levelPrivateStateProvider({
    accountId: actor.unshieldedKeystore.getBech32Address().toString(),
    midnightDbName: join(recoveryRoot, `${role}-wallet`, 'midnight-level-db'),
    privateStateStoreName: 'fair-launch-private-state',
    signingKeyStoreName: 'fair-launch-signing-keys',
    privateStoragePasswordProvider: () => storagePassword,
  });
  return {
    providers: {
      privateStateProvider,
      publicDataProvider,
      zkConfigProvider,
      proofProvider: httpClientProofProvider(network.proofServer, zkConfigProvider),
      walletProvider,
      midnightProvider: walletProvider,
    },
    publicDataProvider,
    zkConfigProvider,
    walletProvider,
    privateStateProvider,
    setActorShieldedBalancing(enabled: boolean) { balanceActorShieldedAssets = enabled; },
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
  const query = 'query FairLaunchTransaction { transactions(offset: { identifier: ' + JSON.stringify(identifier) +
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
  return module.ledger(((state as { readonly data?: unknown }).data ?? state) as never);
}

function persistPending(document: Recovery, stage: string, contractAddress?: string): void {
  assert.equal(document.pending, undefined, 'Prior action is pending; stop for manual reconciliation.');
  document.status = 'running';
  document.pending = { stage, phase: 'building', startedAt: new Date().toISOString(), ...(contractAddress ? { contractAddress } : {}) };
  persist(document);
  protectAndCheckModes();
}

async function call<Name extends CircuitName>(
  document: Recovery,
  stage: string,
  circuit: Name,
  providerSet: ReturnType<typeof providers>,
  compiled: unknown,
  address: string,
  args: CircuitArguments<Name>,
  balanceActorShieldedAssets = false,
): Promise<{ readonly result: unknown; readonly receipt: ActionReceipt; readonly transaction: IndexedTransaction }> {
  const startedAt = Date.now();
  persistPending(document, stage, address);
  try {
    providerSet.setActorShieldedBalancing(balanceActorShieldedAssets);
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
    document.failureDiagnostic = sanitizeRunnerDiagnostic(error);
    persist(document);
    protectAndCheckModes();
    throw new SafeRunnerError(`Proof/check, submission, receipt, or readback failed at ${stage}: ${document.failureDiagnostic}. Recovery is preserved; no retry is safe.`);
  } finally {
    providerSet.setActorShieldedBalancing(false);
  }
}

async function deploy(
  document: Recovery,
  providerSet: ReturnType<typeof providers>,
  compiled: unknown,
  args: DeployArguments,
): Promise<{ readonly address: string; readonly receipt: ActionReceipt; readonly transaction: IndexedTransaction }> {
  const startedAt = Date.now();
  persistPending(document, 'deploy');
  try {
    const deployment = await createUnprovenDeployTx(
      { zkConfigProvider: providerSet.zkConfigProvider, walletProvider: providerSet.walletProvider } as never,
      { compiledContract: compiled as never, args: [...args], signingKey: sampleSigningKey(), initialPrivateState: undefined } as never,
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

function expectedLedgerVectors(state: ReturnType<ContractModule['ledger']>) {
  return {
    allocations: [state.allocated0, state.allocated1, state.allocated2, state.allocated3],
    refunds: [state.refund0, state.refund1, state.refund2, state.refund3],
    tokenClaimed: [state.tokenClaimed0, state.tokenClaimed1, state.tokenClaimed2, state.tokenClaimed3],
    refundClaimed: [state.refundClaimed0, state.refundClaimed1, state.refundClaimed2, state.refundClaimed3],
    proceedsAvailable: [state.proceedsAvailable0, state.proceedsAvailable1, state.proceedsAvailable2, state.proceedsAvailable3],
    proceedsClaimed: [state.proceedsClaimed0, state.proceedsClaimed1, state.proceedsClaimed2, state.proceedsClaimed3],
    slotFunded: [state.slot0Funded, state.slot1Funded, state.slot2Funded, state.slot3Funded],
    commitments: [state.slot0Commitment, state.slot1Commitment, state.slot2Commitment, state.slot3Commitment],
  };
}

async function waitUntil(timestampSeconds: bigint): Promise<void> {
  const target = Number(timestampSeconds) * 1000 + 5_000;
  while (Date.now() < target) {
    await new Promise((resolveWait) => setTimeout(resolveWait, Math.min(5_000, target - Date.now())));
  }
}

async function writeEvidence(evidence: unknown): Promise<void> {
  mkdirSync(dirname(evidencePath), { recursive: true, mode: 0o755 });
  assert.equal(existsSync(evidencePath), false, 'Prior Fair Launch evidence exists; reconcile it before creating a new artifact.');
  const tempPath = `${evidencePath}.tmp-${process.pid}`;
  assert.equal(existsSync(tempPath), false, 'Evidence temp file exists; stop for manual reconciliation.');
  writeFileSync(tempPath, JSON.stringify(evidence, null, 2) + '\n', { flag: 'wx', mode: 0o644 });
  chmodSync(tempPath, 0o644);
  renameSync(tempPath, evidencePath);
  chmodSync(evidencePath, 0o644);
}

async function diagnoseBlockedFirstBid(): Promise<void> {
  const document = readRecoveryForDiagnostic();
  const wallets: WalletContext[] = [];
  let phase = 'loopback-readiness';
  try {
    const proofReady = await fetch(network.proofServer, { signal: AbortSignal.timeout(5_000) }).catch(() => null);
    const indexerReady = await fetch(network.indexer, { signal: AbortSignal.timeout(5_000) }).catch(() => null);
    if (!proofReady || !indexerReady) throw new SafeRunnerError('Loopback proof/indexer unavailable.');
    setNetworkId(network.networkId);
    phase = 'open-protected-wallets';
    const operator = await makeWallet(document.operatorSeedHex, 'operator', document.operatorStoragePassword, false);
    const bidder = await makeWallet(document.bidderSeedHexes[0], 'bidder-0', document.bidderStoragePasswords[0], false);
    wallets.push(operator, bidder);
    await Promise.all([operator.wallet.waitForSyncedState(), bidder.wallet.waitForSyncedState()]);
    const bidderKey = encodeCoinPublicKey(bidder.shieldedSecretKeys.coinPublicKey);
    assert.equal(Buffer.from(bidderKey).toString('hex'), document.bidderKeyHexes![0], 'Recovery bidder key does not match the reopened wallet.');
    const paymentCoinRecord = document.paymentCoins![0];
    assert.equal(await tokenBalance(bidder, paymentCoinRecord.colorHex), BigInt(paymentCoinRecord.valueAtoms),
      'The blocked bidder payment coin is not available in its shielded wallet.');

    phase = 'build-contract-call';
    const module = await import(pathToFileURL(resolve(artifactsDir, 'contract/index.js')).href) as ContractModule;
    const compiled = CompiledContract.make('fair-launch', module.Contract as never).pipe(
      CompiledContract.withWitnesses(witnesses() as never),
      CompiledContract.withCompiledFileAssets(artifactsDir),
    );
    const operatorP = providers(operator, operator, 'operator', document.operatorStoragePassword);
    const bidderP = providers(bidder, operator, 'bidder-0', document.bidderStoragePasswords[0]);
    operatorP.privateStateProvider.setContractAddress(document.contractAddress as never);
    bidderP.privateStateProvider.setContractAddress(document.contractAddress as never);
    const ledger = await readLedger(operatorP.publicDataProvider, module, document.contractAddress!);
    assert.equal(ledger.registeredBidCount, 0n, 'On-chain slot 0 is already occupied; refusing to reconstruct its call.');

    const opening = openingFromRecovery(document, 0, bidderKey);
    const paymentCoin = {
      nonce: bytes(paymentCoinRecord.nonceHex),
      color: bytes(paymentCoinRecord.colorHex),
      value: BigInt(paymentCoinRecord.valueAtoms),
    };
    const options = createCallTxOptions(compiled as never, 'registerBid' as never,
      document.contractAddress as never, undefined, undefined, [0n, opening, paymentCoin] as never);
    phase = 'create-unproven-call';
    const unsubmitted = await createUnprovenCallTx(bidderP.providers as never, options as never);
    phase = 'prove-register-call';
    const proven = await bidderP.providers.proofProvider.proveTx(unsubmitted.private.unprovenTx as never);

    phase = 'bidder-shielded-balance';
    bidderP.setActorShieldedBalancing(true);
    try {
      await bidderP.walletProvider.balanceTx(proven as never);
    } finally {
      bidderP.setActorShieldedBalancing(false);
    }
    process.stdout.write('DIAGNOSTIC PASS: registerBid proved and actor shielded + operator DUST balanced locally; no tx was submitted and recovery was not changed.\n');
  } catch (error) {
    throw new SafeRunnerError(`DIAGNOSTIC FAIL: phase=${phase}; ${sanitizeRunnerDiagnostic(error)}; no tx was submitted and recovery was not changed.`);
  } finally {
    await Promise.allSettled(wallets.map((wallet) => wallet.stop()));
  }
}

async function main(): Promise<void> {
  assertLoopbackOnly();
  const modes = ['--prepare-only', '--preflight-only', '--execute', '--diagnose-register'].filter((flag) => process.argv.includes(flag));
  if (modes.length > 1) throw new SafeRunnerError('Choose exactly one runner mode.');
  if (modes.length === 0) {
    process.stdout.write('Idle: select --prepare-only, --preflight-only, or --execute. No wallet or network activity occurred.\n');
    return;
  }
  if (modes[0] === '--diagnose-register') {
    await diagnoseBlockedFirstBid();
    return;
  }
  acquireRunnerLock();
  const mode = modes[0];
  if (mode === '--prepare-only') {
    const document = loadOrCreateRecovery();
    protectAndCheckModes();
    process.stdout.write(`PASS: protected Fair Launch recovery prepared (run=${document.runId}, status=${document.status}, modes=0700/0600); no wallet/network/transaction/Docker activity.\n`);
    return;
  }
  if (!existsSync(recoveryPath)) throw new SafeRunnerError('Prepare the protected Fair Launch recovery manifest before wallet sync.');
  const document = loadOrCreateRecovery();
  protectAndCheckModes();
  if (document.pending || document.status === 'running' || document.status === 'recovery-required' || document.status === 'complete') {
    throw new SafeRunnerError('Manifest contains prior or unresolved activity; this runner has no resume path.');
  }
  if (mode === '--execute') {
    try { assertFreshExecution(document); }
    catch { throw new SafeRunnerError('Execution requires a pristine preflighted manifest; reconcile prior activity manually.'); }
    if (existsSync(evidencePath)) throw new SafeRunnerError('Prior public evidence exists; reconcile it manually before starting a new run.');
  }

  let executionStarted = false;
  const wallets: WalletContext[] = [];
  try {
    const proofReady = await fetch(network.proofServer, { signal: AbortSignal.timeout(5_000) }).catch(() => null);
    const indexerReady = await fetch(network.indexer, { signal: AbortSignal.timeout(5_000) }).catch(() => null);
    if (!proofReady || !indexerReady) throw new SafeRunnerError('Loopback Local Devnet proof/indexer endpoint unavailable; no Docker action was attempted.');
    setNetworkId(network.networkId);
    const operator = await makeWallet(document.operatorSeedHex, 'operator', document.operatorStoragePassword); wallets.push(operator);
    const bidderWallets = await Promise.all(document.bidderSeedHexes.map((seed, slot) =>
      makeWallet(seed, `bidder-${slot}`, document.bidderStoragePasswords[slot])));
    wallets.push(...bidderWallets);
    const allWallets = [operator, ...bidderWallets];
    const keys = allWallets.map((wallet) => Buffer.from(encodeCoinPublicKey(wallet.shieldedSecretKeys.coinPublicKey)).toString('hex'));
    assert.equal(new Set(keys).size, keys.length, 'Operator and four bidder shielded keys must be distinct.');
    document.operatorKeyHex = keys[0];
    document.bidderKeyHexes = keys.slice(1) as [string, string, string, string];
    const [operatorState, ...bidderStates] = await Promise.all(allWallets.map((wallet) => wallet.wallet.waitForSyncedState()));
    const operatorDust = operatorState.dust.balance(new Date());
    const operatorNative = operatorState.unshielded.balances[nativeToken().raw] ?? 0n;
    if (operatorDust <= 0n) throw new SafeRunnerError('Genesis operator wallet has no DUST for sponsorship; no transaction submitted.');
    if (bidderStates.some((state) => (state.unshielded.balances[nativeToken().raw] ?? 0n) !== 0n)) {
      throw new SafeRunnerError('A fresh bidder wallet unexpectedly holds native test token.');
    }
    document.preflight = {
      checkedAt: new Date().toISOString(), operatorDustRaw: operatorDust.toString(), operatorNativeRaw: operatorNative.toString(),
      distinctShieldedKeys: true, feeSponsor: 'Local Devnet genesis operator wallet',
    };
    document.status = 'preflighted';
    persist(document); protectAndCheckModes();
    if (mode === '--preflight-only') {
      process.stdout.write(`PASS: read-only Fair Launch loopback preflight; operator DUST=${operatorDust}; all five shielded keys distinct; recovery modes=0700/0600; no transaction submitted.\n`);
      return;
    }

    executionStarted = true;
    document.status = 'running'; persist(document); protectAndCheckModes();
    const module = await import(pathToFileURL(resolve(artifactsDir, 'contract/index.js')).href) as ContractModule;
    const compiled = CompiledContract.make('fair-launch', module.Contract as never).pipe(
      CompiledContract.withWitnesses(witnesses() as never),
      CompiledContract.withCompiledFileAssets(artifactsDir),
    );
    const providerSets = [operator, ...bidderWallets].map((wallet, index) =>
      providers(wallet, operator, index === 0 ? 'operator' : `bidder-${index - 1}`,
        index === 0 ? document.operatorStoragePassword : document.bidderStoragePasswords[index - 1]));
    const operatorP = providerSets[0];
    const bidderProviders = providerSets.slice(1);
    const operatorKey = encodeCoinPublicKey(operator.shieldedSecretKeys.coinPublicKey);
    const networkDomain = bytes(document.networkDomainHex);
    const paymentDomain = module.pureCircuits.paymentTestTokenDomain();
    const saleDomain = module.pureCircuits.saleTestTokenDomain();
    document.paymentTokenDomainHex = Buffer.from(paymentDomain).toString('hex');
    document.saleTokenDomainHex = Buffer.from(saleDomain).toString('hex');
    persist(document); protectAndCheckModes();
    const authoritySecret = bytes(document.inventoryAuthoritySecretHex);
    const authorityCommitment = module.pureCircuits.deriveInventoryAuthorityCommitment(networkDomain, authoritySecret);
    const nowSeconds = BigInt(Math.floor(Date.now() / 1000));
    const commitDeadline = nowSeconds + BigInt(commitWindowSeconds);
    const openDeadline = commitDeadline + BigInt(openWindowSeconds);
    document.commitDeadline = commitDeadline.toString();
    document.openDeadline = openDeadline.toString();
    const deployment = await deploy(document, operatorP, compiled, [
      networkDomain, inventory, reservePrice, depositLot, commitDeadline, openDeadline,
      paymentDomain, saleDomain, authorityCommitment, { bytes: operatorKey },
    ]);
    const address = deployment.address;
    document.contractAddress = address;
    for (const set of providerSets) set.privateStateProvider.setContractAddress(address as never);
    const contractBytes = encodeContractAddress(address as never);

    const saleMint = await call(document, 'mint-sale-inventory', 'mintTestSaleCoin', operatorP, compiled, address,
      [inventory, bytes(randomBytes(32).toString('hex')), authoritySecret]);
    document.saleCoin = asCoin(saleMint.result); persist(document); protectAndCheckModes();
    assert.equal(BigInt(document.saleCoin.valueAtoms), inventory);
    const saleColorHex = document.saleCoin.colorHex;
    assert.equal(await tokenBalance(operator, saleColorHex), inventory, 'Operator must hold the test sale inventory before funding.');
    let inventoryState = await readLedger(operatorP.publicDataProvider, module, address);
    assert.equal(inventoryState.saleInventoryMinted, true, 'Finalized sale mint must set the one-time mint state before funding.');
    assert.equal(inventoryState.saleInventoryFunded, false, 'Inventory cannot already be funded before the first funding action.');
    const saleCoin = { nonce: bytes(document.saleCoin.nonceHex), color: bytes(document.saleCoin.colorHex), value: BigInt(document.saleCoin.valueAtoms) };
    await call(document, 'fund-contract-inventory', 'fundSaleInventory', operatorP, compiled, address, [saleCoin, authoritySecret]);
    assert.equal(await tokenBalance(operator, saleColorHex), 0n, 'Funded sale inventory must leave the operator wallet.');
    inventoryState = await readLedger(operatorP.publicDataProvider, module, address);
    assert.equal(inventoryState.saleInventoryFunded, true, 'Finalized inventory funding must be visible in the contract ledger.');

    const paymentCoinRecords: CoinRecord[] = [];
    for (let slot = 0; slot < 4; slot += 1) {
      const minted = await call(document, `mint-payment-lot-${slot}`, 'mintTestPaymentCoin', bidderProviders[slot], compiled, address,
        [depositLot, bytes(randomBytes(32).toString('hex'))]);
      const coin = asCoin(minted.result);
      assert.equal(BigInt(coin.valueAtoms), depositLot, `Bidder ${slot} payment lot does not match the fixed deposit.`);
      paymentCoinRecords.push(coin);
      const balance = await tokenBalance(bidderWallets[slot], coin.colorHex);
      assert.equal(balance, depositLot, `Bidder ${slot} wallet must discover its real shielded payment lot.`);
    }
    assert.equal(new Set(paymentCoinRecords.map((coin) => coin.colorHex)).size, 1, 'All payment test coins must share one token domain/color.');
    const paymentColorHex = paymentCoinRecords[0].colorHex;
    document.paymentCoins = paymentCoinRecords as [CoinRecord, CoinRecord, CoinRecord, CoinRecord];
    persist(document); protectAndCheckModes();

    const openings = bidderWallets.map((wallet, slot) => openingFromRecovery(
      document, slot, encodeCoinPublicKey(wallet.shieldedSecretKeys.coinPublicKey),
    )) as [BidOpening, BidOpening, BidOpening, BidOpening];
    const commitmentHexes = openings.map((opening, slot) => Buffer.from(
      module.pureCircuits.computeBidCommitment(networkDomain, contractBytes, BigInt(slot), opening),
    ).toString('hex')) as [string, string, string, string];
    assert.equal(new Set(commitmentHexes).size, 4, 'Each bidder must register a unique commitment.');
    document.bidCommitmentHexes = commitmentHexes as [string, string, string, string];
    persist(document); protectAndCheckModes();

    for (let slot = 0; slot < 4; slot += 1) {
      const coin = paymentCoinRecords[slot];
      const payment = { nonce: bytes(coin.nonceHex), color: bytes(coin.colorHex), value: BigInt(coin.valueAtoms) };
      await call(document, `register-bid-${slot}`, 'registerBid', bidderProviders[slot], compiled, address,
        [BigInt(slot), openings[slot], payment], true);
      const state = await readLedger(bidderProviders[slot].publicDataProvider, module, address);
      assert.equal(state.registeredBidCount, BigInt(slot + 1), 'Registered bid count must advance exactly once per finalized call.');
      const registered = expectedLedgerVectors(state).commitments[slot];
      assert.equal(Buffer.from(registered).toString('hex'), commitmentHexes[slot], `Slot ${slot} commitment does not match indexer readback.`);
      assert.equal(expectedLedgerVectors(state).slotFunded[slot], true, `Slot ${slot} must be funded by an actual deposit coin.`);
      assert.equal(await tokenBalance(bidderWallets[slot], paymentColorHex), 0n, `Slot ${slot} escrow coin must leave the bidder wallet.`);
    }

    await waitUntil(commitDeadline);
    await call(document, 'settle-four-registered-bids', 'settle', operatorP, compiled, address,
      [true, 10n, 300n, 300n, 0n, 0n, ...openings]);
    let state = await readLedger(operatorP.publicDataProvider, module, address);
    assert.equal(state.registeredBidCount, 4n);
    assert.equal(state.settled, true);
    assert.equal(state.cancelled, false);
    assert.equal(state.clearingPrice, 10n);
    let vectors = expectedLedgerVectors(state);
    assert.deepEqual(vectors.allocations, [...expectedAllocations]);
    assert.deepEqual(vectors.refunds, [...expectedRefunds]);
    assert.deepEqual(vectors.commitments.map((value) => Buffer.from(value).toString('hex')), commitmentHexes);
    assert.equal(vectors.allocations.reduce<bigint>((sum, value) => sum + value, 0n), inventory);
    assert.equal(vectors.refunds.reduce<bigint>((sum, value) => sum + value, 0n) + state.clearingPrice * inventory, 20_000n);

    for (let slot = 0; slot < 4; slot += 1) {
      await call(document, `claim-refund-${slot}`, 'claimRefund', bidderProviders[slot], compiled, address,
        [BigInt(slot), openings[slot]]);
      await bidderWallets[slot].wallet.waitForSyncedState();
      assert.equal(await tokenBalance(bidderWallets[slot], paymentColorHex), expectedRefunds[slot], `Bidder ${slot} did not receive the expected shielded refund.`);
    }
    for (const slot of [0, 1]) {
      await call(document, `claim-sale-proceeds-${slot}`, 'claimProceeds', operatorP, compiled, address, [BigInt(slot)]);
      await operator.wallet.waitForSyncedState();
      assert.equal(await tokenBalance(operator, paymentColorHex), BigInt((slot + 1) * 3_000), `Sale recipient did not discover proceeds from winning slot ${slot}.`);
    }
    for (const slot of [0, 1]) {
      await call(document, `claim-sale-tokens-${slot}`, 'claimTokens', bidderProviders[slot], compiled, address,
        [BigInt(slot), openings[slot]]);
      await bidderWallets[slot].wallet.waitForSyncedState();
      assert.equal(await tokenBalance(bidderWallets[slot], saleColorHex), expectedAllocations[slot], `Winner ${slot} did not receive the expected shielded sale tokens.`);
    }
    assert.equal(await tokenBalance(bidderWallets[2], saleColorHex), 0n);
    assert.equal(await tokenBalance(bidderWallets[3], saleColorHex), 0n);
    assert.equal(await tokenBalance(operator, paymentColorHex), 6_000n, 'Treasury must receive the two winners\' clearing-price payments.');

    state = await readLedger(operatorP.publicDataProvider, module, address);
    vectors = expectedLedgerVectors(state);
    assert.deepEqual(vectors.tokenClaimed, [true, true, false, false]);
    assert.deepEqual(vectors.refundClaimed, [true, true, true, true]);
    assert.deepEqual(vectors.proceedsClaimed, [true, true, false, false]);
    assert.deepEqual(vectors.slotFunded, [true, true, true, true]);
    assert.equal(state.inventoryRemainderAvailable, false, 'All sale inventory must have been claimed by the two winners.');
    assert.equal(state.settled, true);

    const actionAudit: { stage: string; txId: string; transactionHash: string; blockHeight: number; entryPoint: string }[] = [];
    for (const [stage, receipt] of Object.entries(document.actions)) {
      const indexed = await queryTransaction(receipt.txId, receipt.blockHeight);
      assert.equal(indexed.hash, receipt.transactionHash, `Final receipt audit changed transaction hash for ${stage}.`);
      actionAudit.push({ stage, txId: receipt.txId, transactionHash: indexed.hash, blockHeight: indexed.block.height, entryPoint: receipt.entryPoint });
    }
    const evidence = {
      checkedAt: new Date().toISOString(),
      mode: 'actual Local Devnet; loopback endpoints only; valueless test assets; no Docker start/reset',
      runId: document.runId,
      contractAddress: address,
      productBoundary: 'four fixed sealed-bid slots with on-chain uniform-price settlement and shielded self-claims; no bonding curve or production token',
      fixture: {
        inventoryAtoms: inventory.toString(),
        reservePriceAtoms: reservePrice.toString(),
        depositLotAtomsPerRegisteredBid: depositLot.toString(),
        registeredBidCount: Number(state.registeredBidCount),
        occupiedSlots: 4,
        perSlotDepositedAtoms: paymentCoinRecords.map((coin) => coin.valueAtoms),
        slotFunded: vectors.slotFunded,
        bidPublications: 'Commitment hashes only; bid prices, quantities, salts and recipient keys are omitted from public evidence.',
        expectedOutcome: {
          clearingPriceAtoms: '10',
          allocationsAtoms: expectedAllocations.map(String),
          refundsAtoms: expectedRefunds.map(String),
          totalDepositedAtoms: '20000',
          totalClearingPaymentAtoms: '6000',
          totalRefundedAtoms: '14000',
        },
      },
      readback: {
        settled: state.settled,
        cancelled: state.cancelled,
        clearingPriceAtoms: state.clearingPrice.toString(),
        allocationsAtoms: vectors.allocations.map(String),
        refundsAtoms: vectors.refunds.map(String),
        tokenClaimed: vectors.tokenClaimed,
        refundClaimed: vectors.refundClaimed,
        proceedsAvailable: vectors.proceedsAvailable,
        proceedsClaimed: vectors.proceedsClaimed,
        slotFunded: vectors.slotFunded,
        inventoryRemainderAvailable: state.inventoryRemainderAvailable,
        bidderPaymentBalancesAtoms: await Promise.all(bidderWallets.map(async (wallet) => (await tokenBalance(wallet, paymentColorHex)).toString())),
        bidderSaleBalancesAtoms: await Promise.all(bidderWallets.map(async (wallet) => (await tokenBalance(wallet, saleColorHex)).toString())),
        treasuryPaymentBalanceAtoms: (await tokenBalance(operator, paymentColorHex)).toString(),
        operatorRemainingSaleBalanceAtoms: (await tokenBalance(operator, saleColorHex)).toString(),
      },
      publicDisclosure: [
        'Registration slots, commitment hashes and fixed 5,000-unit deposits are public; registration timing may link a slot to wallet activity.',
        'After settlement, clearing price, per-slot allocations, refunds and claim flags are public. Given the fixed deposits, observers can derive each slot\'s charge and infer allocated quantity from the public clearing price.',
        'The runner does not parse raw transaction encodings to verify disclosure of max prices, quantities, salts or recipient keys; no lifetime bid-size privacy claim is made.',
      ],
      privacyBoundary: 'The circuit accepts bid openings as private inputs and stores commitments in the public ledger. This run verifies contract state and claims, not raw transaction privacy.',
      receipts: actionAudit,
      feeSponsorDustRaw: document.preflight?.operatorDustRaw ?? 'unknown',
      implementationLimit: 'Shielded test asset claims are verified for this Local Devnet fixture; no production token or launch-market guarantee is established.',
    };
    await writeEvidence(evidence);
    document.status = 'complete'; document.pending = undefined; persist(document); protectAndCheckModes();
    process.stdout.write('PASS: four registered shielded bids settled at 10; four refund claims and two token claims read back from bidder wallets; treasury received 6000 test units; actual tx IDs saved.\n');
  } catch (error) {
    if (executionStarted || document.pending) {
      preserveRunnerLock = true;
      document.status = 'recovery-required';
      document.failureStage = (document.pending as Pending | undefined)?.stage ?? 'preflight-or-acceptance';
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
  process.stderr.write(`Fair Launch runner stopped: ${message}\n`);
  process.exitCode = 1;
});
