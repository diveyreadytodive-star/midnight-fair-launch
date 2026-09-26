import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import {
  chmodSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync,
  readFileSync, readdirSync, renameSync, writeFileSync,
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

Reflect.set(globalThis as object, 'WebSocket', WebSocket);

const spikeDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const projectDir = resolve(spikeDir, '../..');
const artifactsDir = resolve(spikeDir, 'generated/perp_settlement');
const evidencePath = resolve(spikeDir, 'docs/evidence/local-chain-p90-settlement.json');
const recoveryRoot = resolve(projectDir, '.local/perp-settlement-recovery');
const recoveryPath = join(recoveryRoot, 'recovery.json');
const collateralAtoms = 1_000_000_000n;
const reserveAtoms = 500_000_000n;
const notionalAtoms = 5_000_000_000n;
const entryTicks = 100_000_000_000n;
const p90Ticks = 90_000_000_000n;
const guardBufferAtoms = 255_000_000n;

class SafeRunnerError extends Error {}

type WalletContext = Awaited<ReturnType<typeof createSilenceWallet>> & {
  readonly unshieldedKeystore: ReturnType<typeof createKeystore>;
};
type StoredCoin = { readonly nonceHex: string; readonly colorHex: string; readonly valueAtoms: string };
type Receipt = { readonly txId: string; readonly status: 'SucceedEntirely'; readonly blockHeight: number; readonly durationMs: number; readonly transactionHash: string };
type StoredAction = Omit<Receipt, 'durationMs'> & { readonly durationMs: number; readonly entryPoint: string };
type Pending = { readonly stage: string; readonly phase: 'building' | 'submitted'; readonly startedAt: string; readonly txId?: string; readonly contractAddress?: string };
type Recovery = {
  readonly version: 1;
  readonly runId: string;
  readonly createdAt: string;
  status: 'prepared' | 'running' | 'complete' | 'recovery-required';
  readonly ownerSeedHex: string;
  readonly operatorSeedHex: string;
  readonly lpSeedHex: string;
  readonly oracleSeedHex: string;
  readonly ownerStoragePassword: string;
  readonly operatorStoragePassword: string;
  readonly lpStoragePassword: string;
  readonly oracleStoragePassword: string;
  readonly networkDomainHex: string;
  readonly ownerSecretHex: string;
  readonly operatorSecretHex: string;
  readonly lpSecretHex: string;
  readonly oracleSecretHex: string;
  readonly positionSaltHex: string;
  readonly ownerRecipientSaltHex: string;
  readonly lpRecipientSaltHex: string;
  actions: Record<string, StoredAction>;
  ownerCoin?: StoredCoin;
  lpReserveCoin?: StoredCoin;
  contractAddress?: string;
  ownerKeyHex?: string;
  operatorKeyHex?: string;
  lpKeyHex?: string;
  oracleKeyHex?: string;
  pending?: Pending;
  preflight?: { readonly checkedAt: string; readonly ownerDustRaw: string; readonly ownerNightRaw: string; readonly distinctShieldedKeys: boolean };
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
    readonly deriveOraclePublisherCommitment: (networkDomain: Uint8Array, secret: Uint8Array) => Uint8Array;
    readonly deriveLpIdentityCommitment: (networkDomain: Uint8Array, secret: Uint8Array) => Uint8Array;
    readonly deriveOperatorIdentityCommitment: (networkDomain: Uint8Array, contractAddress: Uint8Array, secret: Uint8Array) => Uint8Array;
  };
  readonly ledger: (state: unknown) => {
    readonly networkDomain: Uint8Array;
    readonly oraclePriceTicks: bigint;
    readonly oracleSequence: bigint;
    readonly oraclePublishedAt: bigint;
    readonly positionEntryOraclePriceTicks: bigint;
    readonly positionEntryOracleSequence: bigint;
    readonly settlementOraclePriceTicks: bigint;
    readonly settlementOracleSequence: bigint;
    readonly traderCoin: { readonly value: bigint; readonly mt_index: bigint };
    readonly reserveCoin: { readonly value: bigint; readonly mt_index: bigint };
    readonly lpCollateralRemainderCoin: { readonly value: bigint; readonly mt_index: bigint };
    readonly reserveFunded: boolean;
    readonly lpCollateralRemainderClaimable: boolean;
    readonly positionActive: boolean;
    readonly closedUnclaimed: boolean;
    readonly settled: boolean;
  };
};

const network = localTestNetwork('perp-settlement-recovery-only');

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
    assert.equal(stat.isSymbolicLink(), false, 'Refusing a symlink in the recovery tree.');
    assert.equal(stat.isDirectory(), true, 'Recovery path is not a directory.');
  } else mkdirSync(path, { mode: 0o700 });
  chmodSync(path, 0o700);
}

