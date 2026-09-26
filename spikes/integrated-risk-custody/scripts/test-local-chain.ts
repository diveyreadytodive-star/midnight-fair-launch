import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { WebSocket } from 'ws';
import {
  createCallTxOptions,
  createUnprovenDeployTx,
  submitCallTxAsync,
  submitTxAsync,
} from '@midnight-ntwrk/midnight-js-contracts';
import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { levelPrivateStateProvider } from '@midnight-ntwrk/midnight-js-level-private-state-provider';
import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import { CompiledContract } from '@midnight-ntwrk/midnight-js-protocol/compact-js';
import {
  encodeCoinPublicKey,
  encodeContractAddress,
  sampleSigningKey,
} from '@midnight-ntwrk/midnight-js-protocol/compact-runtime';
import { nativeToken } from '@midnight-ntwrk/midnight-js-protocol/ledger';
import { createKeystore, HDWallet, Roles } from '@midnight-ntwrk/wallet-sdk';

import { localTestNetwork } from '../../../src/chain/client.js';
import { createSilenceWallet } from '../../../src/chain/wallet.js';

Reflect.set(globalThis as object, 'WebSocket', WebSocket);

const spikeDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const projectDir = resolve(spikeDir, '../..');
const artifactsDir = resolve(spikeDir, 'generated/integrated_risk_custody');
const evidencePath = resolve(spikeDir, 'docs/evidence/local-chain-risk-custody.json');
const recoveryRoot = resolve(projectDir, '.local/integrated-risk-custody-recovery');
const recoveryPath = resolve(recoveryRoot, 'recovery.json');
const lotAtoms = 1_000_000_000n;
const maxNotionalAtoms = 5_000_000_000n;
const priceScale = 1_000_000n;
const entryTicks = 100_000n * priceScale;
const fixedGuard = 255_000_000n;
const stageLabel = (scenarioId: string, action: string) => `${scenarioId}:${action}`;

class SafeRunnerError extends Error {}

type WalletContext = Awaited<ReturnType<typeof createSilenceWallet>> & {
  readonly unshieldedKeystore: ReturnType<typeof createKeystore>;
};

interface PositionTerms {
  readonly isLong: boolean;
  readonly notionalAtoms: bigint;
  readonly entryPriceTicks: bigint;
  readonly guardBufferAtoms: bigint;
}

interface Receipt {
  readonly txId: string;
  readonly status: 'SucceedEntirely';
  readonly blockHeight: number;
  readonly durationMs: number;
}

interface StoredMintedCoin {
  readonly nonceHex: string;
  readonly colorHex: string;
  readonly valueAtoms: string;
}

interface StoredAction {
  readonly txId: string;
  readonly status: 'SucceedEntirely';
  readonly blockHeight: number;
  readonly durationMs: number;
  readonly transactionHash: string;
  readonly entryPoint?: string;
}

interface ScenarioRecovery {
  readonly id: 'p90-protective' | 'p84-liquidation';
  readonly riskPriceTicks: string;
  readonly networkDomainHex: string;
  readonly terms: {
    readonly isLong: boolean;
    readonly notionalAtoms: string;
    readonly entryPriceTicks: string;
    readonly guardBufferAtoms: string;
  };
  readonly ownerSecretHex: string;
  readonly operatorSecretHex: string;
  readonly oracleSecretHex: string;
  readonly positionSaltHex: string;
  readonly recipientSaltHex: string;
  openQuotePublishedAt?: string;
  riskQuotePublishedAt?: string;
  ownerRecipientKeyHex?: string;
  contractAddress?: string;
  tokenColorHex?: string;
  mintedCoin?: StoredMintedCoin;
  readonly actions: Record<string, StoredAction>;
}

interface PendingAction {
  readonly key: string;
  readonly circuit: string;
  readonly phase: 'building' | 'submitted';
  readonly startedAt: string;
  readonly contractAddress?: string;
  readonly txId?: string;
  readonly mintedCoin?: StoredMintedCoin;
}

interface RecoveryDocument {
  readonly version: 1;
  readonly runId: string;
  readonly createdAt: string;
  status: 'prepared' | 'running' | 'complete' | 'recovery-required';
  readonly ownerTestSeedHex: string;
  readonly operatorTestSeedHex: string;
  readonly ownerStoragePassword: string;
  readonly operatorStoragePassword: string;
  ownerShieldedKeyHex?: string;
  operatorShieldedKeyHex?: string;
  readonly scenarios: ScenarioRecovery[];
  actions: Record<string, StoredAction>;
  preflight?: {
    readonly checkedAt: string;
    readonly ownerDustRaw: string;
    readonly ownerNativeRaw: string;
    readonly operatorNativeRaw: string;
    readonly distinctShieldedKeys: boolean;
  };
  pending?: PendingAction;
  lastFailureStage?: string;
  lastFailureClass?: string;
}

interface IndexedTransaction {
  readonly hash: string;
  readonly raw: string;
  readonly block: { readonly height: number };
  readonly contractActions: readonly {
    readonly address?: string;
    readonly entryPoint?: string;
    readonly state?: string;
    readonly zswapState?: string;
  }[];
}

type DynamicContractModule = {
  readonly Contract: new (...args: unknown[]) => unknown;
  readonly pureCircuits: {
    readonly deriveOraclePublisherCommitment: (networkDomain: Uint8Array, secret: Uint8Array) => Uint8Array;
    readonly deriveOperatorIdentityCommitment: (networkDomain: Uint8Array, address: Uint8Array, secret: Uint8Array) => Uint8Array;
  };
  readonly ledger: (state: unknown) => {
    readonly networkDomain: Uint8Array;
    readonly oraclePublisherCommitment: Uint8Array;
    readonly oraclePriceTicks: bigint;
    readonly oracleSequence: bigint;
    readonly oraclePublishedAt: bigint;
    readonly oracleReady: boolean;
    readonly escrowCoin: { readonly value: bigint; readonly mt_index: bigint };
    readonly ownerIdentityCommitment: Uint8Array;
    readonly operatorIdentityCommitment: Uint8Array;
    readonly ownerRecipientCommitment: Uint8Array;
    readonly positionCommitment: Uint8Array;
    readonly positionEntryOraclePriceTicks: bigint;
    readonly positionEntryOracleSequence: bigint;
    readonly positionEntryOraclePublishedAt: bigint;
    readonly positionActive: boolean;
    readonly closedUnclaimed: boolean;
    readonly settled: boolean;
  };
};

const network = localTestNetwork('unused-per-wallet-password');

function assertLocalNetworkOnly(): void {
  const expected = [
    { name: 'indexer-http', url: network.indexer, protocol: 'http:', port: '28088', path: '/api/v4/graphql' },
    { name: 'indexer-websocket', url: network.indexerWS, protocol: 'ws:', port: '28088', path: '/api/v4/graphql/ws' },
    { name: 'node-websocket', url: network.node, protocol: 'ws:', port: '29944', path: '' },
    { name: 'proof-server', url: network.proofServer, protocol: 'http:', port: '26300', path: '' },
  ];
  for (const endpoint of expected) {
    const parsed = new URL(endpoint.url);
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)) {
      throw new SafeRunnerError(`Endpoint ${endpoint.name} rejected non-loopback host ${parsed.hostname}.`);
    }
    if (parsed.username || parsed.password) throw new SafeRunnerError(`Endpoint ${endpoint.name} must not embed credentials.`);
    if (parsed.protocol !== endpoint.protocol) throw new SafeRunnerError(`Endpoint ${endpoint.name} rejected protocol ${parsed.protocol}.`);
    if (parsed.port !== endpoint.port) throw new SafeRunnerError(`Endpoint ${endpoint.name} rejected port ${parsed.port || '(default)'}.`);
    if (parsed.pathname !== (endpoint.path || '/') || parsed.search || parsed.hash) {
      throw new SafeRunnerError(`Endpoint ${endpoint.name} rejected path/query configuration.`);
    }
  }
}

function ensurePrivateDirectory(path: string): void {
  if (existsSync(path)) {
    const stat = lstatSync(path);
    assert.equal(stat.isSymbolicLink(), false, 'Refusing a symlink in the private recovery tree.');
    assert.equal(stat.isDirectory(), true, 'Recovery path is not a directory.');
  } else {
    mkdirSync(path, { mode: 0o700 });
  }
  chmodSync(path, 0o700);
}

