import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
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
  sampleSigningKey,
} from '@midnight-ntwrk/midnight-js-protocol/compact-runtime';
import * as ledger from '@midnight-ntwrk/midnight-js-protocol/ledger';
import {
  DustWallet,
  HDWallet,
  NoOpTransactionHistoryStorage,
  PublicKey,
  Roles,
  ShieldedWallet,
  UnshieldedWallet,
  WalletFacade,
  createKeystore,
} from '@midnight-ntwrk/wallet-sdk';

import { localTestNetwork } from '../../../src/chain/client.js';
import { createSilenceWallet } from '../../../src/chain/wallet.js';

Reflect.set(globalThis as object, 'WebSocket', WebSocket);

const spikeDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const artifactsDir = resolve(spikeDir, 'generated/lp_reserve');
const evidencePath = resolve(spikeDir, 'docs/evidence/local-chain.json');
const recoveryRoot = resolve(spikeDir, '.local/recovery');
const recoveryPath = join(recoveryRoot, 'manifest.json');
const ownerWalletDir = join(recoveryRoot, 'owner-wallet');
const lpWalletDir = join(recoveryRoot, 'lp-wallet');
const network = {
  networkId: 'undeployed' as const,
  indexer: process.env.SILENCE_INDEXER_URL ?? 'http://127.0.0.1:28088/api/v4/graphql',
  indexerWS: process.env.SILENCE_INDEXER_WS_URL ?? 'ws://127.0.0.1:28088/api/v4/graphql/ws',
  node: process.env.SILENCE_NODE_URL ?? 'ws://127.0.0.1:29944',
  proofServer: process.env.SILENCE_PROOF_SERVER_URL ?? 'http://127.0.0.1:26300',
};
const TEST_TOKEN_ATOMS = 1000n;
const RESERVE_ATOMS = 500n;
const LOSS_PAYOUT_ATOMS = 800n;
const PROFIT_PAYOUT_ATOMS = 1200n;
// Fourteen chain transactions at the wallet's 0.3-DUST configured overhead,
// with a modest buffer. Refuse before deploying if the sponsor cannot cover
// the full two-case run; never discover fee exhaustion after partial execution.
const REQUIRED_DUST_PRECHECK = 5_000_000_000_000_000n;

type RecoveryManifest = {
  readonly version: 1;
  readonly createdAt: string;
  readonly network: 'undeployed';
  readonly testOnly: true;
  status: 'pending' | 'uncertain';
  phase: string;
  submissionStarted: boolean;
  readonly credentials: {
    readonly ownerSeedHex: string;
    readonly lpSeedHex: string;
    readonly privateStoragePassword: string;
    readonly ownerSecretHex: string;
    readonly lpSecretHex: string;
    readonly ownerRecipientSaltHex: string;
    readonly lpRecipientSaltHex: string;
  };
  readonly contractAddresses: Record<string, string>;
  readonly receipts: Record<string, Receipt>;
  pendingTransaction?: { readonly phase: string; readonly contractAddress?: string; readonly circuit?: string; txId?: string };
};

let recovery: RecoveryManifest | null = null;
let activeStage = 'startup';
let transactionSubmissionStarted = false;
let safeCleanup = false;
let priorUmask: number | undefined;
let privateStoragePassword = '';

type Receipt = { readonly txId: string; readonly status: 'SucceedEntirely'; readonly blockHeight: number };
type WalletContext = Awaited<ReturnType<typeof createSilenceWallet>> & {
  readonly unshieldedKeystore: ReturnType<typeof createKeystore>;
};
type DynamicModule = {
  readonly Contract: new (...args: unknown[]) => unknown;
  readonly ledger: (state: unknown) => {
    readonly traderCoin: { readonly value: bigint; readonly mt_index: bigint };
    readonly reserveCoin: { readonly value: bigint; readonly mt_index: bigint; readonly nonce: Uint8Array };
    readonly lpLossCoin: { readonly value: bigint; readonly mt_index: bigint };
    readonly reserveFunded: boolean;
    readonly positionActive: boolean;
    readonly lpLossClaimable: boolean;
    readonly settled: boolean;
  };
};