function secureTree(path: string): void {
  if (!existsSync(path)) return;
  const stat = lstatSync(path);
  assert.equal(stat.isSymbolicLink(), false, 'Refusing a symlink in the recovery tree.');
  if (stat.isDirectory()) {
    chmodSync(path, 0o700);
    for (const name of readdirSync(path)) secureTree(join(path, name));
  } else chmodSync(path, 0o600);
}

function persist(document: Recovery): void {
  ensurePrivateDirectory(recoveryRoot);
  const temp = `${recoveryPath}.tmp-${process.pid}`;
  assert.equal(existsSync(temp), false, 'Recovery temp file exists; manual reconciliation required.');
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

function secureModes(): void {
  secureTree(recoveryRoot);
  assert.equal(lstatSync(recoveryRoot).mode & 0o777, 0o700, 'Recovery directory must be mode 0700.');
  assert.equal(lstatSync(recoveryPath).mode & 0o777, 0o600, 'Recovery manifest must be mode 0600.');
}

function loadOrCreateRecovery(): Recovery {
  ensurePrivateDirectory(resolve(projectDir, '.local'));
  ensurePrivateDirectory(recoveryRoot);
  if (existsSync(recoveryPath)) {
    assert.equal(lstatSync(recoveryPath).isSymbolicLink(), false, 'Recovery manifest cannot be a symlink.');
    chmodSync(recoveryPath, 0o600);
    const value = JSON.parse(readFileSync(recoveryPath, 'utf8')) as Recovery;
    assert.equal(value.version, 1, 'Unsupported recovery manifest version.');
    return value;
  }
  const ownerSeed = process.env.SILENCE_LOCAL_TEST_SEED?.trim() ?? '';
  delete process.env.SILENCE_LOCAL_TEST_SEED;
  if (!/^(?:[0-9a-fA-F]{2}){32}$/.test(ownerSeed)) {
    throw new SafeRunnerError('Set SILENCE_LOCAL_TEST_SEED to the 32-byte valueless Local Devnet genesis seed. Preprod wallet files are never read.');
  }
  const document: Recovery = {
    version: 1,
    runId: randomUUID(),
    createdAt: new Date().toISOString(),
    status: 'prepared',
    ownerSeedHex: ownerSeed,
    operatorSeedHex: randomBytes(32).toString('hex'),
    lpSeedHex: randomBytes(32).toString('hex'),
    oracleSeedHex: randomBytes(32).toString('hex'),
    ownerStoragePassword: randomBytes(32).toString('hex'),
    operatorStoragePassword: randomBytes(32).toString('hex'),
    lpStoragePassword: randomBytes(32).toString('hex'),
    oracleStoragePassword: randomBytes(32).toString('hex'),
    networkDomainHex: createHash('sha256').update(`SILENCE/PERP-SETTLEMENT/LOCAL-DEVNET/v1/${randomUUID()}`).digest('hex'),
    ownerSecretHex: randomBytes(32).toString('hex'),
    operatorSecretHex: randomBytes(32).toString('hex'),
    lpSecretHex: randomBytes(32).toString('hex'),
    oracleSecretHex: randomBytes(32).toString('hex'),
    positionSaltHex: randomBytes(32).toString('hex'),
    ownerRecipientSaltHex: randomBytes(32).toString('hex'),
    lpRecipientSaltHex: randomBytes(32).toString('hex'),
    actions: {},
  };
  persist(document);
  secureModes();
  return document;
}

function bytes(hex: string): Uint8Array { return Uint8Array.from(Buffer.from(hex, 'hex')); }
function coinRecord(value: unknown): StoredCoin {
  const coin = value as { readonly nonce?: Uint8Array; readonly color?: Uint8Array; readonly value?: bigint } | undefined;
  assert.ok(coin?.nonce instanceof Uint8Array && coin.color instanceof Uint8Array && typeof coin.value === 'bigint', 'Mint circuit returned no shielded coin witness.');
  return { nonceHex: Buffer.from(coin.nonce).toString('hex'), colorHex: Buffer.from(coin.color).toString('hex'), valueAtoms: coin.value.toString() };
}

async function makeWallet(seedHex: string, name: string, password: string): Promise<WalletContext> {
  const directory = join(recoveryRoot, `${name}-wallet`);
  ensurePrivateDirectory(directory);
  const config = { ...localTestNetwork(password), privateStateDir: join(directory, 'private-state') };
  ensurePrivateDirectory(config.privateStateDir);
  const context = await createSilenceWallet(seedHex, config);
  const hd = HDWallet.fromSeed(Buffer.from(seedHex, 'hex'));
  if (hd.type !== 'seedOk') throw new SafeRunnerError(`${name} test wallet seed could not be derived.`);
  const derived = hd.hdWallet.selectAccount(0).selectRoles([Roles.Zswap, Roles.NightExternal, Roles.Dust]).deriveKeysAt(0);
  if (derived.type !== 'keysDerived') { hd.hdWallet.clear(); throw new SafeRunnerError(`${name} wallet role keys could not be derived.`); }
  const keyStore = createKeystore(derived.keys[Roles.NightExternal], config.networkId);
  hd.hdWallet.clear();
  assert.equal(keyStore.getBech32Address().toString(), context.accountId);
  secureTree(directory);
  return { ...context, unshieldedKeystore: keyStore };
}

function providers(actor: WalletContext, sponsor: WalletContext, name: string, password: string) {
  const publicDataProvider = indexerPublicDataProvider(network.indexer, network.indexerWS);
  const zkConfigProvider = new NodeZkConfigProvider(artifactsDir);
  const sponsored = actor !== sponsor;
  const walletProvider = {
    getCoinPublicKey: () => actor.shieldedSecretKeys.coinPublicKey,
    getEncryptionPublicKey: () => actor.shieldedSecretKeys.encryptionPublicKey,
    async balanceTx(tx: unknown, ttl?: Date) {
      const recipe = await sponsor.wallet.balanceUnboundTransaction(
        tx as never,
        { shieldedSecretKeys: actor.shieldedSecretKeys, dustSecretKey: sponsor.dustSecretKey },
        { ttl: ttl ?? new Date(Date.now() + 30 * 60 * 1000), tokenKindsToBalance: sponsored ? ['dust'] : 'all' },
      );
      return sponsor.wallet.finalizeRecipe(recipe);
    },
    submitTx: (tx: unknown) => sponsor.wallet.submitTransaction(tx as never),
  };
  const privateStateProvider = levelPrivateStateProvider({
    accountId: actor.unshieldedKeystore.getBech32Address().toString(),
    midnightDbName: join(recoveryRoot, `${name}-wallet`, 'midnight-level-db'),
    privateStateStoreName: 'perp-settlement-private-state',
    signingKeyStoreName: 'perp-settlement-signing-keys',
    privateStoragePasswordProvider: () => password,
  });
  return {
    providers: { privateStateProvider, publicDataProvider, zkConfigProvider, proofProvider: httpClientProofProvider(network.proofServer, zkConfigProvider), walletProvider, midnightProvider: walletProvider },
    publicDataProvider, zkConfigProvider, walletProvider, privateStateProvider,
  };
}

async function shieldedBalance(wallet: WalletContext, colorHex: string): Promise<bigint> {
  const state = await wallet.wallet.waitForSyncedState();
  return state.shielded.balances[colorHex] ?? 0n;
}

async function receipt(provider: ReturnType<typeof indexerPublicDataProvider>, txId: string) {
  const result = await provider.watchForTxData(txId);
  assert.equal(result.status, 'SucceedEntirely', 'Transaction did not finalize successfully.');
  assert.equal(typeof result.blockHeight, 'number');
  return { txId, status: 'SucceedEntirely' as const, blockHeight: result.blockHeight! };
}

async function queryTransaction(txId: string, height: number): Promise<IndexedTransaction> {
  const identifier = txId.replace(/^0x/i, '');
  assert.match(identifier, /^[0-9a-fA-F]{66}$/, 'Unexpected SDK transaction identifier format.');
  const query = 'query PerpSettlementTransaction { transactions(offset: { identifier: ' + JSON.stringify(identifier) +
    ' }) { hash raw block { height } contractActions { __typename ... on ContractCall { address entryPoint state zswapState } } } }';
  const response = await fetch(network.indexer, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query }) });
  if (!response.ok) throw new SafeRunnerError('Loopback indexer transaction read failed.');
  const body = await response.json() as { readonly data?: { readonly transactions?: readonly IndexedTransaction[] }; readonly errors?: readonly unknown[] };
  if (body.errors?.length) throw new SafeRunnerError('Loopback indexer rejected transaction query.');
  const found = body.data?.transactions?.[0];
  assert.ok(found && typeof found.raw === 'string', 'Finalized transaction raw bytes are unavailable.');
  assert.equal(found.block.height, height, 'Indexer and receipt block heights differ.');
  return found;
}