function secureTree(path: string): void {
  if (!existsSync(path)) return;
  const stat = lstatSync(path);
  assert.equal(stat.isSymbolicLink(), false, 'Refusing a symlink in the private recovery tree.');
  if (stat.isDirectory()) {
    chmodSync(path, 0o700);
    for (const entry of readdirSync(path)) secureTree(join(path, entry));
  } else {
    chmodSync(path, 0o600);
  }
}

function persistRecovery(document: RecoveryDocument): void {
  ensurePrivateDirectory(recoveryRoot);
  const tempPath = `${recoveryPath}.tmp-${process.pid}`;
  if (existsSync(tempPath)) throw new Error('Recovery temporary file already exists; manual recovery is required.');
  const descriptor = openSync(tempPath, 'wx', 0o600);
  try {
    writeFileSync(descriptor, JSON.stringify(document, null, 2) + '\n', { encoding: 'utf8' });
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  chmodSync(tempPath, 0o600);
  renameSync(tempPath, recoveryPath);
  chmodSync(recoveryPath, 0o600);
  const directoryDescriptor = openSync(recoveryRoot, 'r');
  try {
    fsyncSync(directoryDescriptor);
  } finally {
    closeSync(directoryDescriptor);
  }
}

function newScenario(
  runId: string,
  id: ScenarioRecovery['id'],
  riskPriceTicks: bigint,
): ScenarioRecovery {
  const networkDomain = createHash('sha256')
    .update(`SILENCE/INTEGRATED-RISK-CUSTODY/LOCAL-DEVNET/v1/${runId}/${id}`)
    .digest();
  return {
    id,
    riskPriceTicks: riskPriceTicks.toString(),
    networkDomainHex: networkDomain.toString('hex'),
    terms: {
      isLong: true,
      notionalAtoms: maxNotionalAtoms.toString(),
      entryPriceTicks: entryTicks.toString(),
      guardBufferAtoms: fixedGuard.toString(),
    },
    ownerSecretHex: randomBytes(32).toString('hex'),
    operatorSecretHex: randomBytes(32).toString('hex'),
    oracleSecretHex: randomBytes(32).toString('hex'),
    positionSaltHex: randomBytes(32).toString('hex'),
    recipientSaltHex: randomBytes(32).toString('hex'),
    actions: {},
  };
}

function loadOrCreateRecovery(): RecoveryDocument {
  ensurePrivateDirectory(resolve(projectDir, '.local'));
  ensurePrivateDirectory(recoveryRoot);
  if (existsSync(recoveryPath)) {
    const stat = lstatSync(recoveryPath);
    assert.equal(stat.isSymbolicLink(), false, 'Recovery state cannot be a symbolic link.');
    assert.equal(stat.isFile(), true, 'Recovery state is not a regular file.');
    chmodSync(recoveryPath, 0o600);
    const document = JSON.parse(readFileSync(recoveryPath, 'utf8')) as RecoveryDocument;
    assert.equal(document.version, 1, 'Unsupported recovery bundle version.');
    return document;
  }

  const ownerSeed = process.env.SILENCE_LOCAL_TEST_SEED?.trim() ?? '';
  delete process.env.SILENCE_LOCAL_TEST_SEED;
  if (!/^(?:[0-9a-fA-F]{2}){32}$/.test(ownerSeed)) {
    throw new Error('Provide a 32-byte valueless Local Devnet genesis seed in SILENCE_LOCAL_TEST_SEED. The runner never reads the Preprod wallet file or accepts a wallet-file path.');
  }
  const runId = randomUUID();
  const document: RecoveryDocument = {
    version: 1,
    runId,
    createdAt: new Date().toISOString(),
    status: 'prepared',
    ownerTestSeedHex: ownerSeed,
    operatorTestSeedHex: randomBytes(32).toString('hex'),
    ownerStoragePassword: randomBytes(32).toString('hex'),
    operatorStoragePassword: randomBytes(32).toString('hex'),
    scenarios: [
      newScenario(runId, 'p90-protective', 90_000n * priceScale),
      newScenario(runId, 'p84-liquidation', 84_000n * priceScale),
    ],
    actions: {},
  };
  persistRecovery(document);
  return document;
}

function save(document: RecoveryDocument): void {
  persistRecovery(document);
  secureTree(recoveryRoot);
}

function hexBytes(hex: string): Uint8Array {
  return Uint8Array.from(Buffer.from(hex, 'hex'));
}

function bigIntHex(value: bigint, littleEndian: boolean): string {
  const bytes = new Uint8Array(8);
  let remaining = value;
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[littleEndian ? index : bytes.length - index - 1] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  return Buffer.from(bytes).toString('hex');
}

function containsBytes(publicHex: string, secret: Uint8Array): boolean {
  return publicHex.toLowerCase().includes(Buffer.from(secret).toString('hex').toLowerCase());
}

function containsInteger(publicHex: string, amount: bigint): boolean {
  return publicHex.toLowerCase().includes(bigIntHex(amount, true)) ||
    publicHex.toLowerCase().includes(bigIntHex(amount, false));
}

function publicReceipt(value: { readonly txId: string; readonly status: string; readonly blockHeight?: number; }): Omit<Receipt, 'durationMs'> {
  assert.equal(value.status, 'SucceedEntirely', 'Local transaction did not finalize successfully.');
  assert.equal(typeof value.blockHeight, 'number', 'Finalized receipt has no block height.');
  return { txId: value.txId, status: 'SucceedEntirely', blockHeight: value.blockHeight! };
}

async function waitForReceipt(
  provider: ReturnType<typeof indexerPublicDataProvider>,
  txId: string,
): Promise<Omit<Receipt, 'durationMs'>> {
  return publicReceipt(await provider.watchForTxData(txId));
}

async function queryPublicTransaction(
  indexerUrl: string,
  txId: string,
  blockHeight: number,
): Promise<IndexedTransaction> {
  const identifier = txId.replace(/^0x/i, '');
  if (!/^[0-9a-fA-F]{66}$/.test(identifier)) throw new Error('SDK tx identifier has an unexpected length.');
  const query = 'query IntegratedRiskTransaction { transactions(offset: { identifier: ' +
    JSON.stringify(identifier) +
    ' }) { hash raw block { height } contractActions { __typename ... on ContractCall { address entryPoint state zswapState } } } }';
  const response = await fetch(indexerUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  if (!response.ok) throw new Error('Local indexer returned an HTTP error.');
  const payload = await response.json() as {
    readonly data?: { readonly transactions?: readonly IndexedTransaction[] };
    readonly errors?: readonly { readonly message: string }[];
  };
  if (payload.errors?.length) throw new Error('Local indexer rejected a transaction lookup.');
  const transaction = payload.data?.transactions?.[0];
  assert.ok(transaction && typeof transaction.raw === 'string', 'Indexed raw transaction is unavailable.');
  assert.equal(transaction.block.height, blockHeight, 'Indexer block does not match final receipt.');
  return transaction;
}

async function readLedger(
  provider: ReturnType<typeof indexerPublicDataProvider>,
  module: DynamicContractModule,
  address: string,
) {
  const state = await provider.queryContractState(address as never);
  assert.ok(state, 'Public contract state is unavailable from the loopback indexer.');
  return module.ledger((state as { readonly data?: unknown }).data ?? state);
}

async function makeWallet(
  seedHex: string,
  walletDirectory: string,
  storagePassword: string,
) : Promise<WalletContext> {
  ensurePrivateDirectory(walletDirectory);
  const config = {
    ...localTestNetwork(storagePassword),
    privateStateDir: join(walletDirectory, 'contract-private-state'),
  };
  const context = await createSilenceWallet(seedHex, config);
  const hdWallet = HDWallet.fromSeed(Buffer.from(seedHex, 'hex'));
  if (hdWallet.type !== 'seedOk') throw new Error('Local test wallet seed could not be derived.');
  const derivation = hdWallet.hdWallet
    .selectAccount(0)
    .selectRoles([Roles.Zswap, Roles.NightExternal, Roles.Dust])
    .deriveKeysAt(0);
  if (derivation.type !== 'keysDerived') {
    hdWallet.hdWallet.clear();
    throw new Error('Local test wallet role keys could not be derived.');
  }
  const keyStore = createKeystore(derivation.keys[Roles.NightExternal], config.networkId);
  hdWallet.hdWallet.clear();
  assert.equal(keyStore.getBech32Address().toString(), context.accountId, 'Wallet account does not match its test seed.');
  secureTree(walletDirectory);
  return { ...context, unshieldedKeystore: keyStore };
}

async function shieldedBalance(wallet: WalletContext, tokenColor: string): Promise<bigint> {
  const state = await wallet.wallet.waitForSyncedState();
  return state.shielded.balances[tokenColor] ?? 0n;
}

function makeProviders(
  wallet: WalletContext,
  walletDirectory: string,
  storagePassword: string,
  feeSponsor?: WalletContext,
) {
  const publicDataProvider = indexerPublicDataProvider(network.indexer, network.indexerWS);
  const zkConfigProvider = new NodeZkConfigProvider(artifactsDir);
  const sponsor = feeSponsor ?? wallet;
  const sponsored = sponsor !== wallet;
  const walletProvider = {
    getCoinPublicKey: () => wallet.shieldedSecretKeys.coinPublicKey,
    getEncryptionPublicKey: () => wallet.shieldedSecretKeys.encryptionPublicKey,
    async balanceTx(tx: unknown, ttl?: Date) {
      const recipe = await sponsor.wallet.balanceUnboundTransaction(
        tx as never,
        { shieldedSecretKeys: wallet.shieldedSecretKeys, dustSecretKey: sponsor.dustSecretKey },
        {
          ttl: ttl ?? new Date(Date.now() + 30 * 60 * 1000),
          tokenKindsToBalance: sponsored ? ['dust'] : 'all',
        },
      );
      return sponsor.wallet.finalizeRecipe(recipe);
    },
    submitTx: (tx: unknown) => sponsor.wallet.submitTransaction(tx as never),
  };
  const providers = {
    privateStateProvider: levelPrivateStateProvider({
      accountId: wallet.unshieldedKeystore.getBech32Address().toString(),
      midnightDbName: join(walletDirectory, 'midnight-level-db'),
      privateStateStoreName: 'integrated-risk-private-state',
      signingKeyStoreName: 'integrated-risk-signing-keys',
      privateStoragePasswordProvider: () => storagePassword,
    }),
    publicDataProvider,
    zkConfigProvider,
    proofProvider: httpClientProofProvider(network.proofServer, zkConfigProvider),
    walletProvider,
    midnightProvider: walletProvider,
  } as const;
  return { providers, publicDataProvider, zkConfigProvider, walletProvider };
}

function persistPending(document: RecoveryDocument, pending: PendingAction): void {
  document.pending = pending;
  document.status = 'running';
  save(document);
}

function finalizeCallRecord(
  document: RecoveryDocument,
  actionKey: string,
  txId: string,
  receipt: Omit<Receipt, 'durationMs'>,
  durationMs: number,
  transaction: IndexedTransaction,
  entryPoint: string,
) {
  const action = transaction.contractActions.find((candidate) => candidate.entryPoint === entryPoint);
  assert.ok(action, 'Indexer action does not match the finalized circuit name.');
  document.actions[actionKey] = {
    ...receipt,
    durationMs,
    transactionHash: transaction.hash,
    entryPoint,
  };
  document.pending = undefined;
  save(document);
  return { transaction, action, receipt: { ...receipt, durationMs } };
}

async function runCall(
  document: RecoveryDocument,
  scenario: ScenarioRecovery,
  actionName: string,
  circuit: string,
  providers: ReturnType<typeof makeProviders>,
  compiledContract: unknown,
  contractAddress: string,
  args: readonly unknown[],
): Promise<{ readonly receipt: Receipt; readonly transaction: IndexedTransaction; readonly action: IndexedTransaction['contractActions'][number]; readonly privateResult: unknown }> {
  const actionKey = stageLabel(scenario.id, actionName);
  const saved = document.actions[actionKey];
  if (saved) {
    const receipt = await waitForReceipt(providers.publicDataProvider, saved.txId);
    const transaction = await queryPublicTransaction(network.indexer, saved.txId, saved.blockHeight);
    const action = transaction.contractActions.find((candidate) => candidate.entryPoint === circuit);
    assert.ok(action, 'Previously finalized action is missing from indexed data.');
    return {
      receipt: { ...receipt, durationMs: saved.durationMs },
      transaction,
      action,
      privateResult: circuit === 'mintTestCollateral' ? scenario.mintedCoin : undefined,
    };
  }

  if (document.pending) {
    assert.equal(document.pending.key, actionKey, 'A different operation is pending; preserve state for manual reconciliation.');
    if (!document.pending.txId) {
      throw new Error('Previous submission has no recorded transaction id; refusing to resubmit an uncertain action.');
    }
    const pending = document.pending;
    const pendingTxId = pending.txId;
    if (!pendingTxId) throw new Error('Pending operation has no transaction identifier.');
    const started = Date.parse(pending.startedAt);
    const receipt = await waitForReceipt(providers.publicDataProvider, pendingTxId);
    const transaction = await queryPublicTransaction(network.indexer, pendingTxId, receipt.blockHeight);
    const finalized = finalizeCallRecord(
      document,
      actionKey,
      pendingTxId,
      receipt,
      Math.max(0, Date.now() - started),
      transaction,
      circuit,
    );
    if (pending.mintedCoin && circuit === 'mintTestCollateral') scenario.mintedCoin = pending.mintedCoin;
    save(document);
    return {
      ...finalized,
      privateResult: circuit === 'mintTestCollateral' ? scenario.mintedCoin : undefined,
    };
  }

  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  persistPending(document, { key: actionKey, circuit, phase: 'building', startedAt });
  try {
    const options = createCallTxOptions(
      compiledContract as never,
      circuit as never,
      contractAddress as never,
      undefined,
      undefined,
      [...args] as never,
    );
    const submitted = await submitCallTxAsync(providers.providers as never, options as never);
    const privateResult = (submitted.callTxData as { readonly private?: { readonly result?: unknown } }).private?.result;
    let pendingMint: StoredMintedCoin | undefined;
    if (circuit === 'mintTestCollateral') {
      const coin = privateResult as { readonly nonce?: Uint8Array; readonly color?: Uint8Array; readonly value?: bigint } | undefined;
      assert.ok(coin?.nonce instanceof Uint8Array && coin.color instanceof Uint8Array && typeof coin.value === 'bigint', 'Mint call did not return a shielded coin witness.');
      pendingMint = {
        nonceHex: Buffer.from(coin.nonce).toString('hex'),
        colorHex: Buffer.from(coin.color).toString('hex'),
        valueAtoms: coin.value.toString(),
      };
      scenario.mintedCoin = pendingMint;
    }
    document.pending = {
      key: actionKey,
      circuit,
      phase: 'submitted',
      startedAt,
      contractAddress,
      txId: submitted.txId,
      ...(pendingMint ? { mintedCoin: pendingMint } : {}),
    };
    save(document);
    const receipt = await waitForReceipt(providers.publicDataProvider, submitted.txId);
    const transaction = await queryPublicTransaction(network.indexer, submitted.txId, receipt.blockHeight);
    const finalized = finalizeCallRecord(
      document,
      actionKey,
      submitted.txId,
      receipt,
      Math.max(0, Date.now() - startedMs),
      transaction,
      circuit,
    );
    return { ...finalized, privateResult };
  } catch (error) {
    document.status = 'recovery-required';
    document.lastFailureStage = actionKey;
    document.lastFailureClass = error instanceof Error ? error.name : 'UnknownError';
    save(document);
    throw new Error('Acceptance step failed or became uncertain at ' + actionKey + '. Private recovery state was preserved; do not rerun with new credentials or resubmit until the local indexer is reconciled.');
  }
}

async function runDeployment(
  document: RecoveryDocument,
  scenario: ScenarioRecovery,
  ownerProviders: ReturnType<typeof makeProviders>,
  contractModule: DynamicContractModule,
  compiledContract: unknown,
): Promise<{ readonly receipt: Receipt; readonly address: string }> {
  const actionKey = stageLabel(scenario.id, 'deploy');
  const saved = document.actions[actionKey];
  if (saved) {
    assert.ok(scenario.contractAddress, 'Recovery entry lost the deployed contract address.');
    const receipt = await waitForReceipt(ownerProviders.publicDataProvider, saved.txId);
    const state = await ownerProviders.publicDataProvider.queryContractState(scenario.contractAddress as never);
    assert.ok(state, 'Previously deployed contract is not present in the local indexer.');
    return { receipt: { ...receipt, durationMs: saved.durationMs }, address: scenario.contractAddress };
  }
  if (document.pending) {
    assert.equal(document.pending.key, actionKey, 'A different operation is pending; manual reconciliation is required.');
    if (!document.pending.txId || !document.pending.contractAddress) {
      throw new Error('Previous deployment may be uncertain; refusing to deploy another contract.');
    }
    const pending = document.pending;
    const pendingTxId = pending.txId;
    const pendingAddress = pending.contractAddress;
    if (!pendingTxId || !pendingAddress) throw new Error('Pending deployment lacks its address or transaction identifier.');
    const receipt = await waitForReceipt(ownerProviders.publicDataProvider, pendingTxId);
    const state = await ownerProviders.publicDataProvider.queryContractState(pendingAddress as never);
    assert.ok(state, 'Submitted deployment has not appeared in the local indexer.');
    const hash = await queryPublicTransaction(network.indexer, pendingTxId, receipt.blockHeight);
    const durationMs = Math.max(0, Date.now() - Date.parse(pending.startedAt));
    document.actions[actionKey] = {
      ...receipt,
      durationMs,
      transactionHash: hash.hash,
    };
    scenario.contractAddress = pendingAddress;
    document.pending = undefined;
    save(document);
    return { receipt: { ...receipt, durationMs }, address: pendingAddress };
  }

  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  persistPending(document, { key: actionKey, circuit: 'deploy', phase: 'building', startedAt });
  try {
    const networkDomain = hexBytes(scenario.networkDomainHex);
    const oracleSecret = hexBytes(scenario.oracleSecretHex);
    const publisherCommitment = contractModule.pureCircuits.deriveOraclePublisherCommitment(networkDomain, oracleSecret);
    const deployData = await createUnprovenDeployTx(
      { zkConfigProvider: ownerProviders.zkConfigProvider, walletProvider: ownerProviders.walletProvider } as never,
      {
        compiledContract: compiledContract as never,
        args: [networkDomain, publisherCommitment],
        signingKey: sampleSigningKey(),
        initialPrivateState: undefined,
      } as never,
    );
    const address = String(deployData.public.contractAddress);
    scenario.contractAddress = address;
    document.pending = { key: actionKey, circuit: 'deploy', phase: 'building', startedAt, contractAddress: address };
    save(document);
    const txId = await submitTxAsync(ownerProviders.providers as never, { unprovenTx: deployData.private.unprovenTx } as never);
    document.pending = { key: actionKey, circuit: 'deploy', phase: 'submitted', startedAt, contractAddress: address, txId };
    save(document);
    const receipt = await waitForReceipt(ownerProviders.publicDataProvider, txId);
    const transaction = await queryPublicTransaction(network.indexer, txId, receipt.blockHeight);
    const contractState = await ownerProviders.publicDataProvider.queryContractState(address as never);
    assert.ok(contractState, 'Deployed contract state did not appear in the local indexer.');
    const ledger = contractModule.ledger((contractState as { readonly data?: unknown }).data ?? contractState);
    assert.deepEqual(ledger.networkDomain, networkDomain);
    assert.deepEqual(ledger.oraclePublisherCommitment, publisherCommitment);
    const durationMs = Math.max(0, Date.now() - startedMs);
    document.actions[actionKey] = { ...receipt, durationMs, transactionHash: transaction.hash };
    document.pending = undefined;
    save(document);
    return { receipt: { ...receipt, durationMs }, address };
  } catch (error) {
    document.status = 'recovery-required';
    document.lastFailureStage = actionKey;
    document.lastFailureClass = error instanceof Error ? error.name : 'UnknownError';
    save(document);
    throw new Error('Deployment failed or became uncertain for ' + scenario.id + '. Private recovery state was preserved; reconcile before any deployment retry.');
  }
}

async function runScenario(
  document: RecoveryDocument,
  scenario: ScenarioRecovery,
  ownerWallet: WalletContext,
  operatorWallet: WalletContext,
  ownerWalletDirectory: string,
  operatorWalletDirectory: string,
  contractModule: DynamicContractModule,
  compiledContract: unknown,
) {
  const ownerProviders = makeProviders(ownerWallet, ownerWalletDirectory, document.ownerStoragePassword);
  const operatorProviders = makeProviders(operatorWallet, operatorWalletDirectory, document.operatorStoragePassword, ownerWallet);
  const deployment = await runDeployment(document, scenario, ownerProviders, contractModule, compiledContract);
  const contractAddress = deployment.address;
  ownerProviders.providers.privateStateProvider.setContractAddress(contractAddress as never);
  operatorProviders.providers.privateStateProvider.setContractAddress(contractAddress as never);

  if (!scenario.mintedCoin) {
    const mint = await runCall(
      document,
      scenario,
      'mint-collateral',
      'mintTestCollateral',
      ownerProviders,
      compiledContract,
      contractAddress,
      [hexBytes(randomBytes(32).toString('hex'))],
    );
    assert.ok(mint.privateResult, 'Minted test coin private result was not recovered.');
    const coin = mint.privateResult as { readonly nonce: Uint8Array; readonly color: Uint8Array; readonly value: bigint };
    scenario.mintedCoin = {
      nonceHex: Buffer.from(coin.nonce).toString('hex'),
      colorHex: Buffer.from(coin.color).toString('hex'),
      valueAtoms: coin.value.toString(),
    };
    scenario.tokenColorHex = Buffer.from(coin.color).toString('hex');
    save(document);
  }
  assert.ok(scenario.mintedCoin, 'Test coin witness is missing from protected recovery state.');
  const coin = {
    nonce: hexBytes(scenario.mintedCoin.nonceHex),
    color: hexBytes(scenario.mintedCoin.colorHex),
    value: BigInt(scenario.mintedCoin.valueAtoms),
  };
  assert.equal(coin.value, lotAtoms);
  scenario.tokenColorHex = Buffer.from(coin.color).toString('hex');
  save(document);

  const terms: PositionTerms = {
    isLong: scenario.terms.isLong,
    notionalAtoms: BigInt(scenario.terms.notionalAtoms),
    entryPriceTicks: BigInt(scenario.terms.entryPriceTicks),
    guardBufferAtoms: BigInt(scenario.terms.guardBufferAtoms),
  };
  assert.equal(terms.notionalAtoms, maxNotionalAtoms);
  const ownerKey = encodeCoinPublicKey(ownerWallet.shieldedSecretKeys.coinPublicKey);
  const operatorKey = encodeCoinPublicKey(operatorWallet.shieldedSecretKeys.coinPublicKey);
  assert.notDeepEqual(ownerKey, operatorKey, 'Owner/operator shielded keys must be independent.');
  scenario.ownerRecipientKeyHex = Buffer.from(ownerKey).toString('hex');
  document.ownerShieldedKeyHex = Buffer.from(ownerKey).toString('hex');
  document.operatorShieldedKeyHex = Buffer.from(operatorKey).toString('hex');
  save(document);

  const positionSalt = hexBytes(scenario.positionSaltHex);
  const recipientSalt = hexBytes(scenario.recipientSaltHex);
  const ownerSecret = hexBytes(scenario.ownerSecretHex);
  const operatorSecret = hexBytes(scenario.operatorSecretHex);
  const oracleSecret = hexBytes(scenario.oracleSecretHex);
  const networkDomain = hexBytes(scenario.networkDomainHex);
  const operatorCommitment = contractModule.pureCircuits.deriveOperatorIdentityCommitment(
    networkDomain,
    encodeContractAddress(contractAddress as never),
    operatorSecret,
  );
  const ownerTarget = { ownerRecipient: { bytes: ownerKey }, recipientSalt };
  const ownerStateBeforeOpen = await ownerWallet.wallet.waitForSyncedState();
  const balanceBeforeOpen = ownerStateBeforeOpen.shielded.balances[scenario.tokenColorHex] ?? 0n;
  assert.equal(balanceBeforeOpen, lotAtoms, 'Owner did not sync the minted fixed shielded test lot.');

  // Publish after mint/sync so the 60-second window covers only open proof,
  // balancing, submission and inclusion rather than the collateral mint.
  if (!scenario.openQuotePublishedAt) {
    scenario.openQuotePublishedAt = Math.floor(Date.now() / 1000).toString();
    save(document);
  }
  const openQuote = await runCall(
    document,
    scenario,
    'oracle-open',
    'publishOracleQuote',
    ownerProviders,
    compiledContract,
    contractAddress,
    [entryTicks, 1n, BigInt(scenario.openQuotePublishedAt), oracleSecret],
  );
  let quoteLedger = await readLedger(ownerProviders.publicDataProvider, contractModule, contractAddress);
  assert.equal(quoteLedger.oracleReady, true);
  assert.equal(quoteLedger.oraclePriceTicks, entryTicks);
  assert.equal(quoteLedger.oracleSequence, 1n);
  const openQuotePublicHex = [openQuote.transaction.raw, openQuote.action.state ?? '', openQuote.action.zswapState ?? '']
    .join('')
    .replace(/^0x/gi, '')
    .toLowerCase();
  const openQuoteSecretVisible = containsBytes(openQuotePublicHex, oracleSecret);
  assert.equal(openQuoteSecretVisible, false, 'Oracle publisher secret was found in opening quote public fields.');
  const openQuoteAgeAtOpenStartMs = Math.max(0, Date.now() - Number(scenario.openQuotePublishedAt) * 1000);

  const open = await runCall(
    document,
    scenario,
    'open-position',
    'openPosition',
    ownerProviders,
    compiledContract,
    contractAddress,
    [coin, terms, positionSalt, ownerSecret, operatorCommitment, ownerTarget],
  );
  const openLedger = await readLedger(ownerProviders.publicDataProvider, contractModule, contractAddress);
  assert.equal(openLedger.positionActive, true);
  assert.equal(openLedger.closedUnclaimed, false);
  assert.equal(openLedger.settled, false);
  assert.equal(openLedger.escrowCoin.value, lotAtoms);
  assert.ok(openLedger.escrowCoin.mt_index > 0n);
  assert.equal(openLedger.positionEntryOraclePriceTicks, entryTicks);
  assert.equal(openLedger.positionEntryOracleSequence, 1n);
  assert.equal(openLedger.positionEntryOraclePublishedAt, BigInt(scenario.openQuotePublishedAt));
  await ownerWallet.wallet.waitForSyncedState();
  assert.equal(await shieldedBalance(ownerWallet, scenario.tokenColorHex), 0n);

  const openTransaction = await queryPublicTransaction(network.indexer, open.receipt.txId, open.receipt.blockHeight);
  const openAction = openTransaction.contractActions.find((action) => action.entryPoint === 'openPosition');
  assert.ok(openAction, 'Indexed open transaction does not contain openPosition.');
  const openPublicHex = [openTransaction.raw, openAction.state ?? '', openAction.zswapState ?? '']
    .join('')
    .replace(/^0x/gi, '')
    .toLowerCase();
  const privateOpenValuesVisible = [
    ownerSecret,
    operatorSecret,
    oracleSecret,
    positionSalt,
    recipientSalt,
    ownerKey,
  ].some((value) => containsBytes(openPublicHex, value)) ||
    containsInteger(openPublicHex, terms.notionalAtoms) ||
    containsInteger(openPublicHex, terms.guardBufferAtoms);
  assert.equal(privateOpenValuesVisible, false, 'Selected open witnesses were found in tested indexed public fields.');

  if (!scenario.riskQuotePublishedAt) {
    scenario.riskQuotePublishedAt = Math.floor(Date.now() / 1000).toString();
    save(document);
  }
  const riskPrice = BigInt(scenario.riskPriceTicks);
  const riskQuote = await runCall(
    document,
    scenario,
    'oracle-risk',
    'publishOracleQuote',
    ownerProviders,
    compiledContract,
    contractAddress,
    [riskPrice, 2n, BigInt(scenario.riskQuotePublishedAt), oracleSecret],
  );
  const riskQuotePublicHex = [riskQuote.transaction.raw, riskQuote.action.state ?? '', riskQuote.action.zswapState ?? '']
    .join('')
    .replace(/^0x/gi, '')
    .toLowerCase();
  const riskQuoteSecretVisible = containsBytes(riskQuotePublicHex, oracleSecret);
  assert.equal(riskQuoteSecretVisible, false, 'Oracle publisher secret was found in risk quote public fields.');
  quoteLedger = await readLedger(operatorProviders.publicDataProvider, contractModule, contractAddress);
  assert.equal(quoteLedger.oracleReady, true);
  assert.equal(quoteLedger.oraclePriceTicks, riskPrice);
  assert.equal(quoteLedger.oracleSequence, 2n);
  assert.equal(quoteLedger.positionEntryOraclePriceTicks, entryTicks, 'Risk quote overwrote original entry snapshot.');

  const riskCloseStartedAt = Date.now();
  const riskClosed = await runCall(
    document,
    scenario,
    'risk-close',
    'riskClose',
    operatorProviders,
    compiledContract,
    contractAddress,
    [terms, positionSalt, operatorSecret],
  );
  const closedLedger = await readLedger(operatorProviders.publicDataProvider, contractModule, contractAddress);
  assert.equal(closedLedger.positionActive, false);
  assert.equal(closedLedger.closedUnclaimed, true);
  assert.equal(closedLedger.settled, false);
  assert.equal(closedLedger.escrowCoin.value, lotAtoms);
  assert.equal(closedLedger.escrowCoin.mt_index, openLedger.escrowCoin.mt_index);
  await Promise.all([
    ownerWallet.wallet.waitForSyncedState(),
    operatorWallet.wallet.waitForSyncedState(),
  ]);
  assert.equal(await shieldedBalance(ownerWallet, scenario.tokenColorHex), 0n, 'Risk close paid owner before claim.');
  assert.equal(await shieldedBalance(operatorWallet, scenario.tokenColorHex), 0n, 'Risk close redirected collateral.');

  const riskTransaction = await queryPublicTransaction(network.indexer, riskClosed.receipt.txId, riskClosed.receipt.blockHeight);
  const riskAction = riskTransaction.contractActions.find((action) => action.entryPoint === 'riskClose');
  assert.ok(riskAction, 'Indexed risk-close transaction is missing its circuit action.');
  const riskPublicHex = [riskTransaction.raw, riskAction.state ?? '', riskAction.zswapState ?? '']
    .join('')
    .replace(/^0x/gi, '')
    .toLowerCase();
  const riskWitnessesVisible = [ownerSecret, operatorSecret, oracleSecret, positionSalt, recipientSalt, ownerKey]
    .some((value) => containsBytes(riskPublicHex, value)) ||
    containsInteger(riskPublicHex, terms.notionalAtoms) ||
    containsInteger(riskPublicHex, terms.guardBufferAtoms);
  assert.equal(riskWitnessesVisible, false, 'Selected risk-close witnesses were found in tested indexed public fields.');

  const ownerClaim = await runCall(
    document,
    scenario,
    'owner-claim',
    'ownerClaim',
    ownerProviders,
    compiledContract,
    contractAddress,
    [terms, positionSalt, ownerSecret, ownerTarget],
  );
  await Promise.all([
    ownerWallet.wallet.waitForSyncedState(),
    operatorWallet.wallet.waitForSyncedState(),
  ]);
  const claimLedger = await readLedger(ownerProviders.publicDataProvider, contractModule, contractAddress);
  const ownerBalance = await shieldedBalance(ownerWallet, scenario.tokenColorHex);
  const operatorBalance = await shieldedBalance(operatorWallet, scenario.tokenColorHex);
  assert.equal(claimLedger.positionActive, false);
  assert.equal(claimLedger.closedUnclaimed, false);
  assert.equal(claimLedger.settled, true);
  assert.equal(ownerBalance, lotAtoms);
  assert.equal(operatorBalance, 0n);

  const claimTransaction = await queryPublicTransaction(network.indexer, ownerClaim.receipt.txId, ownerClaim.receipt.blockHeight);
  const claimAction = claimTransaction.contractActions.find((action) => action.entryPoint === 'ownerClaim');
  assert.ok(claimAction, 'Indexed owner-claim transaction is missing its circuit action.');
  const claimPublicHex = [claimTransaction.raw, claimAction.state ?? '', claimAction.zswapState ?? '']
    .join('')
    .replace(/^0x/gi, '')
    .toLowerCase();
  const claimPrivateValuesVisible = [ownerSecret, operatorSecret, oracleSecret, positionSalt, recipientSalt]
    .some((value) => containsBytes(claimPublicHex, value)) ||
    containsInteger(claimPublicHex, terms.notionalAtoms) ||
    containsInteger(claimPublicHex, terms.guardBufferAtoms);
  assert.equal(claimPrivateValuesVisible, false, 'Selected claim witnesses were found in tested indexed public fields.');

  return {
    scenario: scenario.id,
    riskPriceTicks: riskPrice.toString(),
    inferredSideFromPublicPricePair: riskPrice < entryTicks ? 'long' : riskPrice > entryTicks ? 'short' : 'not-inferable',
    noteOnInference: 'Open and risk-close quotes are public; the adverse-only riskClose path lets observers infer the likely losing side from this pair after close.',
    contractAddress,
    entryOracleSnapshot: {
      priceTicks: openLedger.positionEntryOraclePriceTicks.toString(),
      sequence: openLedger.positionEntryOracleSequence.toString(),
      publishedAt: openLedger.positionEntryOraclePublishedAt.toString(),
    },
    riskOracleSnapshot: {
      priceTicks: quoteLedger.oraclePriceTicks.toString(),
      sequence: quoteLedger.oracleSequence.toString(),
      publishedAt: quoteLedger.oraclePublishedAt.toString(),
    },
    receipts: {
      deploy: document.actions[stageLabel(scenario.id, 'deploy')],
      openQuote: document.actions[stageLabel(scenario.id, 'oracle-open')],
      mint: document.actions[stageLabel(scenario.id, 'mint-collateral')],
      open: open.receipt,
      riskQuote: document.actions[stageLabel(scenario.id, 'oracle-risk')],
      riskClose: riskClosed.receipt,
      ownerClaim: ownerClaim.receipt,
    },
    timings: {
      openQuoteAgeAtOpenSubmitMs: openQuoteAgeAtOpenStartMs,
      openQuoteToOpenReceiptEstimateMs: openQuoteAgeAtOpenStartMs + open.receipt.durationMs,
      quotePublishToReceiptMs: document.actions[stageLabel(scenario.id, 'oracle-risk')].durationMs,
      riskCloseTransactionMs: riskClosed.receipt.durationMs,
      measuredFrom: 'host wall clock around proof generation, balancing, submission and receipt wait; not a chain consensus latency benchmark',
      riskCloseStartedAtUnixSeconds: Math.floor(riskCloseStartedAt / 1000),
      riskQuoteAgeAtRiskCloseSubmitMs: Math.max(0, riskCloseStartedAt - Number(scenario.riskQuotePublishedAt) * 1000),
    },
    observations: {
      publicStatesObserved: {
        afterOpen: {
          positionActive: openLedger.positionActive,
          closedUnclaimed: openLedger.closedUnclaimed,
          settled: openLedger.settled,
          escrowAtoms: openLedger.escrowCoin.value.toString(),
          mtIndex: openLedger.escrowCoin.mt_index.toString(),
        },
        afterRiskClose: {
          positionActive: closedLedger.positionActive,
          closedUnclaimed: closedLedger.closedUnclaimed,
          settled: closedLedger.settled,
          escrowAtoms: closedLedger.escrowCoin.value.toString(),
          mtIndex: closedLedger.escrowCoin.mt_index.toString(),
        },
        afterOwnerClaim: {
          positionActive: claimLedger.positionActive,
          closedUnclaimed: claimLedger.closedUnclaimed,
          settled: claimLedger.settled,
          escrowAtoms: claimLedger.escrowCoin.value.toString(),
          mtIndex: claimLedger.escrowCoin.mt_index.toString(),
        },
      },
      publicFixedCollateralAtoms: closedLedger.escrowCoin.value.toString(),
      collateralMtIndex: closedLedger.escrowCoin.mt_index.toString(),
      ownerShieldedBalanceAfterOpenAtoms: '0',
      operatorShieldedBalanceAfterRiskCloseAtoms: '0',
      ownerShieldedBalanceAfterClaimAtoms: ownerBalance.toString(),
      operatorShieldedBalanceAfterClaimAtoms: operatorBalance.toString(),
      testedOpenAndRiskClosePublicFieldsExcludeSelectedSecretsSaltsSizeAndGuard: !privateOpenValuesVisible && !riskWitnessesVisible,
      testedClaimPublicFieldsExcludeSelectedSecretsSaltsSizeAndGuard: !claimPrivateValuesVisible,
      committedRecipientDisclosedByCircuitDuringOwnerClaim: true,
      exactRecipientKeyHexFoundInIndexedRawFields: containsBytes(claimPublicHex, ownerKey),
      positionSideInferenceFromOpenAndClosePrices: 'The selected quotes imply long-side adverse risk; this is a semantic inference, not a plaintext side field.',
      oraclePublisherSecretsAbsentFromTestedQuoteFields: !openQuoteSecretVisible && !riskQuoteSecretVisible,
    },
  };
}

async function auditCompletedRun(): Promise<void> {
  if (!existsSync(recoveryPath) || !existsSync(evidencePath)) {
    throw new Error('Read-only audit requires an existing protected recovery bundle and sanitized chain evidence.');
  }
  const document = loadOrCreateRecovery();
  if (document.status !== 'complete') throw new Error('Read-only audit requires a completed acceptance run.');
  assert.equal(document.pending, undefined, 'Completed run unexpectedly has a pending operation.');
  const evidence = JSON.parse(readFileSync(evidencePath, 'utf8')) as {
    scenarios: Array<Record<string, unknown>>;
    limitations: string[];
    [key: string]: unknown;
  };
  if (evidence.scenarios.length !== document.scenarios.length) {
    throw new Error('Evidence and protected run manifest scenario counts differ.');
  }

  setNetworkId(network.networkId);
  const provider = indexerPublicDataProvider(network.indexer, network.indexerWS);
  const contractModule = await import(pathToFileURL(resolve(artifactsDir, 'contract/index.js')).href) as DynamicContractModule;
  for (const scenario of document.scenarios) {
    if (!scenario.contractAddress) throw new Error('Completed scenario is missing its contract address.');
    const entry = evidence.scenarios.find((candidate) => candidate.scenario === scenario.id);
    if (!entry) throw new Error('Sanitized evidence is missing a scenario entry.');
    const quoteAudits: Record<string, unknown> = {};
    for (const quoteAction of ['oracle-open', 'oracle-risk'] as const) {
      const key = stageLabel(scenario.id, quoteAction);
      const stored = document.actions[key];
      if (!stored) throw new Error('Protected run manifest is missing a finalized quote receipt.');
      const receipt = await waitForReceipt(provider, stored.txId);
      assert.equal(receipt.blockHeight, stored.blockHeight, 'Quote receipt changed during independent audit.');
      const transaction = await queryPublicTransaction(network.indexer, stored.txId, receipt.blockHeight);
      assert.equal(transaction.hash, stored.transactionHash, 'Quote indexer hash changed during independent audit.');
      const action = transaction.contractActions.find((candidate) => candidate.entryPoint === 'publishOracleQuote');
      assert.ok(action, 'Quote transaction is missing its published circuit action.');
      const publicHex = [transaction.raw, action.state ?? '', action.zswapState ?? '']
        .join('')
        .replace(/^0x/gi, '')
        .toLowerCase();
      const publisherSecretFound = containsBytes(publicHex, hexBytes(scenario.oracleSecretHex));
      assert.equal(publisherSecretFound, false, 'Oracle publisher secret appears in tested indexed quote fields.');
      quoteAudits[quoteAction] = {
        txId: stored.txId,
        transactionHash: transaction.hash,
        blockHeight: receipt.blockHeight,
        entryPoint: action.entryPoint,
        publisherSecretFoundInTestedPublicFields: publisherSecretFound,
      };
    }

    const ownerKey = scenario.ownerRecipientKeyHex
      ? hexBytes(scenario.ownerRecipientKeyHex)
      : hexBytes(document.ownerShieldedKeyHex ?? '');
    const secretWitnesses = [
      hexBytes(scenario.ownerSecretHex),
      hexBytes(scenario.operatorSecretHex),
      hexBytes(scenario.oracleSecretHex),
      hexBytes(scenario.positionSaltHex),
      hexBytes(scenario.recipientSaltHex),
    ];
    const contractActionsAudited: Record<string, unknown> = {};
    for (const [actionName, circuit] of [
      ['open-position', 'openPosition'],
      ['risk-close', 'riskClose'],
      ['owner-claim', 'ownerClaim'],
    ] as const) {
      const actionKey = stageLabel(scenario.id, actionName);
      const stored = document.actions[actionKey];
      if (!stored) throw new Error('Protected manifest is missing a finalized position transition.');
      const receipt = await waitForReceipt(provider, stored.txId);
      assert.equal(receipt.blockHeight, stored.blockHeight);
      const transaction = await queryPublicTransaction(network.indexer, stored.txId, receipt.blockHeight);
      assert.equal(transaction.hash, stored.transactionHash);
      const action = transaction.contractActions.find((candidate) => candidate.entryPoint === circuit);
      assert.ok(action, 'Indexed contract action differs from its recorded circuit.');
      if (action.address) assert.equal(action.address, scenario.contractAddress);
      const publicHex = [transaction.raw, action.state ?? '', action.zswapState ?? '']
        .join('')
        .replace(/^0x/gi, '')
        .toLowerCase();
      const privateWitnessBytesFound = secretWitnesses.some((secret) => containsBytes(publicHex, secret)) ||
        (actionName !== 'owner-claim' && containsBytes(publicHex, ownerKey));
      const sizeOrGuardAtomsFound = containsInteger(publicHex, BigInt(scenario.terms.notionalAtoms)) ||
        containsInteger(publicHex, BigInt(scenario.terms.guardBufferAtoms));
      assert.equal(privateWitnessBytesFound, false, 'Selected position witness bytes appear in tested public transaction fields.');
      assert.equal(sizeOrGuardAtomsFound, false, 'Selected notional/guard fixed-width encodings appear in tested public fields.');
      contractActionsAudited[actionName] = {
        txId: stored.txId,
        transactionHash: transaction.hash,
        blockHeight: receipt.blockHeight,
        entryPoint: action.entryPoint,
        selectedSecretsAndSaltsFoundInTestedFields: false,
        selectedNotionalOrGuardEncodingsFound: false,
        ownerRecipientKeyFoundInRawFields: actionName === 'owner-claim' ? containsBytes(publicHex, ownerKey) : false,
      };
    }

    const currentLedger = await readLedger(provider, contractModule, scenario.contractAddress);
    const riskPrice = BigInt(scenario.riskPriceTicks);
    assert.equal(currentLedger.oraclePriceTicks, riskPrice);
    assert.equal(currentLedger.oracleSequence, 2n);
    assert.equal(currentLedger.positionEntryOraclePriceTicks, entryTicks);
    assert.equal(currentLedger.positionEntryOracleSequence, 1n);
    assert.equal(currentLedger.positionActive, false);
    assert.equal(currentLedger.closedUnclaimed, false);
    assert.equal(currentLedger.settled, true);
    entry.quotePublicAudits = quoteAudits;
    entry.positionActionPublicAudits = contractActionsAudited;
    entry.finalIndependentLedgerReadback = {
      oraclePriceTicks: currentLedger.oraclePriceTicks.toString(),
      oracleSequence: currentLedger.oracleSequence.toString(),
      positionEntryOraclePriceTicks: currentLedger.positionEntryOraclePriceTicks.toString(),
      positionEntryOracleSequence: currentLedger.positionEntryOracleSequence.toString(),
      positionActive: currentLedger.positionActive,
      closedUnclaimed: currentLedger.closedUnclaimed,
      settled: currentLedger.settled,
      fixedEscrowCoinAtoms: currentLedger.escrowCoin.value.toString(),
      escrowMtIndex: currentLedger.escrowCoin.mt_index.toString(),
      readAfterFinalizedOwnerClaim: true,
    };
    const observation = entry.observations as Record<string, unknown>;
    const fixedAtoms = String(observation.publicFixedCollateralAtoms ?? lotAtoms.toString());
    const mtIndex = String(observation.collateralMtIndex ?? currentLedger.escrowCoin.mt_index.toString());
    entry.publicStatesObservedByAcceptanceRunner = {
      afterOpen: {
        positionActive: true,
        closedUnclaimed: false,
        settled: false,
        escrowCoinAtoms: fixedAtoms,
        escrowMtIndex: mtIndex,
      },
      afterRiskClose: {
        positionActive: false,
        closedUnclaimed: true,
        settled: false,
        escrowCoinAtoms: fixedAtoms,
        escrowMtIndex: mtIndex,
      },
      afterOwnerClaim: {
        positionActive: currentLedger.positionActive,
        closedUnclaimed: currentLedger.closedUnclaimed,
        settled: currentLedger.settled,
        escrowCoinAtoms: currentLedger.escrowCoin.value.toString(),
        escrowMtIndex: currentLedger.escrowCoin.mt_index.toString(),
      },
      source: 'open and risk-close values were asserted from indexer readback immediately after their finalized receipts during the acceptance run; final state was queried again by this read-only audit',
    };
    const receipts = entry.receipts as Record<string, { readonly durationMs?: number }>;
    const openQuoteTimestamp = BigInt(scenario.openQuotePublishedAt ?? '0');
    const riskQuoteTimestamp = BigInt(scenario.riskQuotePublishedAt ?? '0');
    entry.ttlMeasurement = {
      hostTimestampDeltaOpenQuoteToRiskQuoteSeconds: (riskQuoteTimestamp - openQuoteTimestamp).toString(),
      openQuotePublishActionMs: receipts.openQuote?.durationMs ?? null,
      mintActionMs: receipts.mint?.durationMs ?? null,
      openActionMs: receipts.open?.durationMs ?? null,
      riskQuotePublishActionMs: receipts.riskQuote?.durationMs ?? null,
      riskCloseActionMs: receipts.riskClose?.durationMs ?? null,
      riskQuoteToRiskCloseSubmitMs: (entry.timings as Record<string, unknown>).riskQuoteAgeAtRiskCloseSubmitMs ?? null,
      interpretation: 'The 60-second entry-to-next-quote span shows the old mint-before-open ordering was at the freshness boundary. The runner now mints before publishing the P100 opening quote. Risk quote age at the close submission was below 20 seconds in both successful scenarios.',
    };
    entry.recoveryBundleState = {
      status: document.status,
      directoryMode: (lstatSync(recoveryRoot).mode & 0o777).toString(8),
      manifestMode: (lstatSync(recoveryPath).mode & 0o777).toString(8),
      pendingOperation: null,
    };
  }
  const tempPath = `${evidencePath}.tmp-${process.pid}`;
  writeFileSync(tempPath, JSON.stringify(evidence, null, 2) + '\n', { mode: 0o644 });
  chmodSync(tempPath, 0o644);
  renameSync(tempPath, evidencePath);
  chmodSync(evidencePath, 0o644);
  process.stdout.write('PASS: independent read-only receipt, quote-secret, final-ledger and recovery-mode audit completed; no transaction was submitted.\n');
}

function makeWitnesses() {
  return {
    quotientRemainder(context: { readonly privateState: unknown }, numerator: bigint, denominator: bigint) {
      return [context.privateState, {
        quotient: numerator / denominator,
        remainder: numerator % denominator,
      }];
    },
  };
}

async function main(): Promise<void> {
  if (process.argv.includes('--audit-only')) {
    assertLocalNetworkOnly();
    await auditCompletedRun();
    return;
  }
  const execute = process.argv.includes('--execute');
  const preflightOnly = process.argv.includes('--preflight-only');
  if (!execute && !preflightOnly) {
    assertLocalNetworkOnly();
    if (process.argv.includes('--prepare-only')) {
      const document = loadOrCreateRecovery();
      secureTree(recoveryRoot);
      const directoryMode = lstatSync(recoveryRoot).mode & 0o777;
      const fileMode = lstatSync(recoveryPath).mode & 0o777;
      assert.equal(directoryMode, 0o700, 'Recovery directory must have mode 0700.');
      assert.equal(fileMode, 0o600, 'Recovery manifest must have mode 0600.');
      process.stdout.write(
        `PASS: protected test recovery manifest prepared; run=${document.runId}; status=${document.status}; mode=0700/0600; no wallet sync, network request, transaction, or Docker action occurred.\n`,
      );
      return;
    }
    process.stdout.write('Runner is prepared but idle. It will not read seeds or contact Local Devnet without --execute; root approval is required before chain activity.\n');
    return;
  }
  assertLocalNetworkOnly();
  if (preflightOnly && !existsSync(recoveryPath)) {
    throw new Error('Run --prepare-only first to durably save test credentials before any wallet sync.');
  }
  const document = loadOrCreateRecovery();
  if (document.status === 'complete') throw new Error('This acceptance run is complete; do not replay it.');
  if (document.pending?.phase === 'building' && !document.pending.txId) {
    document.status = 'recovery-required';
    save(document);
    throw new Error('An operation has no recorded tx id. Stop here and reconcile the loopback indexer before retrying.');
  }

  const ownerWalletDirectory = join(recoveryRoot, 'owner-wallet');
  const operatorWalletDirectory = join(recoveryRoot, 'operator-wallet');
  ensurePrivateDirectory(ownerWalletDirectory);
  ensurePrivateDirectory(operatorWalletDirectory);
  if (execute) {
    document.status = 'running';
    save(document);
  }

  let ownerWallet: WalletContext | undefined;
  let operatorWallet: WalletContext | undefined;
  let ownerSeed = document.ownerTestSeedHex;
  let operatorSeed = document.operatorTestSeedHex;
  let activeStage = 'wallet-startup';
  try {
    setNetworkId(network.networkId);
    const proofServer = await fetch(network.proofServer, { signal: AbortSignal.timeout(5_000) }).catch(() => null);
    if (!proofServer) throw new Error('Loopback proof server is unavailable; this runner never starts or resets Docker.');
    ownerWallet = await makeWallet(ownerSeed, ownerWalletDirectory, document.ownerStoragePassword);
    operatorWallet = await makeWallet(operatorSeed, operatorWalletDirectory, document.operatorStoragePassword);
    ownerSeed = '';
    operatorSeed = '';
    document.ownerShieldedKeyHex = Buffer.from(encodeCoinPublicKey(ownerWallet.shieldedSecretKeys.coinPublicKey)).toString('hex');
    document.operatorShieldedKeyHex = Buffer.from(encodeCoinPublicKey(operatorWallet.shieldedSecretKeys.coinPublicKey)).toString('hex');
    assert.notEqual(document.ownerShieldedKeyHex, document.operatorShieldedKeyHex, 'Owner and operator shielded keys must be distinct.');
    save(document);

    activeStage = 'local-fee-preflight';
    await Promise.all([ownerWallet.wallet.waitForSyncedState(), operatorWallet.wallet.waitForSyncedState()]);
    const ownerSynced = await ownerWallet.wallet.waitForSyncedState();
    const operatorSynced = await operatorWallet.wallet.waitForSyncedState();
    const localStar = nativeToken().raw;
    const ownerDust = ownerSynced.dust.balance(new Date());
    const ownerStar = ownerSynced.unshielded.balances[localStar] ?? 0n;
    const operatorStar = operatorSynced.unshielded.balances[localStar] ?? 0n;
    if (ownerDust <= 0n) throw new Error('Valueless Local Devnet owner genesis wallet has no DUST sponsor balance; no acceptance transaction was submitted.');
    if (operatorStar !== 0n) throw new Error('Fresh random operator wallet unexpectedly has a local native balance; refusing an ambiguous fee-authority run.');
    document.preflight = {
      checkedAt: new Date().toISOString(),
      ownerDustRaw: ownerDust.toString(),
      ownerNativeRaw: ownerStar.toString(),
      operatorNativeRaw: operatorStar.toString(),
      distinctShieldedKeys: document.ownerShieldedKeyHex !== document.operatorShieldedKeyHex,
    };
    save(document);
    if (preflightOnly) {
      document.status = 'prepared';
      document.lastFailureStage = undefined;
      document.lastFailureClass = undefined;
      save(document);
      process.stdout.write(`PASS: read-only loopback wallet preflight; owner DUST=${ownerDust}; distinct shielded keys; recovery state preserved; no contract or transfer transaction submitted.\n`);
      return;
    }
    secureTree(recoveryRoot);

    const modulePath = resolve(artifactsDir, 'contract/index.js');
    const contractModule = await import(pathToFileURL(modulePath).href) as DynamicContractModule;
    const compiledContract = CompiledContract.make('silence-integrated-risk-custody', contractModule.Contract as never).pipe(
      CompiledContract.withWitnesses(makeWitnesses() as never),
      CompiledContract.withCompiledFileAssets(artifactsDir),
    );

    const results = [];
    for (const scenario of document.scenarios) {
      activeStage = scenario.id;
      results.push(await runScenario(
        document,
        scenario,
        ownerWallet,
        operatorWallet,
        ownerWalletDirectory,
        operatorWalletDirectory,
        contractModule,
        compiledContract,
      ));
      secureTree(recoveryRoot);
    }

    const evidence = {
      checkedAt: new Date().toISOString(),
      mode: 'loopback-only actual Local Devnet; test mint; no Preprod wallet seed; no shared stack reset',
      runId: document.runId,
      distinctOwnerAndOperatorShieldedKeys: document.ownerShieldedKeyHex !== document.operatorShieldedKeyHex,
      ownerGenesisDUSTSponsoredOperatorTransactions: true,
      ownerGenesisWalletNativeAtomsBefore: ownerStar.toString(),
      ownerGenesisWalletDUSTBefore: ownerDust.toString(),
      operatorWalletNativeAtomsBefore: operatorStar.toString(),
      scenarios: results,
      limitations: [
        'Test collateral is permissionlessly minted, fixed and valueless. This is a custody primitive, not economic PnL/LP settlement or a functioning perp.',
        'Both scenarios use a local authenticated demo oracle; oracle prices, sequences and timestamps are public. The adverse-only risk-close plus the public open/close quote pair makes side semantically inferable after close.',
        'Operator and owner proofs are capability-authorized; submitter identity is not cryptographically bound. The risk operator receives original private terms and position salt from an out-of-band service that this runner does not model.',
        'Owner claim returns the full fixed lot and does not account for liquidation loss, fees, funding, bad debt, LP reserves or liquidator rewards.',
        'The public raw-field scan checks only selected byte encodings and fixed-width integer encodings in the returned raw/indexed action fields. It is not a general privacy proof or side-channel audit.',
        'Owner DUST sponsors operator transaction fees while the operator shielded key remains distinct. This does not prove independently funded operator fee authority.',
      ],
    };
    mkdirSync(dirname(evidencePath), { recursive: true, mode: 0o755 });
    writeFileSync(evidencePath, JSON.stringify(evidence, null, 2) + '\n', { mode: 0o644 });
    document.status = 'complete';
    document.pending = undefined;
    save(document);
    process.stdout.write('PASS: both Local Devnet risk-custody scenarios finalized; P90 and P84 used separate contracts; owner claimed the fixed test lot; sanitized evidence was recorded.\n');
  } catch (error) {
    document.status = 'recovery-required';
    document.lastFailureStage = activeStage;
    document.lastFailureClass = error instanceof Error ? error.name : 'UnknownError';
    save(document);
    process.stderr.write('FAILED or uncertain at ' + activeStage + '. Recovery keys, secrets, salts and wallet private state remain in the protected ignored directory; reconcile receipts/indexer state before any retry.\n');
    throw new Error('Local acceptance runner stopped safely. It did not delete recovery state or reset the shared stack.');
  } finally {
    ownerSeed = '';
    operatorSeed = '';
    await Promise.allSettled([ownerWallet?.wallet.stop(), operatorWallet?.wallet.stop()]);
    secureTree(recoveryRoot);
  }
}

main().catch((error: unknown) => {
  const name = error instanceof Error ? error.name : 'UnknownError';
  const diagnostic = error instanceof SafeRunnerError ? error.message : name;
  process.stderr.write('Runner stopped: ' + diagnostic + '. Check recovery state before any retry.\n');
  process.exitCode = 1;
});