function assertLocalNetworkOnly(): void {
  const endpoints = [network.indexer, network.indexerWS, network.node, network.proofServer];
  if (endpoints.some((endpoint) => !['127.0.0.1', 'localhost'].includes(new URL(endpoint).hostname))) {
    throw new Error('LP reserve chain acceptance runner only permits loopback Local Devnet endpoints.');
  }
}

function safeDiagnostic(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/[0-9a-f]{32,}/gi, '[hex redacted]')
    .replace(/\s+/g, ' ')
    .slice(0, 500) || 'Unknown Local Devnet error.';
}

function bytesToHex(value: Uint8Array): string {
  return Buffer.from(value).toString('hex');
}

function saveRecovery(): void {
  if (!recovery) return;
  const temporary = join(recoveryRoot, 'manifest.tmp-' + process.pid);
  writeFileSync(temporary, JSON.stringify(recovery, null, 2) + '\n', { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, recoveryPath);
  chmodSync(recoveryPath, 0o600);
  chmodSync(recoveryRoot, 0o700);
  assert.equal(statSync(recoveryRoot).mode & 0o777, 0o700, 'Recovery directory must be owner-only.');
  assert.equal(statSync(recoveryPath).mode & 0o777, 0o600, 'Recovery manifest must be owner-readable/writable only.');
}

function setStage(stage: string): void {
  activeStage = stage;
  if (recovery) {
    recovery.phase = stage;
    saveRecovery();
  }
}

function beginSubmission(stage: string, details: { contractAddress?: string; circuit?: string } = {}): void {
  activeStage = stage;
  transactionSubmissionStarted = true;
  if (!recovery) throw new Error('Protected recovery manifest is missing before transaction submission.');
  recovery.status = 'pending';
  recovery.submissionStarted = true;
  recovery.phase = stage;
  recovery.pendingTransaction = { phase: stage, ...details };
  saveRecovery();
}

function recordReceipt(label: string, finalized: Receipt): void {
  if (!recovery) throw new Error('Protected recovery manifest is missing after transaction finality.');
  recovery.receipts[label] = finalized;
  recovery.pendingTransaction = undefined;
  activeStage = label + ':finalized';
  recovery.phase = activeStage;
  saveRecovery();
}

function initializeRecovery(ownerSeed: string, lpSeed: string): void {
  if (existsSync(recoveryPath)) {
    throw new Error('A pending LP recovery file already exists at ' + recoveryPath + '; inspect it before any new chain run.');
  }
  if (existsSync(recoveryRoot) && readdirSync(recoveryRoot).length > 0) {
    throw new Error('Unreviewed LP recovery state already exists at ' + recoveryRoot + '; refusing to overwrite it.');
  }

  priorUmask = process.umask(0o077);
  mkdirSync(dirname(recoveryRoot), { recursive: true, mode: 0o700 });
  chmodSync(dirname(recoveryRoot), 0o700);
  mkdirSync(recoveryRoot, { recursive: true, mode: 0o700 });
  chmodSync(recoveryRoot, 0o700);
  assert.equal(statSync(dirname(recoveryRoot)).mode & 0o777, 0o700, 'Local recovery parent must be owner-only.');
  assert.equal(statSync(recoveryRoot).mode & 0o777, 0o700, 'Recovery directory must be owner-only.');
  privateStoragePassword = randomBytes(32).toString('hex');
  recovery = {
    version: 1,
    createdAt: new Date().toISOString(),
    network: 'undeployed',
    testOnly: true,
    status: 'pending',
    phase: 'preflight:wallet-start',
    submissionStarted: false,
    credentials: {
      ownerSeedHex: ownerSeed,
      lpSeedHex: lpSeed,
      privateStoragePassword,
      ownerSecretHex: bytesToHex(randomBytes(32)),
      lpSecretHex: bytesToHex(randomBytes(32)),
      ownerRecipientSaltHex: bytesToHex(randomBytes(32)),
      lpRecipientSaltHex: bytesToHex(randomBytes(32)),
    },
    contractAddresses: {},
    receipts: {},
  };
  saveRecovery();
}

function receipt(data: { readonly txId: string; readonly status: string; readonly blockHeight?: number }): Receipt {
  assert.equal(data.status, 'SucceedEntirely', 'Transaction ' + data.txId + ' did not succeed: ' + data.status);
  assert.equal(typeof data.blockHeight, 'number', 'Finalized transaction has no block height.');
  return { txId: data.txId, status: 'SucceedEntirely', blockHeight: data.blockHeight! };
}

async function waitForReceipt(provider: ReturnType<typeof indexerPublicDataProvider>, txId: string): Promise<Receipt> {
  return receipt(await provider.watchForTxData(txId));
}

async function walletContext(seedHex: string, walletDir: string): Promise<WalletContext> {
  const config = {
    ...localTestNetwork(privateStoragePassword),
    artifactsDir,
    privateStateDir: join(walletDir, 'private-state'),
  };
  const context = await createSilenceWallet(seedHex, config);
  const hdWallet = HDWallet.fromSeed(Buffer.from(seedHex, 'hex'));
  if (hdWallet.type !== 'seedOk') throw new Error('Local test wallet seed was rejected.');
  const derivation = hdWallet.hdWallet.selectAccount(0)
    .selectRoles([Roles.Zswap, Roles.NightExternal, Roles.Dust])
    .deriveKeysAt(0);
  if (derivation.type !== 'keysDerived') {
    hdWallet.hdWallet.clear();
    throw new Error('Local test wallet role keys could not be derived.');
  }
  const keystore = createKeystore(derivation.keys[Roles.NightExternal], config.networkId);
  hdWallet.hdWallet.clear();
  if (keystore.getBech32Address().toString() !== context.accountId) {
    await context.stop();
    throw new Error('Local test wallet address did not match the configured SDK wallet.');
  }
  return { ...context, unshieldedKeystore: keystore };
}

async function lpShieldedWallet(seedHex: string, walletDir: string, feeSponsor: WalletContext): Promise<WalletContext> {
  const config = {
    ...localTestNetwork(privateStoragePassword),
    artifactsDir,
    privateStateDir: join(walletDir, 'private-state'),
  };
  const hdWallet = HDWallet.fromSeed(Buffer.from(seedHex, 'hex'));
  if (hdWallet.type !== 'seedOk') throw new Error('LP shielded-key seed was rejected.');
  const derivation = hdWallet.hdWallet.selectAccount(0)
    .selectRoles([Roles.Zswap])
    .deriveKeysAt(0);
  if (derivation.type !== 'keysDerived') {
    hdWallet.hdWallet.clear();
    throw new Error('LP shielded role key could not be derived.');
  }
  const shieldedSecretKeys = ledger.ZswapSecretKeys.fromSeed(derivation.keys[Roles.Zswap]);
  hdWallet.hdWallet.clear();

  const dustSecretKey = feeSponsor.dustSecretKey;
  const configuration = {
    networkId: config.networkId,
    indexerClientConnection: {
      indexerHttpUrl: config.indexer,
      indexerWsUrl: config.indexerWS,
    },
    provingServerUrl: new URL(config.proofServer),
    relayURL: new URL(config.node.replace(/^http/, 'ws')),
    txHistoryStorage: new NoOpTransactionHistoryStorage(),
    costParameters: { additionalFeeOverhead: 300_000_000_000_000n, feeBlocksMargin: 5 },
  };
  const wallet = await WalletFacade.init({
    configuration,
    shielded: async (walletConfig) => ShieldedWallet(walletConfig).startWithSecretKeys(shieldedSecretKeys),
    unshielded: async (walletConfig) => UnshieldedWallet(walletConfig)
      .startWithPublicKey(PublicKey.fromKeyStore(feeSponsor.unshieldedKeystore)),
    dust: async (walletConfig) => DustWallet(walletConfig).startWithSecretKey(
      dustSecretKey,
      ledger.LedgerParameters.initialParameters().dust,
    ),
  });
  await wallet.start(shieldedSecretKeys, dustSecretKey);
  return {
    wallet,
    shieldedSecretKeys,
    dustSecretKey,
    accountId: feeSponsor.accountId,
    unshieldedKeystore: feeSponsor.unshieldedKeystore,
    stop: () => wallet.stop(),
  };
}

async function providers(wallet: WalletContext, walletDir: string) {
  const zkConfigProvider = new NodeZkConfigProvider(artifactsDir);
  const publicDataProvider = indexerPublicDataProvider(network.indexer, network.indexerWS);
  const walletProvider = {
    getCoinPublicKey: () => wallet.shieldedSecretKeys.coinPublicKey,
    getEncryptionPublicKey: () => wallet.shieldedSecretKeys.encryptionPublicKey,
    async balanceTx(tx: unknown, ttl?: Date) {
      const recipe = await wallet.wallet.balanceUnboundTransaction(
        tx as never,
        { shieldedSecretKeys: wallet.shieldedSecretKeys, dustSecretKey: wallet.dustSecretKey },
        { ttl: ttl ?? new Date(Date.now() + 30 * 60 * 1000) },
      );
      return wallet.wallet.finalizeRecipe(recipe);
    },
    submitTx: (tx: unknown) => wallet.wallet.submitTransaction(tx as never),
  };
  const providerSet = {
    privateStateProvider: levelPrivateStateProvider({
      accountId: wallet.accountId,
      midnightDbName: join(walletDir, 'midnight-level-db'),
      privateStateStoreName: 'silence-lp-reserve-private-state',
      signingKeyStoreName: 'silence-lp-reserve-signing-keys',
      privateStoragePasswordProvider: () => privateStoragePassword,
    }),
    publicDataProvider,
    zkConfigProvider,
    proofProvider: httpClientProofProvider(network.proofServer, zkConfigProvider),
    walletProvider,
    midnightProvider: walletProvider,
  } as const;
  return { providerSet, publicDataProvider, zkConfigProvider, walletProvider };
}

async function createContract(
  runtime: Awaited<ReturnType<typeof providers>>,
  compiled: unknown,
  networkDomain: Uint8Array,
  label: string,
): Promise<{ address: string; receipt: Receipt }> {
  const deployment = await createUnprovenDeployTx(
    { zkConfigProvider: runtime.zkConfigProvider, walletProvider: runtime.walletProvider } as never,
    {
      compiledContract: compiled as never,
      args: [networkDomain],
      signingKey: sampleSigningKey(),
      initialPrivateState: undefined,
    } as never,
  );
  const address = String(deployment.public.contractAddress);
  if (!recovery) throw new Error('Protected recovery manifest is missing before contract deployment.');
  recovery.contractAddresses[label] = address;
  beginSubmission(label + ':deploy-submit-in-flight', { contractAddress: address });
  const txId = await submitTxAsync(
    runtime.providerSet as never,
    { unprovenTx: deployment.private.unprovenTx } as never,
  );
  const finalReceipt = await waitForReceipt(runtime.publicDataProvider, txId);
  runtime.providerSet.privateStateProvider.setContractAddress(address as never);
  recordReceipt(label + ':deploy', finalReceipt);
  return { address, receipt: finalReceipt };
}

async function invoke(
  runtime: Awaited<ReturnType<typeof providers>>,
  compiled: unknown,
  address: string,
  circuit: string,
  args: readonly unknown[],
) {
  const label = activeStage;
  beginSubmission(label + ':submit-in-flight', { contractAddress: address, circuit });
  const options = createCallTxOptions(
    compiled as never,
    circuit as never,
    address as never,
    undefined,
    undefined,
    [...args] as never,
  );
  const submitted = await submitCallTxAsync(runtime.providerSet as never, options as never);
  if (recovery?.pendingTransaction) {
    recovery.pendingTransaction = { ...recovery.pendingTransaction, txId: submitted.txId };
    saveRecovery();
  }
  const finalized = await waitForReceipt(runtime.publicDataProvider, submitted.txId);
  recordReceipt(label, finalized);
  return {
    receipt: finalized,
    privateResult: (submitted.callTxData as { readonly private: { readonly result: unknown } }).private.result,
  };
}

async function readLedger(
  provider: ReturnType<typeof indexerPublicDataProvider>,
  contractModule: DynamicModule,
  address: string,
) {
  const state = await provider.queryContractState(address as never);
  assert.ok(state, 'Contract state is missing from Local Devnet indexer.');
  return contractModule.ledger((state as { readonly data?: unknown }).data ?? state);
}

async function shieldedBalance(wallet: WalletContext, color: string): Promise<bigint> {
  const state = await wallet.wallet.waitForSyncedState();
  return state.shielded.balances[color] ?? 0n;
}

async function main(): Promise<void> {
  assertLocalNetworkOnly();
  if (existsSync(recoveryPath)) {
    throw new Error('Pending or uncertain recovery material already exists at ' + recoveryPath + '; inspect and reconcile it before any new chain run.');
  }
  if (existsSync(recoveryRoot) && readdirSync(recoveryRoot).length > 0) {
    throw new Error('Unreviewed protected recovery directory already exists at ' + recoveryRoot + '; refusing to overwrite it.');
  }
  let ownerSeed = process.env.SILENCE_LOCAL_TEST_SEED?.trim() ?? '';
  delete process.env.SILENCE_LOCAL_TEST_SEED;
  if (!/^(?:[0-9a-fA-F]{2}){16,64}$/.test(ownerSeed)) {
    throw new Error('Set SILENCE_LOCAL_TEST_SEED to a funded, valueless Local Devnet test seed; this runner never reads .local wallet material.');
  }
  const proofHealth = await fetch(network.proofServer, { signal: AbortSignal.timeout(5000) }).catch(() => null);
  if (!proofHealth) throw new Error('Shared Local Devnet proof server is unavailable; this runner never starts or resets it.');

  setNetworkId(network.networkId);
  let lpSeed = randomBytes(32).toString('hex');
  initializeRecovery(ownerSeed, lpSeed);
  mkdirSync(ownerWalletDir, { recursive: true, mode: 0o700 });
  chmodSync(ownerWalletDir, 0o700);
  mkdirSync(lpWalletDir, { recursive: true, mode: 0o700 });
  chmodSync(lpWalletDir, 0o700);
  let owner: WalletContext | undefined;
  let lp: WalletContext | undefined;

  try {
    setStage('preflight:owner-wallet-start');
    owner = await walletContext(ownerSeed, ownerWalletDir);
    ownerSeed = '';
    setStage('preflight:lp-wallet-start');
    lp = await lpShieldedWallet(lpSeed, lpWalletDir, owner);
    lpSeed = '';
    setStage('preflight:wallet-sync');
    await Promise.all([owner.wallet.waitForSyncedState(), lp.wallet.waitForSyncedState()]);
    const ownerState = await owner.wallet.waitForSyncedState();
    const lpState = await lp.wallet.waitForSyncedState();
    const ownerDust = ownerState.dust.balance(new Date());
    const lpDust = lpState.dust.balance(new Date());
    if (ownerDust < REQUIRED_DUST_PRECHECK || lpDust < REQUIRED_DUST_PRECHECK) {
      throw new Error('The shared genesis fee sponsor lacks the full-run Local Devnet DUST preflight buffer; no test transaction was submitted.');
    }
    const ownerKey = encodeCoinPublicKey(owner.shieldedSecretKeys.coinPublicKey);
    const lpKey = encodeCoinPublicKey(lp.shieldedSecretKeys.coinPublicKey);
    assert.notDeepEqual(ownerKey, lpKey, 'Trader and LP must use independent shielded wallet keys.');
    assert.equal(owner.accountId, lp.accountId, 'The LP spike must use the declared shared genesis fee sponsor.');
    if (process.env.SILENCE_LP_RESERVE_PREFLIGHT_ONLY === '1') {
      process.stdout.write('PASS: loopback endpoints reachable; owner and LP shielded keys differ; both wallet contexts share the genesis DUST sponsor; full-run fee buffer is present; no transaction was submitted.\n');
      safeCleanup = true;
      return;
    }

    const modulePath = resolve(artifactsDir, 'contract/index.js');
    const contractModule = await import(pathToFileURL(modulePath).href) as DynamicModule;
    const compiled = CompiledContract.make('silence-lp-reserve-spike', contractModule.Contract as never).pipe(
      CompiledContract.withWitnesses({} as never),
      CompiledContract.withCompiledFileAssets(artifactsDir),
    );
    const ownerRuntime = await providers(owner, ownerWalletDir);
    const lpRuntime = await providers(lp, lpWalletDir);
    const networkDomain = createHash('sha256').update('SILENCE/LP-RESERVE/LOCAL-DEVNET/v1').digest();
    if (!recovery) throw new Error('Protected recovery manifest is missing after wallet preflight.');
    const ownerRecipient = {
      recipient: { bytes: ownerKey },
      salt: new Uint8Array(Buffer.from(recovery.credentials.ownerRecipientSaltHex, 'hex')),
    };
    const lpRecipient = {
      recipient: { bytes: lpKey },
      salt: new Uint8Array(Buffer.from(recovery.credentials.lpRecipientSaltHex, 'hex')),
    };
    const lpSecret = new Uint8Array(Buffer.from(recovery.credentials.lpSecretHex, 'hex'));
    const ownerSecret = new Uint8Array(Buffer.from(recovery.credentials.ownerSecretHex, 'hex'));
    const runReceipts: Record<string, unknown> = {};
    const tokenColor = { value: '' };

    const openFixture = async (label: string) => {
      setStage(label + ':deploy');
      const deployment = await createContract(ownerRuntime, compiled, networkDomain, label);
      runReceipts[label + 'Deploy'] = deployment.receipt;
      setStage(label + ':mint-reserve');
      const reserveMint = await invoke(lpRuntime, compiled, deployment.address, 'mintTestCoin', [RESERVE_ATOMS, randomBytes(32)]);
      runReceipts[label + 'ReserveMint'] = reserveMint.receipt;
      const reserveCoin = reserveMint.privateResult as { readonly color: Uint8Array; readonly nonce: Uint8Array; readonly value: bigint };
      assert.equal(reserveCoin.value, RESERVE_ATOMS);
      tokenColor.value = bytesToHex(reserveCoin.color);
      setStage(label + ':fund-reserve');
      const reserveFunded = await invoke(lpRuntime, compiled, deployment.address, 'fundReserve', [reserveCoin, lpSecret, lpRecipient]);
      runReceipts[label + 'ReserveFund'] = reserveFunded.receipt;
      const afterReserve = await readLedger(lpRuntime.publicDataProvider, contractModule, deployment.address);
      assert.equal(afterReserve.reserveFunded, true);
      assert.equal(afterReserve.reserveCoin.value, RESERVE_ATOMS);
      assert.ok(afterReserve.reserveCoin.mt_index > 0n, 'Funded LP coin must have a committed mt_index.');
      setStage(label + ':mint-trader');
      const traderMint = await invoke(ownerRuntime, compiled, deployment.address, 'mintTestCoin', [TEST_TOKEN_ATOMS, randomBytes(32)]);
      runReceipts[label + 'TraderMint'] = traderMint.receipt;
      const traderCoin = traderMint.privateResult as { readonly color: Uint8Array; readonly nonce: Uint8Array; readonly value: bigint };
      assert.equal(traderCoin.value, TEST_TOKEN_ATOMS);
      assert.equal(bytesToHex(traderCoin.color), tokenColor.value, 'Trader and LP coins must have identical token color.');
      setStage(label + ':open');
      const opened = await invoke(ownerRuntime, compiled, deployment.address, 'openPosition', [traderCoin, ownerSecret, ownerRecipient]);
      runReceipts[label + 'Open'] = opened.receipt;
      const afterOpen = await readLedger(ownerRuntime.publicDataProvider, contractModule, deployment.address);
      assert.equal(afterOpen.positionActive, true);
      assert.equal(afterOpen.traderCoin.value, TEST_TOKEN_ATOMS);
      assert.ok(afterOpen.traderCoin.mt_index > 0n, 'Trader coin must have a committed mt_index.');
      return { address: deployment.address, initialReserveIndex: afterReserve.reserveCoin.mt_index };
    };

    setStage('loss-case');
    const loss = await openFixture('loss');
    setStage('loss:owner-claim');
    const ownerClaimed = await invoke(ownerRuntime, compiled, loss.address, 'claim', [LOSS_PAYOUT_ATOMS, ownerSecret, ownerRecipient]);
    runReceipts.lossOwnerClaim = ownerClaimed.receipt;
    const lossState = await readLedger(ownerRuntime.publicDataProvider, contractModule, loss.address);
    assert.equal(lossState.settled, true);
    assert.equal(lossState.lpLossClaimable, true);
    assert.equal(lossState.lpLossCoin.value, TEST_TOKEN_ATOMS - LOSS_PAYOUT_ATOMS);
    await Promise.all([owner.wallet.waitForSyncedState(), lp.wallet.waitForSyncedState()]);
    assert.equal(await shieldedBalance(owner, tokenColor.value), LOSS_PAYOUT_ATOMS);
    assert.equal(await shieldedBalance(lp, tokenColor.value), 0n, 'Owner settlement must not pay the LP from an absent-wallet transaction.');

    setStage('loss:lp-claim');
    const lpClaimed = await invoke(lpRuntime, compiled, loss.address, 'claimLpLoss', [lpSecret, lpRecipient]);
    runReceipts.lossLpClaim = lpClaimed.receipt;
    await Promise.all([owner.wallet.waitForSyncedState(), lp.wallet.waitForSyncedState()]);
    const lossFinalState = await readLedger(lpRuntime.publicDataProvider, contractModule, loss.address);
    assert.equal(lossFinalState.lpLossClaimable, false);
    assert.equal(await shieldedBalance(lp, tokenColor.value), TEST_TOKEN_ATOMS - LOSS_PAYOUT_ATOMS,
      'The separate LP wallet must read back and receive the committed loss coin.');

    setStage('profit-case');
    const profit = await openFixture('profit');
    setStage('profit:owner-claim');
    const ownerProfit = await invoke(ownerRuntime, compiled, profit.address, 'claim', [PROFIT_PAYOUT_ATOMS, ownerSecret, ownerRecipient]);
    runReceipts.profitOwnerClaim = ownerProfit.receipt;
    const profitState = await readLedger(ownerRuntime.publicDataProvider, contractModule, profit.address);
    assert.equal(profitState.settled, true);
    assert.equal(profitState.reserveFunded, true);
    assert.equal(profitState.reserveCoin.value, RESERVE_ATOMS - (PROFIT_PAYOUT_ATOMS - TEST_TOKEN_ATOMS));
    assert.ok(profitState.reserveCoin.mt_index > 0n, 'Partial reserve change must have an indexed commitment.');
    assert.notEqual(profitState.reserveCoin.mt_index, profit.initialReserveIndex,
      'Partial reserve change must use a new mt_index, not the spent input index.');
    await Promise.all([owner.wallet.waitForSyncedState(), lp.wallet.waitForSyncedState()]);
    assert.equal(await shieldedBalance(owner, tokenColor.value), LOSS_PAYOUT_ATOMS + PROFIT_PAYOUT_ATOMS);
    const lpBalanceBeforeRemainder = await shieldedBalance(lp, tokenColor.value);

    setStage('profit:lp-spend-reserve-change');
    const lpSpentRemainder = await invoke(lpRuntime, compiled, profit.address, 'withdrawReserveRemainder', [lpSecret, lpRecipient]);
    runReceipts.profitReserveRemainderSpend = lpSpentRemainder.receipt;
    await lp.wallet.waitForSyncedState();
    const finalProfitState = await readLedger(lpRuntime.publicDataProvider, contractModule, profit.address);
    const lpBalanceAfterRemainder = await shieldedBalance(lp, tokenColor.value);
    assert.equal(finalProfitState.reserveFunded, false);
    assert.equal(lpBalanceAfterRemainder - lpBalanceBeforeRemainder, RESERVE_ATOMS - (PROFIT_PAYOUT_ATOMS - TEST_TOKEN_ATOMS),
      'LP wallet must receive the exact 300-unit change and prove it was spendable in a later transaction.');

    const evidence = {
      checkedAt: new Date().toISOString(),
      mode: 'actual-shared-local-devnet-two-wallets',
      contractAddresses: { loss: loss.address, profit: profit.address },
      walletSeparation: {
        traderAndLpShieldedKeysDiffer: !Buffer.from(ownerKey).equals(Buffer.from(lpKey)),
        lpClaimUsesLpWalletProvider: true,
        sharedGenesisDustFeeSponsor: true,
        note: 'LP shielded key is independent, but the trader genesis account sponsors Local Devnet DUST fees; this is partial wallet independence, not a fully separate account test.',
      },
      receipts: runReceipts,
      observations: {
        testTokenColor: tokenColor.value,
        reserveFixedUnits: RESERVE_ATOMS.toString(),
        traderFixedUnits: TEST_TOKEN_ATOMS.toString(),
        lossPayoutUnits: LOSS_PAYOUT_ATOMS.toString(),
        lpLossCoinAtTraderCloseUnits: lossState.lpLossCoin.value.toString(),
        traderShieldedAfterLossCloseUnits: LOSS_PAYOUT_ATOMS.toString(),
        lpShieldedBeforeSeparateLossClaimUnits: '0',
        lpShieldedAfterSeparateLossClaimUnits: (TEST_TOKEN_ATOMS - LOSS_PAYOUT_ATOMS).toString(),
        profitPayoutUnits: PROFIT_PAYOUT_ATOMS.toString(),
        lpReserveInputMtIndex: profit.initialReserveIndex.toString(),
        lpReserveChangeUnits: profitState.reserveCoin.value.toString(),
        lpReserveChangeMtIndex: profitState.reserveCoin.mt_index.toString(),
        lpShieldedBalanceBeforeRemainderSpendUnits: lpBalanceBeforeRemainder.toString(),
        lpShieldedBalanceAfterRemainderSpendUnits: lpBalanceAfterRemainder.toString(),
        laterSpendDeltaUnits: (lpBalanceAfterRemainder - lpBalanceBeforeRemainder).toString(),
      },
      limitations: [
        'This is a valueless Local Devnet Compact accounting spike; it is not Preprod or production evidence.',
        'Payout is a public caller-supplied test input. No oracle, PnL, market fairness, reserve-liability model, or reusable LP pool is implemented.',
        'The test mints token freely inside the spike. No real collateral or production authorization is represented.',
        'The chain run verifies a separately submitted LP wallet claim and one later spend of a committed reserve remainder, not system-wide solvency.',
      ],
    };
    mkdirSync(dirname(evidencePath), { recursive: true });
    writeFileSync(evidencePath, JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 });
    process.stdout.write(
      'PASS: loss LP claim received by separate wallet; 300-unit post-change reserve coin finalized, indexed, spent later, and read back by LP wallet. Local receipts: ' +
      Object.values(runReceipts).map((item) => (item as Receipt).txId).join(', ') + '\n',
    );
    setStage('acceptance-complete');
    safeCleanup = true;
  } finally {
    ownerSeed = '';
    lpSeed = '';
    await Promise.allSettled([owner?.wallet.stop(), lp?.wallet.stop()]);
    if (safeCleanup || !transactionSubmissionStarted) {
      rmSync(recoveryRoot, { recursive: true, force: true });
    } else if (recovery) {
      recovery.status = 'uncertain';
      recovery.phase = activeStage;
      saveRecovery();
      process.stderr.write('RECOVERY RETAINED at ' + recoveryRoot + '; test-only seeds, claim witnesses, and private state are protected by 0700/0600 permissions. Do not rerun until indexer receipts and contract state are reconciled.\n');
    }
    if (priorUmask !== undefined) process.umask(priorUmask);
  }
}

main().catch((error) => {
  process.stderr.write('FAIL stage=' + activeStage + ': ' + safeDiagnostic(error) + '\n');
  if (transactionSubmissionStarted) {
    process.stderr.write('Chain state may exist. Inspect the protected recovery record at ' + recoveryRoot + ' before any further action.\n');
  }
  process.exitCode = 1;
});