async function readLedger(provider: ReturnType<typeof indexerPublicDataProvider>, module: ContractModule, address: string) {
  const state = await provider.queryContractState(address as never);
  assert.ok(state, 'Loopback contract ledger is unavailable.');
  return module.ledger((state as { readonly data?: unknown }).data ?? state);
}

function persistBeforeAction(document: Recovery, stage: string, contractAddress?: string): void {
  assert.equal(document.pending, undefined, 'A pending action exists; do not replay this sequence.');
  document.status = 'running';
  document.pending = { stage, phase: 'building', startedAt: new Date().toISOString(), ...(contractAddress ? { contractAddress } : {}) };
  persist(document);
  secureModes();
}

async function call(
  document: Recovery,
  stage: string,
  circuit: string,
  providerSet: ReturnType<typeof providers>,
  compiled: unknown,
  address: string,
  args: readonly unknown[],
): Promise<{ readonly result: unknown; readonly receipt: Receipt; readonly transaction: IndexedTransaction; readonly action: IndexedTransaction['contractActions'][number] }> {
  const started = Date.now();
  persistBeforeAction(document, stage, address);
  try {
    const options = createCallTxOptions(compiled as never, circuit as never, address as never, undefined, undefined, [...args] as never);
    const submitted = await submitCallTxAsync(providerSet.providers as never, options as never);
    document.pending = { ...document.pending!, phase: 'submitted', txId: submitted.txId };
    persist(document);
    const confirmed = await receipt(providerSet.publicDataProvider, submitted.txId);
    const transaction = await queryTransaction(submitted.txId, confirmed.blockHeight);
    const action = transaction.contractActions.find((candidate) => candidate.entryPoint === circuit);
    assert.ok(action, `Indexed action does not match circuit ${circuit}.`);
    if (action.address) assert.equal(action.address, address);
    const saved: StoredAction = { ...confirmed, durationMs: Date.now() - started, transactionHash: transaction.hash, entryPoint: circuit };
    document.actions[stage] = saved;
    document.pending = undefined;
    persist(document);
    secureModes();
    return { result: (submitted.callTxData as { readonly private?: { readonly result?: unknown } }).private?.result, receipt: { ...saved }, transaction, action };
  } catch (error) {
    document.status = 'recovery-required';
    document.failureStage = stage;
    document.failureClass = error instanceof Error ? error.name : 'UnknownError';
    persist(document);
    secureModes();
    throw new SafeRunnerError(`Proof/check, submit, receipt, or readback failed at ${stage}. Recovery is preserved; do not retry or submit another transaction until manually reconciled.`);
  }
}

async function deploy(
  document: Recovery,
  providerSet: ReturnType<typeof providers>,
  module: ContractModule,
  compiled: unknown,
): Promise<{ readonly address: string; readonly receipt: Receipt; readonly transaction: IndexedTransaction }> {
  const started = Date.now();
  persistBeforeAction(document, 'deploy');
  try {
    const domain = bytes(document.networkDomainHex);
    const oracleCommitment = module.pureCircuits.deriveOraclePublisherCommitment(domain, bytes(document.oracleSecretHex));
    const lpCommitment = module.pureCircuits.deriveLpIdentityCommitment(domain, bytes(document.lpSecretHex));
    const deployment = await createUnprovenDeployTx(
      { zkConfigProvider: providerSet.zkConfigProvider, walletProvider: providerSet.walletProvider } as never,
      { compiledContract: compiled as never, args: [domain, oracleCommitment, lpCommitment], signingKey: sampleSigningKey(), initialPrivateState: undefined } as never,
    );
    const address = String(deployment.public.contractAddress);
    document.contractAddress = address;
    document.pending = { ...document.pending!, contractAddress: address };
    persist(document);
    const txId = await submitTxAsync(providerSet.providers as never, { unprovenTx: deployment.private.unprovenTx } as never);
    document.pending = { ...document.pending!, phase: 'submitted', txId };
    persist(document);
    const confirmed = await receipt(providerSet.publicDataProvider, txId);
    const transaction = await queryTransaction(txId, confirmed.blockHeight);
    const deployedState = await providerSet.publicDataProvider.queryContractState(address as never);
    assert.ok(deployedState, 'Deployed contract missing from loopback indexer.');
    const saved: StoredAction = { ...confirmed, durationMs: Date.now() - started, transactionHash: transaction.hash, entryPoint: 'deploy' };
    document.actions.deploy = saved;
    document.pending = undefined;
    persist(document);
    secureModes();
    return { address, receipt: saved, transaction };
  } catch (error) {
    document.status = 'recovery-required';
    document.failureStage = 'deploy';
    document.failureClass = error instanceof Error ? error.name : 'UnknownError';
    persist(document);
    secureModes();
    throw new SafeRunnerError('Deployment proof/check, submit, receipt, or readback failed. Recovery is preserved; reconcile before any retry.');
  }
}

function markRecoveryRequired(document: Recovery, stage: string, error: unknown): void {
  document.status = 'recovery-required';
  document.failureStage = stage;
  document.failureClass = error instanceof Error ? error.name : 'UnknownError';
  persist(document);
  secureModes();
}

function currentPendingStage(document: Recovery): string | undefined {
  return document.pending?.stage;
}

function coinFromStored(value: StoredCoin) {
  return { nonce: bytes(value.nonceHex), color: bytes(value.colorHex), value: BigInt(value.valueAtoms) };
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
  const prepare = process.argv.includes('--prepare-only');
  const preflightOnly = process.argv.includes('--preflight-only');
  const execute = process.argv.includes('--execute');
  if ([prepare, preflightOnly, execute].filter(Boolean).length > 1) throw new SafeRunnerError('Choose exactly one runner mode.');
  if (prepare) {
    const document = loadOrCreateRecovery();
    secureModes();
    process.stdout.write(`PASS: protected test recovery saved (run=${document.runId}, status=${document.status}, modes=0700/0600); no wallet sync, network call, transaction, or Docker action.\n`);
    return;
  }
  if (!preflightOnly && !execute) {
    process.stdout.write('Idle: use --prepare-only, --preflight-only, or --execute. No wallet or network activity occurred.\n');
    return;
  }
  if (!existsSync(recoveryPath)) throw new SafeRunnerError('Protected manifest missing; prepare it before wallet sync or any transaction.');
  const document = loadOrCreateRecovery();
  secureModes();
  if (document.pending || document.status === 'recovery-required') throw new SafeRunnerError('Recovery contains an unresolved action; refusing all replay. Reconcile manually first.');
  if (execute && document.status === 'complete') throw new SafeRunnerError('This acceptance run is complete and cannot be replayed.');
  if (execute) {
    try { assertFreshExecution(document); }
    catch { throw new SafeRunnerError('Execute is allowed only for a pristine prepared manifest. This runner has no resume path; reconcile any prior activity manually.'); }
  }

  setNetworkId(network.networkId);
  const proofReady = await fetch(network.proofServer, { signal: AbortSignal.timeout(5_000) }).catch(() => null);
  const indexerReady = await fetch(network.indexer, { signal: AbortSignal.timeout(5_000) }).catch(() => null);
  if (!proofReady || !indexerReady) throw new SafeRunnerError('Loopback Local Devnet proof/indexer endpoint unavailable. Runner never starts or resets Docker.');

  const ownerDir = join(recoveryRoot, 'owner-wallet');
  const operatorDir = join(recoveryRoot, 'operator-wallet');
  const lpDir = join(recoveryRoot, 'lp-wallet');
  const oracleDir = join(recoveryRoot, 'oracle-wallet');
  const wallets: WalletContext[] = [];
  let executionStarted = false;
  try {
    const owner = await makeWallet(document.ownerSeedHex, 'owner', document.ownerStoragePassword); wallets.push(owner);
    const operator = await makeWallet(document.operatorSeedHex, 'operator', document.operatorStoragePassword); wallets.push(operator);
    const lp = await makeWallet(document.lpSeedHex, 'lp', document.lpStoragePassword); wallets.push(lp);
    const oracle = await makeWallet(document.oracleSeedHex, 'oracle', document.oracleStoragePassword); wallets.push(oracle);
    const keys = [owner, operator, lp, oracle].map((wallet) => Buffer.from(encodeCoinPublicKey(wallet.shieldedSecretKeys.coinPublicKey)).toString('hex'));
    assert.equal(new Set(keys).size, keys.length, 'Owner/operator/LP/oracle shielded keys must be distinct.');
    document.ownerKeyHex = keys[0]; document.operatorKeyHex = keys[1]; document.lpKeyHex = keys[2]; document.oracleKeyHex = keys[3];
    const [ownerState, operatorState] = await Promise.all([owner.wallet.waitForSyncedState(), operator.wallet.waitForSyncedState()]);
    const ownerDust = ownerState.dust.balance(new Date());
    const ownerNight = ownerState.unshielded.balances[nativeToken().raw] ?? 0n;
    const operatorNight = operatorState.unshielded.balances[nativeToken().raw] ?? 0n;
    if (ownerDust <= 0n) throw new SafeRunnerError('Test genesis wallet has no DUST to sponsor local fees; no acceptance transaction submitted.');
    if (operatorNight !== 0n) throw new SafeRunnerError('Random operator test wallet unexpectedly has a NIGHT balance.');
    document.preflight = { checkedAt: new Date().toISOString(), ownerDustRaw: ownerDust.toString(), ownerNightRaw: ownerNight.toString(), distinctShieldedKeys: true };
    persist(document); secureModes();
    if (preflightOnly) {
      process.stdout.write(`PASS: read-only loopback preflight; owner DUST=${ownerDust}; four distinct shielded keys; recovery modes=0700/0600; no transaction submitted.\n`);
      return;
    }

    executionStarted = true;
    document.status = 'running'; persist(document); secureModes();
    const module = await import(pathToFileURL(resolve(artifactsDir, 'contract/index.js')).href) as ContractModule;
    const compiled = CompiledContract.make('silence-perp-settlement', module.Contract as never).pipe(
      CompiledContract.withWitnesses(witnesses() as never),
      CompiledContract.withCompiledFileAssets(artifactsDir),
    );
    const ownerP = providers(owner, owner, 'owner', document.ownerStoragePassword);
    const lpP = providers(lp, owner, 'lp', document.lpStoragePassword);
    const oracleP = providers(oracle, owner, 'oracle', document.oracleStoragePassword);
    const operatorP = providers(operator, owner, 'operator', document.operatorStoragePassword);
    const deployed = await deploy(document, ownerP, module, compiled);
    const address = deployed.address;
    for (const providerSet of [ownerP, lpP, oracleP, operatorP]) providerSet.privateStateProvider.setContractAddress(address as never);

    const ownerMint = await call(document, 'mint-owner-collateral', 'mintTestCoin', ownerP, compiled, address, [collateralAtoms, bytes(randomBytes(32).toString('hex'))]);
    document.ownerCoin = coinRecord(ownerMint.result); persist(document); secureModes();
    assert.equal(BigInt(document.ownerCoin.valueAtoms), collateralAtoms);
    const tokenColorHex = document.ownerCoin.colorHex;
    const lpMint = await call(document, 'mint-lp-reserve', 'mintTestCoin', lpP, compiled, address, [reserveAtoms, bytes(randomBytes(32).toString('hex'))]);
    document.lpReserveCoin = coinRecord(lpMint.result); persist(document); secureModes();
    assert.equal(BigInt(document.lpReserveCoin.valueAtoms), reserveAtoms);
    assert.equal(document.lpReserveCoin.colorHex, tokenColorHex, 'LP reserve and trader collateral must use the same contract test token.');

    const ownerKey = encodeCoinPublicKey(owner.shieldedSecretKeys.coinPublicKey);
    const lpKey = encodeCoinPublicKey(lp.shieldedSecretKeys.coinPublicKey);
    const ownerTarget = { ownerRecipient: { bytes: ownerKey }, recipientSalt: bytes(document.ownerRecipientSaltHex) };
    const lpTarget = { lpRecipient: { bytes: lpKey }, recipientSalt: bytes(document.lpRecipientSaltHex) };
    const lpCoin = coinFromStored(document.lpReserveCoin);
    await call(document, 'fund-lp-reserve', 'fundReserve', lpP, compiled, address, [lpCoin, bytes(document.lpSecretHex), lpTarget]);
    let state = await readLedger(ownerP.publicDataProvider, module, address);
    assert.equal(state.reserveFunded, true);
    assert.equal(state.reserveCoin.value, reserveAtoms);

    const nowForOpen = BigInt(Math.floor(Date.now() / 1000));
    await call(document, 'publish-entry-quote', 'publishOracleQuote', oracleP, compiled, address, [entryTicks, 1n, nowForOpen, bytes(document.oracleSecretHex)]);
    const entryPublishedAt = nowForOpen;
    state = await readLedger(ownerP.publicDataProvider, module, address);
    assert.equal(state.oraclePriceTicks, entryTicks); assert.equal(state.oracleSequence, 1n);
    const operatorIdentity = module.pureCircuits.deriveOperatorIdentityCommitment(bytes(document.networkDomainHex), encodeContractAddress(address as never), bytes(document.operatorSecretHex));
    const terms = { isLong: true, notionalAtoms, entryPriceTicks: entryTicks, guardBufferAtoms };
    const ownerCoin = coinFromStored(document.ownerCoin);
    assert.equal(await shieldedBalance(owner, tokenColorHex), collateralAtoms, 'Owner must hold the minted test collateral before opening.');
    const openStartedAt = Date.now();
    const open = await call(document, 'open-position', 'openPosition', ownerP, compiled, address,
      [ownerCoin, terms, bytes(document.positionSaltHex), bytes(document.ownerSecretHex), operatorIdentity, ownerTarget]);
    const openQuoteAgeAtSubmitMs = openStartedAt - Number(entryPublishedAt) * 1000;
    const afterOpen = await readLedger(ownerP.publicDataProvider, module, address);
    assert.equal(afterOpen.positionActive, true); assert.equal(afterOpen.traderCoin.value, collateralAtoms);
    assert.equal(afterOpen.positionEntryOraclePriceTicks, entryTicks); assert.equal(afterOpen.positionEntryOracleSequence, 1n);
    assert.ok(openQuoteAgeAtSubmitMs < 60_000, 'Opening quote exceeded its 60-second max-age at proof start.');
    await owner.wallet.waitForSyncedState();
    assert.equal(await shieldedBalance(owner, tokenColorHex), 0n);

    const p90PublishedAt = BigInt(Math.floor(Date.now() / 1000));
    const quoteStart = Date.now();
    const p90Quote = await call(document, 'publish-p90-quote', 'publishOracleQuote', oracleP, compiled, address,
      [p90Ticks, 2n, p90PublishedAt, bytes(document.oracleSecretHex)]);
    state = await readLedger(ownerP.publicDataProvider, module, address);
    assert.equal(state.oraclePriceTicks, p90Ticks); assert.equal(state.oracleSequence, 2n);
    const riskCloseStart = Date.now();
    const riskClose = await call(document, 'risk-close', 'riskClose', operatorP, compiled, address,
      [terms, bytes(document.positionSaltHex), bytes(document.operatorSecretHex)]);
    const riskCloseAgeAtProofStartMs = riskCloseStart - Number(p90PublishedAt) * 1000;
    const afterClose = await readLedger(ownerP.publicDataProvider, module, address);
    assert.equal(afterClose.positionActive, false); assert.equal(afterClose.closedUnclaimed, true); assert.equal(afterClose.settled, false);
    assert.equal(afterClose.traderCoin.value, collateralAtoms);
    assert.equal(afterClose.settlementOraclePriceTicks, p90Ticks); assert.equal(afterClose.settlementOracleSequence, 2n);
    assert.ok(riskCloseAgeAtProofStartMs < 60_000, 'P90 quote exceeded its 60-second max-age at risk-close proof start.');

    const ownerClaim = await call(document, 'owner-settle-loss', 'ownerSettleLoss', ownerP, compiled, address,
      [terms, bytes(document.positionSaltHex), bytes(document.ownerSecretHex), ownerTarget]);
    const afterSettlement = await readLedger(ownerP.publicDataProvider, module, address);
    assert.equal(afterSettlement.settled, true);
    assert.equal(afterSettlement.lpCollateralRemainderClaimable, true);
    assert.equal(afterSettlement.lpCollateralRemainderCoin.value, 520_000_000n);
    assert.equal(afterSettlement.reserveCoin.value, reserveAtoms, 'Loss settlement cannot draw on the profit-only reserve.');
    await owner.wallet.waitForSyncedState();
    assert.equal(await shieldedBalance(owner, tokenColorHex), 480_000_000n, 'P90 owner payout must be computed by Compact from the frozen oracle quote.');

    const lpCollateralClaim = await call(document, 'lp-claim-trader-remainder', 'lpClaimCollateralRemainder', lpP, compiled, address,
      [bytes(document.lpSecretHex), lpTarget]);
    const afterCollateralClaim = await readLedger(lpP.publicDataProvider, module, address);
    assert.equal(afterCollateralClaim.lpCollateralRemainderClaimable, false);
    assert.equal(afterCollateralClaim.lpCollateralRemainderCoin.value, 0n);
    await lp.wallet.waitForSyncedState();
    assert.equal(await shieldedBalance(lp, tokenColorHex), 520_000_000n);

    const lpReserveClaim = await call(document, 'lp-claim-unused-reserve', 'lpClaimReserveRemainder', lpP, compiled, address,
      [bytes(document.lpSecretHex), lpTarget]);
    const afterReserveClaim = await readLedger(lpP.publicDataProvider, module, address);
    assert.equal(afterReserveClaim.reserveFunded, false);
    assert.equal(afterReserveClaim.reserveCoin.value, 0n);
    await lp.wallet.waitForSyncedState();
    assert.equal(await shieldedBalance(lp, tokenColorHex), 1_020_000_000n);
    await operator.wallet.waitForSyncedState();
    assert.equal(await shieldedBalance(operator, tokenColorHex), 0n);

    const selectedActions = ['publish-entry-quote', 'open-position', 'publish-p90-quote', 'risk-close', 'owner-settle-loss', 'lp-claim-trader-remainder', 'lp-claim-unused-reserve'];
    const publicAudit = [];
    for (const stage of selectedActions) {
      const saved = document.actions[stage];
      assert.ok(saved, `Missing receipt record for ${stage}.`);
      const audited = await queryTransaction(saved.txId, saved.blockHeight);
      assert.equal(audited.hash, saved.transactionHash);
      const action = audited.contractActions.find((item) => item.entryPoint === saved.entryPoint);
      assert.ok(action, `Independent transaction query lacks ${saved.entryPoint}.`);
      publicAudit.push({
        stage,
        txId: saved.txId,
        transactionHash: audited.hash,
        blockHeight: audited.block.height,
        entryPoint: action.entryPoint,
        address: action.address,
        rawFieldBytes: audited.raw.length / 2,
        quotePriceTicksPubliclyInferred: stage === 'publish-entry-quote' ? entryTicks.toString() : stage === 'publish-p90-quote' ? p90Ticks.toString() : undefined,
      });
    }
    const evidence = {
      checkedAt: new Date().toISOString(),
      mode: 'loopback-only actual Local Devnet; valueless shielded test token; no Docker start/reset; owner genesis DUST sponsors fees',
      runId: document.runId,
      contractAddress: address,
      market: 'BTC/USD single authenticated exact-price oracle index; zero-spread test execution; one LP reserve slot and one trader position; no public orderbook',
      assetDistinction: 'BTC/USD is the public oracle index. The collateral and LP reserve are separate valueless shielded test-token atoms, not BTC, NIGHT, or tNIGHT. Fees are Local Devnet DUST sponsored by the test genesis wallet.',
      terms: { sidePrivateWitness: 'Long', notionalAtoms: notionalAtoms.toString(), collateralAtoms: collateralAtoms.toString(), lpReserveAtoms: reserveAtoms.toString(), entryPriceTicks: entryTicks.toString(), settlementPriceTicks: p90Ticks.toString(), priceScale: '1,000,000 micro-USD ticks per USD' },
      expectedFromDifferentialSimulator: { traderPayoutAtoms: '480000000', lpTraderRemainderAtoms: '520000000', lpReserveSpendAtoms: '0', maintenanceAtoms: '225000000' },
      timings: {
        publishEntryQuoteToOpenProofStartMs: openQuoteAgeAtSubmitMs,
        openReceiptDurationMs: open.receipt.durationMs,
        publishP90QuoteToRiskCloseProofStartMs: riskCloseAgeAtProofStartMs,
        publishP90QuoteReceiptDurationMs: p90Quote.receipt.durationMs,
        riskCloseReceiptDurationMs: riskClose.receipt.durationMs,
        publishP90QuoteActionElapsedMs: Date.now() - quoteStart,
        measurement: 'Host wall-clock intervals around proof, balancing, submit and receipt; not chain consensus latency.',
      },
      finalReadback: {
        settled: afterReserveClaim.settled,
        positionActive: afterReserveClaim.positionActive,
        closedUnclaimed: afterReserveClaim.closedUnclaimed,
        oraclePriceTicks: afterReserveClaim.oraclePriceTicks.toString(),
        oracleSequence: afterReserveClaim.oracleSequence.toString(),
        settlementPriceTicks: afterReserveClaim.settlementOraclePriceTicks.toString(),
        traderCoinAtoms: afterReserveClaim.traderCoin.value.toString(),
        reserveCoinAtoms: afterReserveClaim.reserveCoin.value.toString(),
        lpCollateralRemainderAtoms: afterReserveClaim.lpCollateralRemainderCoin.value.toString(),
        ownerShieldedTokenBalanceAtoms: (await shieldedBalance(owner, tokenColorHex)).toString(),
        lpShieldedTokenBalanceAtoms: (await shieldedBalance(lp, tokenColorHex)).toString(),
        operatorShieldedTokenBalanceAtoms: (await shieldedBalance(operator, tokenColorHex)).toString(),
      },
      publicAudit,
      privacyBoundary: [
        'Entry and close oracle prices are public; P100 to P90 plus an adverse-only riskClose implies Long side ex post.',
        'The static ownerSettleLoss entrypoint reveals the loss class, and the shielded send amount/recipient openings and public state may reveal payout details. This is not lifetime trading-history privacy.',
        'The output is test-only accounting/proof evidence, not proof of production privacy, solvency, oracle decentralization, or a full perp DEX.',
      ],
      recoveryBundleState: { status: 'complete', directoryMode: '0700', manifestMode: '0600', pendingOperation: null },
      receipts: Object.fromEntries(Object.entries(document.actions).map(([name, action]) => [name, action])),
    };
    mkdirSync(dirname(evidencePath), { recursive: true, mode: 0o755 });
    writeFileSync(evidencePath, JSON.stringify(evidence, null, 2) + '\n', { mode: 0o644 });
    chmodSync(evidencePath, 0o644);
    document.status = 'complete'; document.pending = undefined; persist(document); secureModes();
    process.stdout.write('PASS: P90 Long loss settlement finalized and independently read back; owner received 480,000,000 test atoms; LP reclaimed 520,000,000 remainder plus the untouched 500,000,000 reserve; sanitized evidence saved.\n');
  } catch (error) {
    if (executionStarted || document.pending) {
      markRecoveryRequired(document, currentPendingStage(document) ?? 'preflight-or-acceptance', error);
    } else {
      document.status = 'prepared';
      persist(document);
      secureModes();
    }
    throw error instanceof SafeRunnerError ? error : new SafeRunnerError(`Acceptance failed at ${document.failureStage ?? 'unknown stage'}. Recovery and pending-action markers remain preserved; no retry was attempted.`);
  } finally {
    await Promise.allSettled(wallets.map((wallet) => wallet.stop()));
    secureModes();
  }
}

main().catch((error: unknown) => {
  const diagnostic = error instanceof SafeRunnerError ? error.message : 'Unexpected runner error; recovery state was not deleted.';
  process.stderr.write(`Runner stopped: ${diagnostic}\n`);
  process.exitCode = 1;
});
